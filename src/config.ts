/**
 * Configuration schema and resolution.
 *
 * The plugin owns one settings namespace, `aperture`, whose composition layer
 * is the bundle's `cordis.patch.yml` row and whose user layer is the `aperture:`
 * section of `$DSH_HOME/settings.yaml`. Everything it publishes it publishes
 * into a *different* namespace, `llm-pi-ai` — the adapter that actually serves
 * the routes. That split is the whole design: this plugin decides which models
 * exist, and that one decides how to talk to them.
 *
 * @module dsh-aperture/config
 */

import z from '@deepseek-ai/schemastery';
import { DEFAULT_PLACEHOLDER_CREDENTIAL } from './profile.ts';
import { normalizeBaseUrl } from './url.ts';

export { APERTURE_NAMESPACE, PI_AI_NAMESPACE } from './namespaces.ts';

/** Default catalog URL; the reference extension uses the same document. */
export const DEFAULT_MODEL_METADATA_URL = 'https://models.dev/models.json';

/** Context capacity assumed for a model neither Aperture nor the catalog sizes. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** A provider route key's grammar, matching the Models page's own rule. */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** One configured model: an override of a discovered model, or an extra one. */
const modelConfig = z.object({
  /** Model id; matches a discovered id, or adds a model the gateway did not list. */
  id: z.string().required(),
  /** Selector label. */
  name: z.string(),
  /** Protocol override: `openai-completions` or `anthropic-messages`. */
  api: z.string(),
  /** Context capacity in tokens. */
  contextWindow: z.number().step(1).min(1),
  /** Output capability in tokens. */
  maxTokens: z.number().step(1).min(1),
  /** Request modalities. */
  input: z.array(z.union([z.const('text'), z.const('image')])),
  /** Force reasoning capability on or off. */
  thinking: z.boolean(),
  /** Offered reasoning levels: key = level, value = wire spelling. */
  reasoningEfforts: z.dict(z.union([z.string(), z.const(null)])),
});

/** Plugin configuration. */
export interface Config {
  /** Aperture instance root, e.g. `https://ai.example.ts.net`. Empty disables discovery. */
  baseUrl?: string;
  /** Route key owning OpenAI-compatible models. */
  route?: string;
  /** Route key owning Anthropic Messages models. */
  anthropicRoute?: string;
  /** Selector label for the OpenAI-compatible route. */
  displayName?: string;
  /** Selector label for the Anthropic route. */
  anthropicDisplayName?: string;
  /** Credential reference resolved per request; empty publishes a placeholder header instead. */
  apiKeyEnv?: string;
  /** Placeholder credential value; an empty string publishes no placeholder header. */
  placeholderCredential?: string;
  /** Extra headers sent on every route request; these win over the placeholder. */
  headers?: Record<string, string>;
  /** Non-empty restricts discovery to these model ids. */
  enabledModelIds?: string[];
  /**
   * Gateway model id → models.dev model id, for ids the catalog spells
   * differently (`deepseek-flash` → `deepseek/deepseek-v4-flash`).
   */
  modelAliases?: Record<string, string>;
  /** Overrides and extras, merged by id. */
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
  /** models.dev catalog URL; empty disables the enrichment fetch. */
  modelMetadataUrl?: string;
  /** Context capacity for a model nothing sizes. */
  defaultContextWindow?: number;
  /** `metadata` adopts catalog input modalities; `ignore` declares text-only. */
  images?: 'ignore' | 'metadata';
  /** `auto` maps a model's reasoning capability; `off` declares every model non-reasoning. */
  reasoning?: 'auto' | 'off';
  /** Whether the discovered catalog is written to the `llm-pi-ai` section. */
  sync?: boolean;
  /** Minutes between automatic refreshes; `0` refreshes only at load and on change. */
  refreshIntervalMinutes?: number;
  /** Per-request timeout for the gateway and the catalog. */
  timeoutMs?: number;
}

/** Runtime schema for {@link Config}. */
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

/** Validated configuration with every default resolved and the root normalized. */
export interface ResolvedConfig {
  /** Normalized instance root, or `undefined` when discovery is switched off. */
  readonly instanceRoot: string | undefined;
  /** The configured value, verbatim, for diagnostics. */
  readonly rawBaseUrl: string;
  readonly route: string;
  readonly anthropicRoute: string;
  readonly displayName: string;
  readonly anthropicDisplayName: string;
  /** Credential reference, or `undefined` when none is configured. */
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
 * Resolve one configuration section, rejecting only self-contained mistakes.
 *
 * A missing or unusable `baseUrl` is *not* rejected: the plugin stays mounted
 * and dormant so a profile can carry the row before anyone has filled it in,
 * which is also how the settings namespace becomes editable in the first place.
 * Route keys are rejected because a bad one cannot be corrected by a later
 * write — the plugin would silently publish nowhere.
 *
 * @param config - the resolved `aperture` section.
 * @returns the validated configuration.
 * @throws Error naming the field when a route key is malformed or both routes collide.
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
        `${field} "${value}" must be a lowercase hyphenated provider route (matching ${String(ROUTE_PATTERN)})`,
      );
    }
  }
  if (route === anthropicRoute) {
    throw new Error(`route and anthropicRoute must differ; both are "${route}"`);
  }

  const models = config.models ?? [];
  const seen = new Set<string>();
  for (const model of models) {
    const id = model.id.trim();
    if (id.length === 0) {
      throw new Error('models[].id must not be empty');
    }
    if (seen.has(id)) {
      throw new Error(`models lists "${id}" more than once`);
    }
    seen.add(id);
    if (model.api !== undefined && model.api !== 'openai-completions' && model.api !== 'anthropic-messages') {
      throw new Error(
        `models["${id}"].api "${model.api}" is not servable; use openai-completions or anthropic-messages`,
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
