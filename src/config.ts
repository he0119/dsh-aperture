/**
 * 配置 schema 与解析。
 *
 * 本插件拥有一个设置命名空间 `aperture`：它的组合层是 bundle 里
 * `cordis.patch.yml` 的那一行，用户层是 `$DSH_HOME/settings.yaml` 里的
 * `aperture:` 段。而它发布出去的一切都写进**另一个**命名空间 `llm-pi-ai`——
 * 真正提供这些路由的适配器。这个分工就是整个设计：本插件决定有哪些模型，
 * 那个适配器决定怎么跟它们说话。
 *
 * @module dsh-aperture/config
 */

import z from '@deepseek-ai/schemastery';
import { DEFAULT_PLACEHOLDER_CREDENTIAL } from './profile.ts';
import { normalizeBaseUrl } from './url.ts';

export { APERTURE_NAMESPACE, PI_AI_NAMESPACE } from './namespaces.ts';

/** 默认清单地址；参考实现用的是同一份文档。 */
export const DEFAULT_MODEL_METADATA_URL = 'https://models.dev/models.json';

/** 当 Aperture 与清单都没给出容量时，为模型假定的上下文容量。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

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
  /** 承载 OpenAI 兼容模型的路由键。 */
  route?: string;
  /** 承载 Anthropic Messages 模型的路由键。 */
  anthropicRoute?: string;
  /** OpenAI 兼容路由在选择器里显示的名字。 */
  displayName?: string;
  /** Anthropic 路由在选择器里显示的名字。 */
  anthropicDisplayName?: string;
  /** 按请求解析的凭据引用；留空则改为发布一个占位请求头。 */
  apiKeyEnv?: string;
  /** 占位凭据的值；空串表示不发布占位请求头。 */
  placeholderCredential?: string;
  /** 每条路由的请求都会带上的额外请求头；它们优先于占位凭据。 */
  headers?: Record<string, string>;
  /** 非空时，只发现这些模型 id。 */
  enabledModelIds?: string[];
  /**
   * 网关模型 id → models.dev 模型 id，用于清单里写法不同的 id
   * （`deepseek-flash` → `deepseek/deepseek-v4-flash`）。
   */
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
  /** 没有任何来源给出容量时使用的上下文容量。 */
  defaultContextWindow?: number;
  /** `metadata` 接受清单里的输入模态；`ignore` 声明为纯文本。 */
  images?: 'ignore' | 'metadata';
  /** `auto` 映射模型的推理能力；`off` 声明所有模型都不推理。 */
  reasoning?: 'auto' | 'off';
  /** 是否把发现的模型清单写进 `llm-pi-ai` 段。 */
  sync?: boolean;
  /** 自动刷新间隔（分钟）；`0` 表示只在加载时与配置变更时刷新。 */
  refreshIntervalMinutes?: number;
  /** 访问网关与清单的单次请求超时。 */
  timeoutMs?: number;
}

/** {@link Config} 的运行时 schema。 */
export const Config = z.object({
  baseUrl: z.string().default(''),
  route: z.string().default('aperture'),
  anthropicRoute: z.string().default('aperture-anthropic'),
  displayName: z.string().default('Aperture'),
  anthropicDisplayName: z.string().default('Aperture (Anthropic)'),
  apiKeyEnv: z.string().default(''),
  placeholderCredential: z.string().default(DEFAULT_PLACEHOLDER_CREDENTIAL),
  headers: z.dict(z.string()).default({}),
  enabledModelIds: z.array(z.string()).default([]),
  modelAliases: z.dict(z.string()).default({}),
  models: z.array(modelConfig).default([]),
  modelMetadataUrl: z.string().default(DEFAULT_MODEL_METADATA_URL),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  images: z.union([z.const('ignore'), z.const('metadata')]).default('ignore'),
  reasoning: z.union([z.const('auto'), z.const('off')]).default('auto'),
  sync: z.boolean().default(true),
  refreshIntervalMinutes: z.number().min(0).max(24 * 60).default(0),
  timeoutMs: z.number().step(1).min(1).default(20_000),
});

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
  readonly placeholderCredential: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly enabledModelIds: readonly string[];
  readonly modelAliases: Readonly<Record<string, string>>;
  readonly models: NonNullable<Config['models']>;
  readonly modelMetadataUrl: string;
  readonly defaultContextWindow: number;
  readonly images: 'ignore' | 'metadata';
  readonly reasoning: 'auto' | 'off';
  readonly sync: boolean;
  readonly refreshIntervalMinutes: number;
  readonly timeoutMs: number;
}

/**
 * 解析一段配置，只拒绝那些自身就矛盾的错误。
 *
 * `baseUrl` 缺失或不可用**不**算错误：插件照常挂载但处于休眠，这样 profile 可以在
 * 还没人填地址时就先带着这一行——这也正是该设置命名空间能变得可编辑的原因。
 * 路由键则必须拒绝，因为写错的路由键无法靠后续写入补救：插件会静默地什么都不发布。
 *
 * @param config - 解析好的 `aperture` 段。
 * @returns 校验过的配置。
 * @throws Error 当路由键不合文法、或两条路由相同时抛出，并在消息里点名字段。
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const rawBaseUrl = (config.baseUrl ?? '').trim();
  const instanceRoot = normalizeBaseUrl(rawBaseUrl);

  const route = (config.route ?? '').trim();
  const anthropicRoute = (config.anthropicRoute ?? '').trim();
  for (const [field, value] of [
    ['route', route],
    ['anthropicRoute', anthropicRoute],
  ] as const) {
    if (!ROUTE_PATTERN.test(value)) {
      throw new Error(
        `${field} "${value}" 必须是小写连字符形式的 provider 路由名（需匹配 ${String(ROUTE_PATTERN)}）`,
      );
    }
  }
  if (route === anthropicRoute) {
    throw new Error(`route 与 anthropicRoute 不能相同，两者都是 "${route}"`);
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
    anthropicRoute,
    displayName: (config.displayName ?? '').trim() || 'Aperture',
    anthropicDisplayName: (config.anthropicDisplayName ?? '').trim() || 'Aperture (Anthropic)',
    apiKeyEnv: apiKeyEnv.length === 0 ? undefined : apiKeyEnv,
    placeholderCredential: config.placeholderCredential ?? DEFAULT_PLACEHOLDER_CREDENTIAL,
    headers: config.headers ?? {},
    enabledModelIds: config.enabledModelIds ?? [],
    modelAliases: config.modelAliases ?? {},
    models,
    modelMetadataUrl: (config.modelMetadataUrl ?? '').trim(),
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    images: config.images ?? 'ignore',
    reasoning: config.reasoning ?? 'auto',
    sync: config.sync ?? true,
    refreshIntervalMinutes: config.refreshIntervalMinutes ?? 0,
    timeoutMs: config.timeoutMs ?? 20_000,
  };
}
