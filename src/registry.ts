/**
 * 归一化阶段：一条原始网关条目，加上清单元数据，再加上配置，变成一个
 * `DiscoveredModel`。
 *
 * 三个决策只在这里做出，别处没有。
 *
 * **模型从哪个端点应答。** Aperture 会报告每个模型可通过哪些路径访问，并用一个
 * 404 拒绝错误的路径、同时给出正确的路径。只通过原生 `generateContent`
 * 传输服务的 Gemini 模型，`dsh-llm-pi-ai` 根本够不到；把它发布到
 * OpenAI 兼容路由上，只会得到一个每个请求都失败的模型。因此由通告的端点决定
 * 路由，而没有路由可供本插件服务的模型会保留在报告里，但不发布到任何地方。
 *
 * **谁来决定模型的容量。** Aperture 优先，因为网关知道每个上游前面的代理接受
 * 什么；models.dev 只回答 Aperture 没有说明的部分；配置的兜底值最后回答。兜底
 * 值只设定 `contextWindow` —— 没人声明过的输出上限保持缺失，这样适配器会把路由
 * 兜底当作一种能力，而不是把每个请求都限制在一个凭空捏造的数字上。
 *
 * **谁来决定模型是否会推理。** 依次是 Aperture、models.dev、插件的 `reasoning`
 * 开关。错误的「是」会让用户选择推理档位时付出一个 400 的代价，因此不从模型名
 * 猜测任何东西。
 *
 * @module dsh-aperture/registry
 */

import {
  extractCapabilities,
  extractDisplayName,
  extractEndpoints,
  extractLimits,
  extractModelId,
  extractProvider,
} from './metadata/extract.ts';
import type {
  ApertureProtocol,
  BuildOptions,
  CatalogLookup,
  ConfiguredModel,
  DiscoveredModel,
  Modality,
  ModelProvenance,
} from './types.ts';

/** 每个 OpenAI 兼容模型都必须通告的端点。 */
const OPENAI_ENDPOINT = '/v1/chat/completions';

/** 每个 Anthropic Messages 模型都必须通告的端点。 */
const ANTHROPIC_ENDPOINT = '/v1/messages';

/** 一次归一化的结果。 */
export interface RegistryResult {
  /** 所有模型，包括没有路由能服务的那些（它们的 `protocol` 缺失）。 */
  readonly models: readonly DiscoveredModel[];
  /** 没有任何已配置路由能服务的子集。 */
  readonly unserved: readonly DiscoveredModel[];
}

/**
 * 归一化、补全并合并一份网关清单。
 *
 * @param entries - 按端点顺序排列的原始模型行。
 * @param options - 配置开关。
 * @param lookup - 清单元数据查找器，在已加载时提供。
 * @returns 每个模型及其来源，以及没有路由能服务的那些模型。
 */
export function buildRegistry(
  entries: readonly unknown[],
  options: BuildOptions,
  lookup?: CatalogLookup,
): RegistryResult {
  const enabled = new Set(options.enabledModelIds.map((id) => id.trim()).filter((id) => id.length > 0));
  const configuredById = new Map<string, ConfiguredModel>();
  for (const configured of options.models) {
    const id = configured.id.trim();
    if (id.length > 0 && !configuredById.has(id)) {
      configuredById.set(id, configured);
    }
  }

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];

  for (const entry of entries) {
    const id = extractModelId(entry);
    if (id === undefined || seen.has(id)) {
      continue;
    }
    if (enabled.size > 0 && !enabled.has(id)) {
      continue;
    }
    seen.add(id);
    models.push(fromEndpoint(entry, id, options, lookup));
  }

  // 配置里声明、但网关没有通告的模型仍会进入选择器；
  // 网关少报自己的清单时，正是靠这一点保持可用。
  for (const [id] of configuredById) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push(fromConfiguration(id, options, lookup));
  }

  const merged = models.map((model) => {
    const configured = configuredById.get(model.id);
    return configured === undefined ? model : applyConfigured(model, configured, options);
  });

  return {
    models: merged,
    unserved: merged.filter((model) => model.protocol === undefined),
  };
}

/** 归一化网关通告的一行。 */
function fromEndpoint(
  entry: unknown,
  id: string,
  options: BuildOptions,
  lookup: CatalogLookup | undefined,
): DiscoveredModel {
  const apertureLimits = extractLimits(entry);
  const capabilities = extractCapabilities(entry);
  const provider = extractProvider(entry);
  const endpoints = extractEndpoints(entry);
  const apertureName = extractDisplayName(entry);
  const catalog = lookupModel(lookup, id, provider, options.modelAliases);

  const protocol = classifyProtocol(endpoints);
  return {
    id,
    name: apertureName ?? catalog?.name ?? id,
    ...(protocol === undefined ? {} : { protocol }),
    endpoints,
    contextWindow: apertureLimits?.contextWindow ?? catalog?.contextWindow ?? options.defaultContextWindow,
    ...resolveOutputCap(apertureLimits?.maxTokens ?? catalog?.maxTokens),
    input: options.images === 'metadata' ? (capabilities?.input ?? catalog?.input ?? ['text']) : ['text'],
    reasoning: options.reasoning === 'auto' && (capabilities?.reasoning ?? catalog?.reasoning ?? false),
    ...(provider?.id === undefined ? {} : { provider: provider.id }),
    provenance: {
      limits: limitsSource(apertureLimits, catalog),
      reasoning: factsSource(capabilities?.reasoning, catalog?.reasoning),
      input: factsSource(capabilities?.input, catalog?.input),
      name: apertureName !== undefined ? 'aperture' : catalog?.name !== undefined ? 'models.dev' : 'default',
    },
  };
}

/** 归一化一个只因配置点名而存在的模型。 */
function fromConfiguration(id: string, options: BuildOptions, lookup: CatalogLookup | undefined): DiscoveredModel {
  const catalog = lookupModel(lookup, id, undefined, options.modelAliases);
  return {
    id,
    name: catalog?.name ?? id,
    endpoints: [],
    contextWindow: catalog?.contextWindow ?? options.defaultContextWindow,
    ...resolveOutputCap(catalog?.maxTokens),
    input: options.images === 'metadata' ? (catalog?.input ?? ['text']) : ['text'],
    reasoning: options.reasoning === 'auto' && (catalog?.reasoning ?? false),
    provenance: {
      limits: limitsSource(undefined, catalog),
      reasoning: factsSource(undefined, catalog?.reasoning),
      input: factsSource(undefined, catalog?.input),
      name: catalog?.name !== undefined ? 'models.dev' : 'default',
    },
  };
}

/** 把一条配置条目声明的字段应用到一个已发现的模型上。 */
function applyConfigured(model: DiscoveredModel, configured: ConfiguredModel, options: BuildOptions): DiscoveredModel {
  const protocol = protocolFromConfigured(configured) ?? model.protocol;
  const contextWindow = configured.contextWindow ?? model.contextWindow;
  const maxTokens = configured.maxTokens ?? model.maxTokens;
  const name = configured.name?.trim() || model.name;
  const input = configured.input ?? model.input;

  return {
    id: model.id,
    name,
    ...(protocol === undefined ? {} : { protocol }),
    endpoints: model.endpoints,
    contextWindow: contextWindow ?? options.defaultContextWindow,
    ...resolveOutputCap(maxTokens),
    input: configured.input !== undefined || options.images === 'metadata' ? input : ['text'],
    reasoning: configured.thinking ?? model.reasoning,
    ...(model.provider === undefined ? {} : { provider: model.provider }),
    provenance: {
      limits:
        configured.contextWindow !== undefined || configured.maxTokens !== undefined
          ? 'config'
          : model.provenance.limits,
      reasoning: configured.thinking !== undefined ? 'config' : model.provenance.reasoning,
      input: configured.input !== undefined ? 'config' : model.provenance.input,
      name: configured.name?.trim() ? 'config' : model.provenance.name,
    },
  };
}

/** 仅当确实有来源声明了输出上限时才带上它。 */
function resolveOutputCap(maxTokens: number | undefined): { maxTokens?: number } {
  return maxTokens === undefined ? {} : { maxTokens };
}

/** 防御式地查询清单查找器：查找器绝不能导致刷新失败。 */
function lookupModel(
  lookup: CatalogLookup | undefined,
  id: string,
  provider: { id?: string; name?: string } | undefined,
  aliases: Readonly<Record<string, string>>,
): ReturnType<CatalogLookup> {
  if (lookup === undefined) {
    return undefined;
  }
  const candidates = [aliases[id], id].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
  );
  for (const candidate of candidates) {
    try {
      const found = lookup({
        id: candidate,
        ...(provider?.id === undefined ? {} : { provider: provider.id }),
        ...(provider?.name === undefined ? {} : { providerName: provider.name }),
      });
      if (found !== undefined) {
        return found;
      }
    } catch {
      // 清单查找只是参考性的；坏掉的查找器不能导致刷新失败。
    }
  }
  return undefined;
}

/** 容量类事实的来源。 */
function limitsSource(
  apertureLimits: { contextWindow?: number; maxTokens?: number } | undefined,
  catalog: ReturnType<CatalogLookup>,
): ModelProvenance['limits'] {
  if (apertureLimits !== undefined) {
    return 'aperture';
  }
  return catalog?.contextWindow !== undefined || catalog?.maxTokens !== undefined ? 'models.dev' : 'default';
}

/** 一项 Aperture 与清单都会回答的能力事实的来源。 */
function factsSource(apertureFact: unknown, catalogFact: unknown): ModelProvenance['reasoning'] {
  if (apertureFact !== undefined) {
    return 'aperture';
  }
  return catalogFact !== undefined ? 'models.dev' : 'default';
}

/** 把配置里的一种 `api` 写法映射到可服务的协议。 */
function protocolFromConfigured(configured: ConfiguredModel): ApertureProtocol | undefined {
  switch (configured.api?.trim()) {
    case 'openai-completions':
      return 'openai-completions';
    case 'anthropic-messages':
      return 'anthropic-messages';
    default:
      return undefined;
  }
}

/**
 * 决定一个模型通告的端点适配哪条路由。
 *
 * 完全没有通告任何端点的清单按 OpenAI 兼容处理，因为不上报自身传输方式的网关，
 * 绝大多数情况下就是一个普通的 Chat Completions 代理，而且没有路由的模型无论
 * 如何都不可用。
 *
 * @param endpoints - 通告的端点路径。
 * @returns 可服务的协议；没有适配的协议时为 `undefined`。
 */
export function classifyProtocol(endpoints: readonly string[]): ApertureProtocol | undefined {
  if (endpoints.length === 0) {
    return 'openai-completions';
  }
  if (endpoints.some((endpoint) => matchesEndpoint(endpoint, OPENAI_ENDPOINT))) {
    return 'openai-completions';
  }
  if (endpoints.some((endpoint) => matchesEndpoint(endpoint, ANTHROPIC_ENDPOINT))) {
    return 'anthropic-messages';
  }
  return undefined;
}

/** 判断一个通告的端点是否就是（或以之结尾）某个已知路径。 */
function matchesEndpoint(advertised: string, known: string): boolean {
  const path = advertised.split('?')[0]?.replace(/\/+$/u, '') ?? '';
  return path === known || path.endsWith(known);
}

/** 为 `/aperture models` 报告渲染一个模型的来源。 */
export function describeProvenance(provenance: ModelProvenance): string {
  const parts = [
    provenance.limits === 'default' ? undefined : `limits:${provenance.limits}`,
    provenance.name === 'default' ? undefined : `name:${provenance.name}`,
    provenance.reasoning === 'default' ? undefined : `reasoning:${provenance.reasoning}`,
    provenance.input === 'default' ? undefined : `input:${provenance.input}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'defaults' : parts.join(' ');
}

/** 判断一个模型是否属于 DeepSeek 推理方言。 */
export function isDeepSeekFamily(model: DiscoveredModel): boolean {
  return `${model.id} ${model.name} ${model.provider ?? ''}`.toLowerCase().includes('deepseek');
}

/** 为报告中的一行渲染一个模态列表。 */
export function formatModalities(input: readonly Modality[]): string {
  return input.length === 0 ? 'none' : input.join('+');
}
