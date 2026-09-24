/**
 * 配置 schema 与解析。
 *
 * 本插件拥有自己的 entry（`aperture`，用户层就是 profile patch 里那一行的 `config`），
 * 但发布出去的一切都写进**另一个** entry `llm-pi-ai`：本插件决定有哪些模型，那个适配器
 * 决定怎么跟它们说话。
 *
 * 整份 schema 都是 volatile 的：设置接缝**只**暴露 volatile 字段（没有 volatile 节点的
 * entry 不出现在 `describe()` 里，界面就无从编辑），而这里每个字段都只影响下一轮发现、
 * 没有一项需要重启——于是配置改动被 Loader 当作就地换引用的活更新，插件不重新挂载，
 * 正在跑的那轮刷新也不会被掐断。
 *
 * @module dsh-aperture/config
 */

import z from '@deepseek-ai/schemastery';
import { normalizeBaseUrl } from './url.ts';

/** 本插件拥有、并可通过它配置的设置命名空间。 */
export const APERTURE_NAMESPACE = 'aperture';

/** 默认清单地址；参考实现用的是同一份文档。 */
export const DEFAULT_MODEL_METADATA_URL = 'https://models.dev/models.json';

/** 当 Aperture 与清单都没给出容量时，为模型假定的上下文容量。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 访问网关与清单的单次请求超时。没有哪个部署需要为此改一次配置。 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** provider 路由键的文法，与 Models 页面自身的规则一致。 */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** 一个配置好的模型：对已发现模型的覆盖，或者一个额外的模型。 */
const modelConfig = z.object({
  /** 模型 id；与已发现的 id 对应，或者新增一个网关没有列出的模型。 */
  id: z.string().required(),
  /** 选择器里显示的名字。 */
  name: z.string(),
  /** 协议覆盖：`openai-completions` 或 `anthropic-messages`。 */
  api: z.string(),
  /** 上下文容量（token 数）。 */
  contextWindow: z.number().step(1).min(1),
  /** 输出能力（token 数）。 */
  maxTokens: z.number().step(1).min(1),
  /** 请求模态。 */
  input: z.array(z.union([z.const('text'), z.const('image')])),
  /** 强制打开或关闭推理能力。 */
  thinking: z.boolean(),
  /** 提供的推理档位：键 = 档位，值 = 协议里的写法。 */
  reasoningEfforts: z.dict(z.union([z.string(), z.const(null)])),
});

/** 插件配置。 */
export interface Config {
  /** Aperture 实例根地址，例如 `https://ai.example.ts.net`。留空则关闭发现。 */
  baseUrl?: string;
  /** 承载 OpenAI 兼容模型的路由键；Anthropic 那条路由与两者的显示名都从它推出来（{@link derivedNames}）。 */
  route?: string;
  /** 按请求解析的凭据引用；留空则改为发布一个占位请求头。 */
  apiKeyEnv?: string;
  /** 每条路由的请求都会带上的额外请求头；它们优先于占位凭据。 */
  headers?: Record<string, string>;
  /** 非空时，只发现这些模型 id。 */
  enabledModelIds?: string[];
  /** 网关模型 id → models.dev 模型 id，用于两边写法不同的 id。 */
  modelAliases?: Record<string, string>;
  /** 覆盖与追加，按 id 合并。 */
  models?: Array<{
    id: string;
    name?: string;
    api?: string;
    contextWindow?: number;
    maxTokens?: number;
    input?: Array<'text' | 'image'>;
    thinking?: boolean;
    reasoningEfforts?: Record<string, string | null>;
  }>;
  /** models.dev 清单地址；留空则关闭这次补齐。 */
  modelMetadataUrl?: string;
  /** `metadata` 接受清单里的输入模态；`ignore` 声明为纯文本。 */
  images?: 'ignore' | 'metadata';
  /** `auto` 映射模型的推理能力；`off` 声明所有模型都不推理。 */
  reasoning?: 'auto' | 'off';
  /** 是否把发现的模型清单写进 `llm-pi-ai` 段。 */
  sync?: boolean;
  /** 自动刷新间隔（分钟）；`0` 表示只在加载时与配置变更时刷新。 */
  refreshIntervalMinutes?: number;
}

/**
 * {@link Config} 的运行时 schema。
 *
 * 根节点上的 `.volatile()` 让整份配置成为活引用：`apply` 拿到的是 `Ref`，读值走
 * `.get()`，每次变更都是对同一引用的 `updateVolatile`。校验与默认值照旧——volatile
 * 只改变结果如何被持有。
 */
export const Config = z.object({
  baseUrl: z.string().default(''),
  route: z.string().default('aperture'),
  apiKeyEnv: z.string().default(''),
  headers: z.dict(z.string()).default({}),
  enabledModelIds: z.array(z.string()).default([]),
  modelAliases: z.dict(z.string()).default({}),
  models: z.array(modelConfig).default([]),
  modelMetadataUrl: z.string().default(DEFAULT_MODEL_METADATA_URL),
  images: z.union([z.const('ignore'), z.const('metadata')]).default('ignore'),
  reasoning: z.union([z.const('auto'), z.const('off')]).default('auto'),
  sync: z.boolean().default(true),
  refreshIntervalMinutes: z.number().min(0).max(24 * 60).default(0),
}).volatile();

/**
 * Loader 交到 `apply` 手里的配置活引用。
 *
 * `.get()` 返回深冻结快照，且只在值真的变了之后才换引用——这正是 {@link memoizedConfig}
 * 与运行时单飞判定所依赖的「配置版本」。
 */
export type ConfigRef = ReturnType<typeof Config>;

/**
 * 取活引用里的那份普通配置值。
 *
 * 根级 volatile 只改变配置**怎么被持有**，解析与校验照旧（非法值仍在 `Config(raw)` 当场
 * 抛出，默认值也已补齐），所以这里只把活引用读成一份快照，交给不关心「活」的那几层。
 *
 * @param ref - Loader 交到 `apply` 手里的配置活引用。
 * @returns 当前那份深冻结的普通配置值。
 */
export function configValue(ref: ConfigRef): FilledConfig {
  return (ref.get() ?? {}) as FilledConfig;
}

/**
 * 默认值补齐之后的配置。
 *
 * {@link Config} 是**用户可写**的形状（每个键可选）；schema 输出的那份不是——每个字段
 * 都带 `.default()`。把这个事实写进类型，调用方就不必对着一堆必然存在的字段写 `??`。
 */
export type FilledConfig = Required<Config>;

/** 校验过的配置：默认值已全部补齐，根地址已归一化。 */
export interface ResolvedConfig {
  /** 归一化后的实例根地址；关闭发现时为 `undefined`。 */
  readonly instanceRoot: string | undefined;
  /** 原样保留的配置值，供诊断使用。 */
  readonly rawBaseUrl: string;
  readonly route: string;
  readonly anthropicRoute: string;
  readonly displayName: string;
  readonly anthropicDisplayName: string;
  /** 凭据引用；未配置时为 `undefined`。 */
  readonly apiKeyEnv: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly enabledModelIds: readonly string[];
  readonly modelAliases: Readonly<Record<string, string>>;
  readonly models: NonNullable<Config['models']>;
  readonly modelMetadataUrl: string;
  readonly images: 'ignore' | 'metadata';
  readonly reasoning: 'auto' | 'off';
  readonly sync: boolean;
  readonly refreshIntervalMinutes: number;
}

/**
 * 从一个路由键推出这一对路由的名字与显示名。
 *
 * 这三条事实曾经是三个可写字段，但一个部署要换的从来只是前缀：Anthropic 那条加
 * `-anthropic` 后缀，显示名是路由键的标题写法（`aperture` → `Aperture`）。让它们互相
 * 矛盾因此变成不可能，而不是要校验出来的错误。
 *
 * @param route - 已经过文法校验的 OpenAI 兼容路由键。
 * @returns 三条推导出来的名字。
 */
function derivedNames(route: string): { anthropicRoute: string; displayName: string; anthropicDisplayName: string } {
  const displayName = route
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return { anthropicRoute: `${route}-anthropic`, displayName, anthropicDisplayName: `${displayName} (Anthropic)` };
}

/**
 * 解析一段配置，只拒绝那些自身就矛盾的错误。
 *
 * `baseUrl` 缺失或不可用**不**算错误：插件照常挂载但处于休眠，这样 profile 可以在还没人
 * 填地址时就先带着这一行。路由键则必须拒绝——写错的路由键无法靠后续写入补救，插件会静默地
 * 什么都不发布。
 *
 * @param config - 已补齐默认值的 `aperture` 段（`configValue` 的返回值，不是活引用）。
 * @returns 校验过的配置。
 * @throws Error 当路由键不合文法、或模型覆盖自身重复/无法服务时抛出，并在消息里点名字段。
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const rawBaseUrl = (config.baseUrl ?? '').trim();
  const instanceRoot = normalizeBaseUrl(rawBaseUrl);

  const route = (config.route ?? '').trim();
  if (!ROUTE_PATTERN.test(route)) {
    throw new Error(`route "${route}" 必须是小写连字符形式的 provider 路由名（需匹配 ${String(ROUTE_PATTERN)}）`);
  }

  const models = config.models ?? [];
  const seen = new Set<string>();
  for (const model of models) {
    const id = model.id.trim();
    if (id.length === 0) {
      throw new Error('models[].id 不能为空');
    }
    if (seen.has(id)) {
      throw new Error(`models 里重复列出了 "${id}"`);
    }
    seen.add(id);
    if (model.api !== undefined && model.api !== 'openai-completions' && model.api !== 'anthropic-messages') {
      throw new Error(
        `models["${id}"].api "${model.api}" 无法服务；请使用 openai-completions 或 anthropic-messages`,
      );
    }
  }

  const apiKeyEnv = (config.apiKeyEnv ?? '').trim();

  return {
    instanceRoot,
    rawBaseUrl,
    route,
    ...derivedNames(route),
    apiKeyEnv: apiKeyEnv.length === 0 ? undefined : apiKeyEnv,
    headers: config.headers ?? {},
    enabledModelIds: config.enabledModelIds ?? [],
    modelAliases: config.modelAliases ?? {},
    models,
    modelMetadataUrl: (config.modelMetadataUrl ?? '').trim(),
    images: config.images ?? 'ignore',
    reasoning: config.reasoning ?? 'auto',
    sync: config.sync ?? true,
    refreshIntervalMinutes: config.refreshIntervalMinutes ?? 0,
  };
}

/**
 * 把「解析当前的配置段」包成一个按源缓存的 thunk。
 *
 * 配置活引用的 `.get()` 只在值真的变了之后才换快照，没变就还是同一个对象，因此返回值可以
 * 直接当**配置版本**用。不缓存的话每次调用都是新对象，运行时的版本判断永远不成立，于是每次
 * 刷新都会多排一轮。
 *
 * @param source - 生效配置段的活引用（每次编辑都就地换掉它的内容）。
 * @returns 解析后的配置；源没换时返回同一个对象。
 */
export function memoizedConfig(source: () => Config): () => ResolvedConfig {
  let from: Config | undefined;
  let resolved: ResolvedConfig | undefined;
  return () => {
    const current = source();
    if (resolved === undefined || from !== current) {
      from = current;
      resolved = resolveConfig(current);
    }
    return resolved;
  };
}
