/**
 * Shared vocabulary of the Aperture discovery pipeline.
 *
 * The pipeline is a pure function chain — endpoint response in, provider
 * profiles out — so every stage names its own types here rather than reaching
 * for the Cordis or settings seams: only `src/index.ts` and `src/sync.ts` touch
 * a service.
 *
 * @module dsh-aperture/types
 */

/** One request modality a discovered model may declare. */
export type Modality = 'text' | 'image';

/**
 * Wire protocols this plugin publishes. Both are served by the installed
 * `dsh-llm-pi-ai` adapter, which is why discovery never converts a payload:
 * it only decides which of the gateway's endpoints each model answers on.
 */
export type ApertureProtocol = 'openai-completions' | 'anthropic-messages';

/** Where one normalized fact came from, for diagnostics in the `/aperture` report. */
export type FactSource = 'aperture' | 'models.dev' | 'config' | 'default';

/** Provenance of every value a discovered model carries. */
export interface ModelProvenance {
  /** Source of `contextWindow` and `maxTokens`. */
  readonly limits: FactSource;
  /** Source of `reasoning`. */
  readonly reasoning: FactSource;
  /** Source of `input`. */
  readonly input: FactSource;
  /** Source of `name`. */
  readonly name: FactSource;
}

/** One model after normalization, enrichment, and configuration merge. */
export interface DiscoveredModel {
  /** Model id Aperture accepts. */
  readonly id: string;
  /** Display name for selectors. */
  readonly name: string;
  /**
   * Protocol the model is reachable on, derived from the gateway's
   * `supported_endpoints`. Absent when the gateway offers no endpoint this
   * plugin can serve.
   */
  readonly protocol?: ApertureProtocol;
  /** Every endpoint the gateway advertises for this model, for diagnostics. */
  readonly endpoints: readonly string[];
  /** Maximum combined request and response context in tokens. */
  readonly contextWindow?: number;
  /** Maximum output tokens. */
  readonly maxTokens?: number;
  /** Request modalities declared for this model. */
  readonly input: readonly Modality[];
  /** Whether the model accepts reasoning-effort control. */
  readonly reasoning: boolean;
  /** Upstream provider id the gateway reports, when it reports one. */
  readonly provider?: string;
  /** Where each fact came from. */
  readonly provenance: ModelProvenance;
}

/**
 * One entry of the plugin's `models` configuration list.
 *
 * An entry whose id the endpoint also advertises overrides only the fields it
 * states; an entry naming an unknown id is added as an extra model, which is
 * how a gateway that under-reports stays usable.
 */
export interface ConfiguredModel {
  /** Model id; matches an endpoint-advertised id, or adds a new one. */
  readonly id: string;
  /** Display name. */
  readonly name?: string;
  /** Protocol override; also the only way to serve a model Aperture advertises for an unserved endpoint. */
  readonly api?: string;
  /** Context capacity in tokens. */
  readonly contextWindow?: number;
  /** Output capacity in tokens. */
  readonly maxTokens?: number;
  /** Request modalities. */
  readonly input?: readonly Modality[];
  /** Force reasoning capability on (`true`) or off (`false`). */
  readonly thinking?: boolean;
  /** Explicit selectable reasoning levels: key = level, value = wire spelling. */
  readonly reasoningEfforts?: Readonly<Record<string, string | null>>;
}

/** Everything the pipeline needs to turn one gateway into provider profiles. */
export interface BuildOptions {
  /** Configured overrides and extras. */
  readonly models: readonly ConfiguredModel[];
  /** Non-empty restricts the catalog to these ids. */
  readonly enabledModelIds: readonly string[];
  /**
   * Gateway model id → catalog model id, when the two disagree.
   *
   * Gateways rename: this one serves DeepSeek's flash model as `deepseek-flash`
   * and Kimi's as `k3`, and no scoring rule can bridge that without guessing.
   */
  readonly modelAliases: Readonly<Record<string, string>>;
  /** Fallback context capacity for a model nothing sizes. */
  readonly defaultContextWindow: number;
  /** Whether models.dev input modalities (images) are adopted. */
  readonly images: 'ignore' | 'metadata';
  /** `auto` maps reasoning capability; `off` declares every model non-reasoning. */
  readonly reasoning: 'auto' | 'off';
}

/** Metadata one catalog lookup may contribute to a model. */
export interface CatalogMetadata {
  /** Context capacity in tokens. */
  readonly contextWindow?: number;
  /** Output capacity in tokens. */
  readonly maxTokens?: number;
  /** Whether the model accepts reasoning-effort control. */
  readonly reasoning?: boolean;
  /** Request modalities. */
  readonly input?: readonly Modality[];
  /** Human-readable name. */
  readonly name?: string;
}

/** Look up catalog metadata for one endpoint-advertised model. */
export type CatalogLookup = (model: {
  readonly id: string;
  readonly provider?: string;
  readonly providerName?: string;
}) => CatalogMetadata | undefined;
