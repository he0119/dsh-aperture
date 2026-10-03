/**
 * 发布阶段：把发现的模型变成本插件自己服务的一条 provider 路由。
 *
 * 这里不做任何负载转换：三种协议都由 pi-ai 实现，剩下的工作只是逐模型陈述它无法从一个
 * 无法识别的网关 URL 推断出的事实——模型有多大、接受什么，以及它的推理控制在协议上如何
 * 传输。
 *
 * 两件网关事实塑造了本模块：pi-ai 的 OpenAI 兼容路径在既无凭据、又无非空 `authorization`
 * 头时拒绝派发，所以没有配 `apiKeyEnv` 的路由会带上一个占位头；pi-ai 的 `Model.maxTokens`
 * 是必填的，而没有谁声明过输出上限的模型不该被钉上一个凭空的数字，因此缺省值只作为
 * pi-ai 侧的请求上限，同时**不**作为本插件向宿主声明的默认值（见 `defaultMaxTokens`）。
 *
 * @module dsh-aperture/profile
 */

import { isDeepSeekFamily } from './registry.ts';
import {
  REASONING_LEVELS,
  type ApertureProtocol,
  type ConfiguredModel,
  type DiscoveredModel,
  type Modality,
  type ReasoningLevel,
} from './types.ts';
import { buildRouteBaseUrl } from './url.ts';

/** 无凭据路由发送的占位凭据的默认值。 */
export const DEFAULT_PLACEHOLDER_CREDENTIAL = 'dsh-aperture';

export { REASONING_LEVELS };
export type { ReasoningLevel };

/** 一条模型声明的推理档位：键 = 档位，值 = 协议里的写法；只有 `off` 可以留空。 */
export type ReasoningEfforts = Partial<Record<ReasoningLevel, string | null>>;

/**
 * 本插件会写下的 pi-ai 兼容开关。
 *
 * 只列真的会用到的两个：pi-ai 从 base URL 与 provider id 推断协议形态，而 Aperture 的
 * URL 对它说明不了什么，因此 DeepSeek 方言必须直接声明。
 */
export interface ModelCompat {
  /** 该端点接受 `reasoning_effort`。 */
  readonly supportsReasoningEffort?: boolean;
  /** 思考开关的线缆写法。 */
  readonly thinkingFormat?: 'deepseek';
}

/** 一条 pi-ai 路由上的一个模型。 */
export interface ModelProfile {
  /** 网关接受的模型 id。 */
  readonly id: string;
  /** 选择器里显示的名字。 */
  readonly name: string;
  /** 上下文容量（token 数）。 */
  readonly contextWindow?: number;
  /** 输出上限（token 数）。 */
  readonly maxTokens?: number;
  /** 请求模态。 */
  readonly input: readonly Modality[];
  /** 推理档位；未声明表示不提供任何档位。 */
  readonly reasoningEfforts?: Readonly<ReasoningEfforts>;
  /** 协议兼容开关。 */
  readonly compat?: ModelCompat;
}

/** 一条发布出去的路由：pi-ai 侧的 provider 事实。 */
export interface RouteProfile {
  /** 选择器里显示的路由名。 */
  readonly displayName: string;
  /** 线缆协议。 */
  readonly api: ApertureProtocol;
  /** 该协议下所有模型的基点地址。 */
  readonly baseURL: string;
  /** 每条请求带上的头；没有时为缺失。 */
  readonly headers?: Readonly<Record<string, string>>;
  /** 该路由解析凭据用的引用；没有时以占位凭据发出。 */
  readonly apiKeyEnv?: string;
  /** 该路由承载的模型。 */
  readonly models: readonly ModelProfile[];
}

/** 一次发布过程所需的全部内容。 */
export interface ProfileOptions {
  /** 归一化后的实例根。 */
  readonly instanceRoot: string;
  /** 拥有 OpenAI Chat Completions 模型的路由键。 */
  readonly route: string;
  /** 拥有 OpenAI Responses 模型的路由键。 */
  readonly responsesRoute: string;
  /** 拥有 Anthropic Messages 模型的路由键。 */
  readonly anthropicRoute: string;
  /** OpenAI Chat Completions 路由的选择器标签。 */
  readonly displayName: string;
  /** OpenAI Responses 路由的选择器标签。 */
  readonly responsesDisplayName: string;
  /** Anthropic 路由的选择器标签。 */
  readonly anthropicDisplayName: string;
  /** 凭据引用；部署配置了才有。 */
  readonly apiKeyEnv?: string;
  /** 额外的路由头；它们优先于占位头。 */
  readonly headers: Readonly<Record<string, string>>;
  /** 已配置的逐模型覆盖项，用于查询显式的推理档位。 */
  readonly configured: readonly ConfiguredModel[];
}

/** 一条要注册出去的路由。 */
export interface RoutePlan {
  /** provider 路由键。 */
  readonly provider: string;
  /** pi-ai 侧的 provider 事实。 */
  readonly profile: RouteProfile;
  /** 该路由发布的模型，用于报告与模型信息查询。 */
  readonly models: readonly DiscoveredModel[];
}

/** 完整的发布方案。 */
export interface ProfilePlan {
  /** 至少含一个模型的路由，顺序稳定。 */
  readonly routes: readonly RoutePlan[];
  /** 没有任何路由可以服务的已发现模型。 */
  readonly unserved: readonly DiscoveredModel[];
}

/**
 * 把归一化后的注册表变成 provider 路由。
 *
 * @param models - 所有已发现的模型。
 * @param options - 路由与凭据配置。
 * @returns 要发布的路由，以及未能被服务的模型。
 */
export function buildProfilePlan(models: readonly DiscoveredModel[], options: ProfileOptions): ProfilePlan {
  const completions = models.filter((model) => model.protocol === 'openai-completions');
  const responses = models.filter((model) => model.protocol === 'openai-responses');
  const anthropic = models.filter((model) => model.protocol === 'anthropic-messages');

  const routes: RoutePlan[] = [];
  if (completions.length > 0) {
    routes.push({
      provider: options.route,
      profile: buildProfile('openai-completions', completions, options),
      models: completions,
    });
  }
  if (responses.length > 0) {
    routes.push({
      provider: options.responsesRoute,
      profile: buildProfile('openai-responses', responses, options),
      models: responses,
    });
  }
  if (anthropic.length > 0) {
    routes.push({
      provider: options.anthropicRoute,
      profile: buildProfile('anthropic-messages', anthropic, options),
      models: anthropic,
    });
  }

  return {
    routes,
    unserved: models.filter((model) => model.protocol === undefined),
  };
}

/** 构建一种协议的路由 profile。 */
function buildProfile(
  protocol: ApertureProtocol,
  models: readonly DiscoveredModel[],
  options: ProfileOptions,
): RouteProfile {
  const headers = routeHeaders(protocol, options);
  return {
    displayName: protocol === 'openai-completions'
      ? options.displayName
      : protocol === 'openai-responses'
        ? options.responsesDisplayName
        : options.anthropicDisplayName,
    api: protocol,
    baseURL: buildRouteBaseUrl(options.instanceRoot, protocol),
    ...(headers === undefined ? {} : { headers }),
    ...(options.apiKeyEnv === undefined ? {} : { apiKeyEnv: options.apiKeyEnv }),
    models: models.map((model) => buildModelEntry(model, protocol, options)),
  };
}

/**
 * 一条路由发送的头。
 *
 * 已配置的 `apiKeyEnv` 完全取代占位头——此后由凭据接缝提供。插件自身配置里的部署头在两种
 * 情况下都优先于占位头，需要真实静态令牌的网关正是借此拿到它。
 *
 * @param protocol - 该路由的协议。
 * @param options - 配置。
 * @returns 头字典；该路由不需要任何头时为 `undefined`。
 */
function routeHeaders(
  protocol: ApertureProtocol,
  options: ProfileOptions,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const hasCredential =
    options.apiKeyEnv !== undefined ||
    Object.keys(options.headers).some((name) => {
      const lower = name.toLowerCase();
      return lower === 'authorization' || lower === 'x-api-key' || lower === 'cf-aig-authorization';
    });

  if (!hasCredential) {
    if (protocol === 'anthropic-messages') {
      headers['x-api-key'] = DEFAULT_PLACEHOLDER_CREDENTIAL;
    } else {
      headers.authorization = `Bearer ${DEFAULT_PLACEHOLDER_CREDENTIAL}`;
    }
  }

  Object.assign(headers, options.headers);
  return Object.keys(headers).length === 0 ? undefined : headers;
}

/** 构建一条已配置的模型条目。 */
function buildModelEntry(
  model: DiscoveredModel,
  protocol: ApertureProtocol,
  options: ProfileOptions,
): ModelProfile {
  const configured = options.configured.find((candidate) => candidate.id.trim() === model.id);
  const reasoning = resolveReasoning(model, protocol, configured);

  return {
    id: model.id,
    name: model.name,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    input: [...model.input],
    ...reasoning,
  };
}

/** 解析一条模型条目携带的推理字段。 */
function resolveReasoning(
  model: DiscoveredModel,
  protocol: ApertureProtocol,
  configured: ConfiguredModel | undefined,
): Pick<ModelProfile, 'reasoningEfforts' | 'compat'> {
  // 空字典等于什么都没声明。pi-ai 会以「reasoningEfforts 是空的」为由拒绝整段配置——
  // 于是所有路由一条都发布不出去，而用户写下 `{}` 想说的显然不是「这条模型没有任何推理
  // 档位」（那该写 `false`）。pi-ai 自己的建议是省略这个字段以沿用 provider 的能力，
  // 这里照它办。
  const declared = configured?.reasoningEfforts;
  if (declared !== undefined && Object.keys(declared).length > 0) {
    return { reasoningEfforts: { ...declared }, ...compatFor(model, protocol) };
  }
  if (!model.reasoning) {
    return {};
  }

  // Anthropic 传输通过 token 预算而非推理档位驱动思考，而网关的列表完全没说上游接受哪种
  // 预算。因此除非部署另有声明，发现的 Anthropic 模型一律按不具备推理能力处理。
  if (protocol === 'anthropic-messages' && configured?.thinking !== true) {
    return {};
  }

  if (isDeepSeekFamily(model)) {
    // 对 DeepSeek 方言而言 `off` 必须非 null：只有当该档位映射到某个值时，pi-ai 才会
    // 发送 `thinking: { type: "disabled" }`。
    return { reasoningEfforts: { ...DEEPSEEK_EFFORTS }, ...compatFor(model, protocol) };
  }
  return { reasoningEfforts: { ...GENERIC_EFFORTS }, ...compatFor(model, protocol) };
}

/** 始终声明 `supportsReasoningEffort`：真正让 `reasoning_effort` 传输出去的是这个开关。 */
function compatFor(model: DiscoveredModel, protocol: ApertureProtocol): { compat?: ModelCompat } {
  if (protocol !== 'openai-completions') {
    return {};
  }
  return {
    compat: isDeepSeekFamily(model)
      ? { supportsReasoningEffort: true, thinkingFormat: 'deepseek' }
      : { supportsReasoningEffort: true },
  };
}

/** 为 DeepSeek 方言模型提供的推理档位。 */
const DEEPSEEK_EFFORTS: ReasoningEfforts = { off: 'disabled', high: 'high', max: 'max' };

/**
 * 为其他所有推理模型提供的推理档位。
 *
 * `off` 无值——pi-ai 把它映射为「什么都不发」，对 OpenAI 兼容端点而言这就是把思考交给
 * 模型自行决定。它之上的那一档是 Aperture 在它所代理的全部模型上都能接受的最宽写法；
 * `minimal`、`xhigh`、`max` 都至少被某个上游以 400 拒绝过，因此发现的模型绝不提供，
 * 更了解的部署可以在 `models` 里逐模型声明。
 */
const GENERIC_EFFORTS: ReasoningEfforts = { off: null, high: 'high' };
