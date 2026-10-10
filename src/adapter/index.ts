/**
 * 适配器本体：把本插件声明的路由交给宿主的 LLM 接缝。
 *
 * 与官方 `llm-pi-ai` 适配器相比，这里刻意窄：本插件的路由来自一次刷新（发现）而不是一份
 * 可编辑的 provider 目录，因此不需要 `Models` 集合、目录条目解析与逐 provider 的 auth 解析；
 * 三种协议各自一个 `ProviderStreams`，模型描述符在快照里造好，一次请求就是「选模型 → 拼头 →
 * 转换历史 → 交给 pi-ai → 把事件翻回块」。
 *
 * **快照**是这里唯一微妙的地方。刷新会换掉整份路由数组，而一次请求在 `prepareCall` 与真正的
 * `stream` 之间可能跨越一次刷新：若两次各读一次当前路由，就可能把这一代的模型容量配上下一代
 * 的端点。因此 `prepareCall` 在**任何 await 之前**抓一份快照，并把派发闭包绑在它上面；
 * `stream` 直接调用时也只读一次。
 *
 * @module dsh-aperture/adapter
 */

import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  attributionHeaders,
  contentHasImage,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { normalizeContext, type Api, type Model as PiModel } from '@earendil-works/pi-ai';
import type { PlannedRoute, ProviderModel, ProviderRoute } from '../plan.ts';
import type { RuntimeLogger } from '../runtime.ts';
import { toPiContext } from './context.ts';
import { buildModel, effortOption, protocolApi, supportedEfforts } from './route.ts';
import { toStreamChunks } from './stream.ts';

/**
 * 一次流式请求允许的空闲时长。
 *
 * pi-ai 自己没有任何 SSE 空闲超时（只有 codex 那条 WebSocket 路自己带一个），而「连接建立了、
 * 对端随后一声不吭」是网关最常见的失败形态。这个值此前由 `llm-pi-ai` 的 profile 缺省提供，
 * 本插件接过适配器后自己拿住它。
 */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/** 空闲超时的机器码。 */
const IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';

/** 适配器需要的外部事实。 */
export interface AdapterDeps {
  /** 当前这一代要服务的路由；换一份新数组就是新一代。 */
  readonly routes: () => readonly PlannedRoute[];
  /** 解析一条路由的凭据；未配置 `apiKeyEnv` 时返回 `undefined`（该路由用占位凭据）。 */
  readonly resolveApiKey: (provider: string, route: ProviderRoute) => Promise<string | undefined>;
  /** 附件服务；没有它的部署里图片不可转换。 */
  readonly attachments: () => AttachmentStore | undefined;
  /** 诊断。 */
  readonly logger: RuntimeLogger;
}

/** 一条路由上的一个模型的全部派发事实。 */
interface Entry {
  readonly route: PlannedRoute;
  readonly model: ProviderModel;
  readonly pi: PiModel<Api>;
}

/** 一次刷新对应的一代路由。 */
interface Snapshot {
  readonly routes: readonly PlannedRoute[];
  readonly entries: ReadonlyMap<string, Entry>;
}

/**
 * 服务本插件声明的那几条路由。
 *
 * 一个实例服务三代路由，`replace()` 只换路由集合、不换实例——这正是宿主那条原子替换契约
 * 想要的形状。
 */
export class ApertureAdapter extends LlmAdapter {
  /**
   * 外部事实。
   *
   * 写成显式字段而不是构造函数参数属性：本插件的源码会被宿主的 Loader 直接装载，而 Node 的
   * 「只剥类型」模式不支持参数属性——那样加载会在解析期就失败（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。
   */
  private readonly deps: AdapterDeps;
  private snapshot: Snapshot | undefined;

  constructor(deps: AdapterDeps) {
    super();
    this.deps = deps;
  }

  /** {@inheritDoc LlmAdapter.providerInfo} */
  override providerInfo(provider: string): LlmProviderInfo {
    const route = this.findRoute(provider);
    return { id: provider, name: route?.provider.displayName ?? provider };
  }

  /** {@inheritDoc LlmAdapter.listModels} */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const route = this.findRoute(provider);
    if (route === undefined) return [];
    return route.provider.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
    }));
  }

  /** {@inheritDoc LlmAdapter.resolveModel} */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return this.describe(this.current(), provider, model);
  }

  /** {@inheritDoc LlmAdapter.prepareCall} */
  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    // 快照必须在这一行的位置上取：此后任何 await 都可能让刷新换掉路由，而这一代模型容量
    // 与下一代的端点是绝不能混着用的。
    const snapshot = this.current();
    return {
      model: this.describe(snapshot, provider, model),
      stream: (options: GenerateOptions) => this.dispatch(snapshot, options),
    };
  }

  /** {@inheritDoc LlmAdapter.stream} */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.dispatch(this.current(), options);
  }

  /** 描述一条路由上的模型；未服务的模型只回显身份。 */
  private describe(snapshot: Snapshot, provider: string, model: string): LlmResolvedModelInfo {
    const entry = snapshot.entries.get(entryKey(provider, model));
    if (entry === undefined) {
      return { provider, id: model, name: model };
    }
    const efforts = supportedEfforts(entry.pi);
    return {
      provider,
      id: model,
      name: entry.model.name,
      inputModalities: [...entry.model.input],
      context: { contextWindow: entry.pi.contextWindow },
      // 只在模型自己声明过输出上限时才作为默认值交出去：没声明过的模型不该被本插件钉上一个
      // 凭空的默认（缺省上限只活在 pi-ai 侧的请求上）。
      ...(entry.model.maxTokens === undefined ? {} : { defaultMaxTokens: entry.model.maxTokens }),
      ...(entry.model.reasoningEfforts === undefined
        ? {}
        : {
            reasoning: {
              efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })),
            },
          }),
    };
  }

  /** 找到当前这一代里的某条路由。 */
  private findRoute(provider: string): PlannedRoute | undefined {
    return this.deps.routes().find((route) => route.route.id === provider);
  }

  /** 取当前这一代；路由数组换了身份才重建。 */
  private current(): Snapshot {
    const routes = this.deps.routes();
    if (this.snapshot !== undefined && this.snapshot.routes === routes) {
      return this.snapshot;
    }
    const entries = new Map<string, Entry>();
    for (const route of routes) {
      for (const model of route.provider.models) {
        entries.set(entryKey(route.route.id, model.id), {
          route,
          model,
          pi: buildModel(route.route.id, route.provider, model),
        });
      }
    }
    this.snapshot = { routes, entries };
    return this.snapshot;
  }

  /** 派发一次请求。 */
  private async *dispatch(snapshot: Snapshot, options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('dsh-aperture: 不支持 GenerateOptions.stop', 'UNSUPPORTED_OPTION');
    }
    const entry = snapshot.entries.get(entryKey(options.provider, options.model));
    if (entry === undefined) {
      throw new LlmError(
        `dsh-aperture: 路由 "${options.provider}" 上没有模型 "${options.model}"`,
        'UNKNOWN_MODEL',
      );
    }
    const { route, model, pi } = entry;

    const effort = options.reasoningEffort;
    if (effort !== undefined && !supportedEfforts(pi).includes(effort)) {
      throw new LlmError(
        `dsh-aperture: 模型 "${options.model}" 不支持推理档位 "${effort}"`,
        'UNSUPPORTED_REASONING_EFFORT',
      );
    }
    const apiKey = await this.deps.resolveApiKey(options.provider, route.provider);

    // 消费者侧的取消：宿主停止迭代时我们要把底层请求也停掉，否则一次被放弃的对话会把连接
    // 一直挂到网关自己超时。
    const consumer = new AbortController();
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal]);
    const watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, IDLE_TIMEOUT_CODE);
    try {
      const containsImage = options.messages.some((message) => contentHasImage(message.content));
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(
          `dsh-aperture: 模型 "${model.id}" 不接受图片输入`,
          'UNSUPPORTED_CONTENT',
        );
      }
      const attachments = containsImage ? this.deps.attachments() : undefined;
      if (containsImage && attachments === undefined) {
        throw new LlmError(
          'dsh-aperture: 图片输入需要可用的附件服务',
          'UNSUPPORTED_CONTENT',
        );
      }

      const context = await toPiContext(
        { ...options, signal: watchdog.signal },
        attachments === undefined ? undefined : { attachments, signal: watchdog.signal },
        (reason) => this.deps.logger.debug(
          `dsh-aperture: 路由 "${options.provider}" 模型 "${options.model}" 的历史降级：${reason}`,
        ),
      );

      // pi-ai 1.x 的 provider 只认 `TranscriptContext`：system 提示与工具声明必须先折进
      // transcript 头部那条指令消息（推理模型发 `developer`，其余发 `system`）。把
      // `toPiContext` 交出来的 `Context` 原样递进去既编译不过（`TranscriptContext` 带一个
      // 不导出的 brand），运行时也会把这两样整个丢掉——线上只剩一段没有工具、没有系统提示的
      // 对话。
      const iterator = toStreamChunks(
        protocolApi(route.provider.protocol).streamSimple(pi, normalizeContext(context), {
          ...(apiKey === undefined ? {} : { apiKey }),
          headers: requestHeaders(route.provider.headers),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(effort === undefined ? {} : { reasoning: effortOption(effort) }),
          signal: watchdog.signal,
          // 宿主有自己的重试与退避层；这里再重试一次只会把一次失败变成两次。
          maxRetries: 0,
        }),
        {
          provider: options.provider,
          model: options.model,
          contextWindow: pi.contextWindow,
          signal: options.signal,
        },
      )[Symbol.asyncIterator]();

      let exhausted = false;
      try {
        for (;;) {
          const next = await watchdog.next(iterator);
          const timeout = timeoutOf(watchdog.signal, IDLE_TIMEOUT_CODE);
          if (timeout !== undefined) throw timeout;
          if (next.done === true) {
            exhausted = true;
            return;
          }
          yield next.value;
        }
      } finally {
        if (!exhausted) {
          consumer.abort('dsh-aperture: 消费者停止读取');
          try {
            await iterator.return?.(undefined);
          } catch {
            // 主动中止底层流的收尾异常没有诊断价值：调用方已经走了。
          }
        }
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `dsh-aperture: 模型 "${options.model}" 的响应空闲超过 ${STREAM_IDLE_TIMEOUT_MS}ms`,
          'TIMEOUT',
          { cause: error },
        );
      }
      if (options.signal?.aborted === true) {
        throw new LlmError('dsh-aperture: 请求已被调用方中止', 'ABORTED', { cause: error });
      }
      throw error;
    } finally {
      consumer.abort('dsh-aperture: 请求结束');
      watchdog[Symbol.dispose]();
    }
  }
}

/** 一条路由上一个模型的索引键。 */
function entryKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

/**
 * 一次请求最终发送的头。
 *
 * 归因头（`user-agent`）**覆盖**同名配置项而不是被它覆盖：适配器契约要求每一次请求都带上
 * 归因，而一份把 `user-agent` 写死的配置不该能让它消失。大小写不敏感的去重交给这里，
 * 因为 HTTP 头名不区分大小写、而对象键区分。
 *
 * @param configured - 配置里为这条路由声明的头。
 * @returns 合并后的头。
 */
function requestHeaders(configured: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(configured ?? {})) {
    headers[name] = value;
  }
  for (const [name, value] of Object.entries(attributionHeaders())) {
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    }
    headers[name] = value;
  }
  return headers;
}
