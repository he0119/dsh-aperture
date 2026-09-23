/**
 * The normalization stage: one raw gateway entry plus catalog metadata plus
 * configuration becomes one `DiscoveredModel`.
 *
 * Three decisions live here and nowhere else.
 *
 * **Which endpoint a model answers on.** Aperture reports the paths each model
 * is reachable through, and refuses the wrong one with a 404 that names the
 * right one. A Gemini model served only through the native
 * `generateContent` transport cannot be reached by `dsh-llm-pi-ai` at all;
 * publishing it on the OpenAI-compatible route would produce a model that fails
 * on every request. So the advertised endpoints decide the route, and a model
 * with no route this plugin can serve is kept for the report but publishes
 * nowhere.
 *
 * **Who sizes a model.** Aperture wins, because the gateway knows what the
 * proxy in front of each upstream accepts; models.dev answers only what
 * Aperture did not state; the configured fallback answers last. The fallback
 * sizes `contextWindow` only — an output cap nobody stated stays absent, so the
 * adapter treats the route fallback as a capability instead of capping every
 * request at an invented number.
 *
 * **Who says a model reasons.** Aperture, then models.dev, then the plugin's
 * `reasoning` switch. A wrong "yes" costs a 400 when a user selects an effort,
 * so nothing is guessed from a model's name.
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

/** The endpoint every OpenAI-compatible model must advertise. */
const OPENAI_ENDPOINT = '/v1/chat/completions';

/** The endpoint every Anthropic Messages model must advertise. */
const ANTHROPIC_ENDPOINT = '/v1/messages';

/** The outcome of one normalization pass. */
export interface RegistryResult {
  /** Every model, including ones no route can serve (their `protocol` is absent). */
  readonly models: readonly DiscoveredModel[];
  /** The subset no configured route can serve. */
  readonly unserved: readonly DiscoveredModel[];
}

/**
 * Normalize, enrich, and merge one gateway listing.
 *
 * @param entries - raw model rows in endpoint order.
 * @param options - configuration knobs.
 * @param lookup - catalog metadata lookup, when one loaded.
 * @returns every model with its provenance, plus the ones no route can serve.
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

  // A configured model the gateway did not advertise still joins the selector;
  // that is how a gateway which under-reports its catalog stays usable.
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

/** Normalize one row the gateway advertised. */
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

/** Normalize one model that exists only because configuration named it. */
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

/** Apply one configured entry's stated fields over a discovered model. */
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

/** Include an output cap only when something actually stated one. */
function resolveOutputCap(maxTokens: number | undefined): { maxTokens?: number } {
  return maxTokens === undefined ? {} : { maxTokens };
}

/** Query the catalog lookup defensively: a lookup must never fail a refresh. */
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
      // A catalog lookup is advisory; a broken one must not fail a refresh.
    }
  }
  return undefined;
}

/** Provenance of the capacity facts. */
function limitsSource(
  apertureLimits: { contextWindow?: number; maxTokens?: number } | undefined,
  catalog: ReturnType<CatalogLookup>,
): ModelProvenance['limits'] {
  if (apertureLimits !== undefined) {
    return 'aperture';
  }
  return catalog?.contextWindow !== undefined || catalog?.maxTokens !== undefined ? 'models.dev' : 'default';
}

/** Provenance of one capability fact that Aperture and the catalog both answer. */
function factsSource(apertureFact: unknown, catalogFact: unknown): ModelProvenance['reasoning'] {
  if (apertureFact !== undefined) {
    return 'aperture';
  }
  return catalogFact !== undefined ? 'models.dev' : 'default';
}

/** Map one configured `api` spelling to a servable protocol. */
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
 * Decide which route a model's advertised endpoints fit.
 *
 * A listing that advertises no endpoints at all is treated as OpenAI-compatible,
 * because a gateway that does not report its transports is far more often a
 * plain Chat Completions proxy than anything else, and a model with no route is
 * unusable either way.
 *
 * @param endpoints - the advertised endpoint paths.
 * @returns the servable protocol, or `undefined` when none fits.
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

/** Whether one advertised endpoint is (or ends with) a known path. */
function matchesEndpoint(advertised: string, known: string): boolean {
  const path = advertised.split('?')[0]?.replace(/\/+$/u, '') ?? '';
  return path === known || path.endsWith(known);
}

/** Render one model's provenance for the `/aperture models` report. */
export function describeProvenance(provenance: ModelProvenance): string {
  const parts = [
    provenance.limits === 'default' ? undefined : `limits:${provenance.limits}`,
    provenance.name === 'default' ? undefined : `name:${provenance.name}`,
    provenance.reasoning === 'default' ? undefined : `reasoning:${provenance.reasoning}`,
    provenance.input === 'default' ? undefined : `input:${provenance.input}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'defaults' : parts.join(' ');
}

/** Whether a model belongs to the DeepSeek reasoning dialect. */
export function isDeepSeekFamily(model: DiscoveredModel): boolean {
  return `${model.id} ${model.name} ${model.provider ?? ''}`.toLowerCase().includes('deepseek');
}

/** Render one modality list for a report line. */
export function formatModalities(input: readonly Modality[]): string {
  return input.length === 0 ? 'none' : input.join('+');
}
