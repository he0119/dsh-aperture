/**
 * 发布阶段：把发现的模型变成 `llm-pi-ai` provider profile。
 *
 * 这里不做任何负载转换。本插件发布的两种协议——`openai-completions` 与
 * `anthropic-messages`——都由已安装的 `dsh-llm-pi-ai` 适配器实现，因此剩下的工作只是
 * 逐模型陈述该适配器无法通过一个无法识别的网关 URL 推断出的事实：模型有多大、接受
 * 什么，以及它的推理控制如何在协议格式上传输。
 *
 * 该适配器的两个怪癖塑造了本模块。
 *
 * 未在其清单中随附的路由必须声明 `api`、`baseURL` 以及**非空**的 `models` 列表，因此
 * 空无一物的协议完全不产生路由，而不是产生一条空路由。
 *
 * 它的 OpenAI 兼容路径在既无凭据、又无非空 `authorization` 头时拒绝派发。经 Tailscale
 * 认证的网关两者都不需要，因此没有配置 `apiKeyEnv` 的路由会携带一个占位头——有文档
 * 记载、非机密，并且可以通过改为配置一个凭据引用来移除。
 *
 * @module dsh-aperture/profile
 */

import type { PiAiCompatProfile, PiAiModelProfile, PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { isDeepSeekFamily } from './registry.ts';
import type { ApertureProtocol, ConfiguredModel, DiscoveredModel } from './types.ts';
import { buildRouteBaseUrl } from './url.ts';

/** 无凭据路由发送的占位凭据的默认值。 */
export const DEFAULT_PLACEHOLDER_CREDENTIAL = 'dsh-aperture';

/** 为 DeepSeek 方言模型提供的推理档位。 */
const DEEPSEEK_EFFORTS = { off: 'disabled', high: 'high', max: 'max' } as const;

/**
 * 为其他所有推理模型提供的推理档位。
 *
 * `off` 无值——适配器把它映射为「什么都不发」，对 OpenAI 兼容端点而言这就是把思考
 * 交给模型自行决定的方式——而它之上的那一档，是 Aperture 在其所代理的全部模型上都能
 * 接受的最宽写法。`minimal`、`xhigh` 与 `max` 都至少被某一个上游以 HTTP 400 拒绝过，
 * 因此发现的模型绝不会提供它们；更了解的部署可以在 `models` 中逐模型声明。
 */
const GENERIC_EFFORTS = { off: null, high: 'high' } as const;

/** 一次发布过程所需的全部内容。 */
export interface ProfileOptions {
  /** 归一化后的实例根。 */
  readonly instanceRoot: string;
  /** 拥有 OpenAI 兼容模型的路由键。 */
  readonly route: string;
  /** 拥有 Anthropic Messages 模型的路由键。 */
  readonly anthropicRoute: string;
  /** OpenAI 兼容路由的选择器标签。 */
  readonly displayName: string;
  /** Anthropic 路由的选择器标签。 */
  readonly anthropicDisplayName: string;
  /** 凭据引用；部署配置了才有。 */
  readonly apiKeyEnv?: string;
  /** 额外的路由头；它们优先于占位头。 */
  readonly headers: Readonly<Record<string, string>>;
  /** 已配置的逐模型覆盖项，用于查询显式的推理档位。 */
  readonly configured: readonly ConfiguredModel[];
}

/** 一条可写入 `llm-pi-ai` 配置段的路由。 */
export interface RoutePlan {
  /** provider 路由键。 */
  readonly provider: string;
  /** profile 本身，与将被存储的内容完全一致。 */
  readonly profile: PiAiProviderProfile;
  /** 该路由发布的模型，用于报告。 */
  readonly models: readonly DiscoveredModel[];
}

/** 完整的发布方案。 */
export interface ProfilePlan {
  /** 至少含一个模型的路由，顺序稳定。 */
  readonly routes: readonly RoutePlan[];
  /** 没有任何路由可以服务的已发现模型。 */
  readonly unserved: readonly DiscoveredModel[];
  /** 本插件拥有的每个路由键，无论它当前是否有模型。 */
  readonly ownedRoutes: readonly string[];
}

/**
 * 把归一化后的注册表变成 provider profile。
 *
 * @param models - 所有已发现的模型。
 * @param options - 路由与凭据配置。
 * @returns 要发布的路由，以及未能被服务的模型。
 */
export function buildProfilePlan(models: readonly DiscoveredModel[], options: ProfileOptions): ProfilePlan {
  const openai = models.filter((model) => model.protocol === 'openai-completions');
  const anthropic = models.filter((model) => model.protocol === 'anthropic-messages');

  const routes: RoutePlan[] = [];
  if (openai.length > 0) {
    routes.push({
      provider: options.route,
      profile: buildProfile('openai-completions', openai, options),
      models: openai,
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
    ownedRoutes: [options.route, options.anthropicRoute],
  };
}

/** 构建一种协议的路由 profile。 */
function buildProfile(
  protocol: ApertureProtocol,
  models: readonly DiscoveredModel[],
  options: ProfileOptions,
): PiAiProviderProfile {
  const headers = routeHeaders(protocol, options);
  return {
    displayName: protocol === 'openai-completions' ? options.displayName : options.anthropicDisplayName,
    api: protocol,
    baseURL: buildRouteBaseUrl(options.instanceRoot, protocol),
    ...(options.apiKeyEnv === undefined ? {} : { apiKeyEnv: options.apiKeyEnv }),
    ...(headers === undefined ? {} : { headers }),
    models: models.map((model) => buildModelEntry(model, protocol, options)),
  };
}

/**
 * 一条路由发送的头。
 *
 * 已配置的 `apiKeyEnv` 会完全取代占位头——此后由凭据接缝提供该头。插件自身配置中的
 * 部署头在两种情况下都优先于占位头，需要真实静态令牌的网关正是借此拿到它。
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
    if (protocol === 'openai-completions') {
      headers.authorization = `Bearer ${DEFAULT_PLACEHOLDER_CREDENTIAL}`;
    } else {
      headers['x-api-key'] = DEFAULT_PLACEHOLDER_CREDENTIAL;
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
): PiAiModelProfile {
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
): Pick<PiAiModelProfile, 'reasoningEfforts' | 'compat'> {
  // 空字典等于什么都没声明。`llm-pi-ai` 适配器会以「reasoningEfforts 是空的」为由拒绝**整段**
  // 写入——于是三条路由一条都发布不出去，而用户写下 `{}` 想说的显然不是「这条模型没有任何推理
  // 档位」（那该写 `false`）。适配器自己的建议就是「省略这个字段以沿用已安装清单的能力」，
  // 这里照它办：当作没声明，继续往下按模型推导。
  const declared = configured?.reasoningEfforts;
  if (declared !== undefined && Object.keys(declared).length > 0) {
    return { reasoningEfforts: { ...declared }, ...compatFor(model, protocol) };
  }
  if (!model.reasoning) {
    return {};
  }

  // Anthropic 传输通过 token 预算而非推理档位来驱动思考，而网关的列表完全没有说明
  // 上游接受哪种预算。因此除非部署另有声明，发现的 Anthropic 模型一律按不具备推理
  // 能力处理。
  if (protocol === 'anthropic-messages' && configured?.thinking !== true) {
    return {};
  }

  if (isDeepSeekFamily(model)) {
    // 对 DeepSeek 方言而言 `off` 必须非 null：只有当该档位映射到某个值时，适配器才会
    // 发送 `thinking: { type: "disabled" }`。
    return { reasoningEfforts: { ...DEEPSEEK_EFFORTS }, ...compatFor(model, protocol) };
  }
  return { reasoningEfforts: { ...GENERIC_EFFORTS }, ...compatFor(model, protocol) };
}

/**
 * 推理模型所需的 compat 块。
 *
 * pi-ai 从 provider id 与 base URL 推断协议格式兼容性，而 Aperture 的 URL 对它说明不了
 * 什么，因此必须直接声明 DeepSeek 方言。`supportsReasoningEffort` 也要声明：URL 无法被
 * pi-ai 归位的网关目前会被默认为 true，但真正让 `reasoning_effort` 传输出去的是这个
 * 开关，而一条路由不应依赖默认值。
 *
 * @param model - 被描述的模型。
 * @param protocol - 该路由的协议。
 * @returns compat 块，或空对象。
 */
function compatFor(model: DiscoveredModel, protocol: ApertureProtocol): { compat?: PiAiCompatProfile } {
  if (protocol !== 'openai-completions') {
    return {};
  }
  const compat: PiAiCompatProfile = { supportsReasoningEffort: true };
  if (isDeepSeekFamily(model)) {
    compat.thinkingFormat = 'deepseek';
  }
  return { compat };
}
