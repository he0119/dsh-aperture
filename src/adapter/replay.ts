/**
 * 重放信封：把 pi-ai 响应里那些「下一次请求必须原样带回去」的原生元数据存进行会话日志。
 *
 * pi-ai 的 replay 是**无状态全量历史**：Anthropic 的思考签名、OpenAI Responses 的消息 id 与
 * reasoning item 都活在 assistant 消息的内容块字段上，下一次请求把整条历史重新物化时再写回去。
 * 宿主的日志不存这些字段，因此本模块把「响应级」与「块级」两半分开放进 `ReplayEnvelope`，
 * 并在读回来时**先证明它确实是自己写的**。
 *
 * 证明这件事不能省：历史里可能有本插件之外的适配器（升级前的 `llm-pi-ai`）写下的信封，而宿主
 * 只在「历史路由与目标路由属于同一个适配器实例」时才把信封交回来——升级后的第一次对话正好满足
 * 这个条件，却带着别人的形状。读不出来就降级成 provider 中立的内容，而不是拿别人的字段硬套。
 *
 * @module dsh-aperture/adapter/replay
 */

import { LlmError, type ReplayEnvelope } from '@deepseek-ai/dsh-llm';
import type { AssistantMessage as PiAssistantMessage } from '@earendil-works/pi-ai';

/** 本插件信封的类型标记；与任何别的适配器都不共享。 */
export const REPLAY_KIND = 'aperture';

/** 信封的格式版本；字段含义变化时递增。 */
export const REPLAY_VERSION = 1;

/** 一个块要带回来的原生元数据。 */
export interface ReplayBlock {
  /** OpenAI Responses 的文本消息 id 与阶段。 */
  readonly textSignature?: string;
  /** Anthropic 的思考签名；Responses 路径上存整条 reasoning item 的 JSON。 */
  readonly thinkingSignature?: string;
  /** 该思考块是否被安全过滤改写（密文仍在 {@link ReplayBlock.thinkingSignature}）。 */
  readonly redacted?: boolean;
  /** OpenAI 兼容端点上的工具调用签名。 */
  readonly thoughtSignature?: string;
  /** Responses 路径上动态加载的工具的命名空间。 */
  readonly namespace?: string;
}

/** 一次响应的身份与原生元数据。 */
export interface ReplayResponse {
  readonly kind: typeof REPLAY_KIND;
  readonly version: typeof REPLAY_VERSION;
  /** 产出这条响应的线缆协议。 */
  readonly api: string;
  /** 产出这条响应的 provider 路由。 */
  readonly provider: string;
  /** 请求里的模型 id。 */
  readonly model: string;
  /** 响应级 id（OpenAI 兼容端点的响应 id）。 */
  readonly responseId?: string;
  /** 响应里回报的实际模型名。 */
  readonly responseModel?: string;
  /** 响应实际使用的推理档位。 */
  readonly providerThinkingLevel?: string;
  /** pi-ai 给出的终止原因。 */
  readonly stopReason: string;
}

/** 一份可读的重放状态。 */
export interface ReplayState {
  readonly response: ReplayResponse;
  readonly blocks?: readonly ReplayBlock[];
}

/**
 * 把一次成功的响应收成重放信封。
 *
 * `blocks` 由调用方按**实际发出的块顺序**给出：宿主在装配时会按同样顺序对齐，数量不符就整封
 * 丢弃。因此这里不自己去数消息里的块，而是照抄流式转换记下来的那一份。
 *
 * @param message - pi-ai 的终态助手消息。
 * @param provider - provider 路由键。
 * @param model - 请求里的模型 id。
 * @param blocks - 每个已发出块的原生元数据，按首次出现的顺序。
 * @returns 宿主可以存进消息来源的信封。
 */
export function toReplayState(
  message: PiAssistantMessage,
  provider: string,
  model: string,
  blocks: readonly ReplayBlock[],
): ReplayEnvelope {
  const response: ReplayResponse = {
    kind: REPLAY_KIND,
    version: REPLAY_VERSION,
    api: message.api,
    provider,
    model,
    ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
    ...(message.providerThinkingLevel === undefined
      ? {}
      : { providerThinkingLevel: message.providerThinkingLevel }),
    stopReason: message.stopReason,
  };
  return { response, blocks: [...blocks] };
}

/**
 * 读回一份重放状态。
 *
 * @param value - 会话日志里携带的原生元数据。
 * @returns 本插件写下的状态；不是本插件的（例如升级前由 `llm-pi-ai` 写下的）时为 `undefined`。
 * @throws LlmError 类型标记与版本都是自己的、字段却不成形时——那是记录损坏，不是别人的信封。
 */
export function readReplayState(value: unknown): ReplayState | undefined {
  const envelope = asRecord(value);
  if (envelope === undefined) return undefined;
  const response = asRecord(envelope.response);
  if (response === undefined) return undefined;
  if (response.kind !== REPLAY_KIND) return undefined;
  if (response.version !== REPLAY_VERSION) {
    throw new LlmError(
      `dsh-aperture: 重放信封的版本 ${String(response.version)} 不是本适配器认得的 ${REPLAY_VERSION}`,
      'INVALID_REPLAY_STATE',
    );
  }
  for (const key of ['api', 'provider', 'model', 'stopReason'] as const) {
    if (!isNonEmptyString(response[key])) {
      throw new LlmError(`dsh-aperture: 重放信封缺少 ${key}`, 'INVALID_REPLAY_STATE');
    }
  }

  const blocks = envelope.blocks === undefined ? undefined : readBlocks(envelope.blocks);
  return {
    response: {
      kind: REPLAY_KIND,
      version: REPLAY_VERSION,
      api: response.api as string,
      provider: response.provider as string,
      model: response.model as string,
      stopReason: response.stopReason as string,
      ...optionalString(response, 'responseId'),
      ...optionalString(response, 'responseModel'),
      ...optionalString(response, 'providerThinkingLevel'),
    } as ReplayResponse,
    ...(blocks === undefined ? {} : { blocks }),
  };
}

/** 校验块级元数据。 */
function readBlocks(value: unknown): readonly ReplayBlock[] {
  if (!Array.isArray(value)) {
    throw new LlmError('dsh-aperture: 重放信封的 blocks 不是数组', 'INVALID_REPLAY_STATE');
  }
  return value.map((entry) => {
    const block = asRecord(entry);
    if (block === undefined) {
      throw new LlmError('dsh-aperture: 重放信封的块不是对象', 'INVALID_REPLAY_STATE');
    }
    if (block.redacted !== undefined && typeof block.redacted !== 'boolean') {
      throw new LlmError('dsh-aperture: 重放信封的 redacted 不是布尔值', 'INVALID_REPLAY_STATE');
    }
    return {
      ...optionalString(block, 'textSignature'),
      ...optionalString(block, 'thinkingSignature'),
      ...optionalString(block, 'thoughtSignature'),
      ...optionalString(block, 'namespace'),
      ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
    };
  });
}

/** 取一个自有字段。 */
function optionalString(source: Record<string, unknown>, key: string): Record<string, string> {
  const value = source[key];
  if (value === undefined) return {};
  if (typeof value !== 'string') {
    throw new LlmError(`dsh-aperture: 重放信封的 ${key} 不是字符串`, 'INVALID_REPLAY_STATE');
  }
  return { [key]: value };
}

/** 把一个未知值当成普通对象；数组与 `null` 都不算。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 一个未知值是不是非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
