/**
 * The publication stage: discovered models become `llm-pi-ai` provider
 * profiles.
 *
 * Nothing here converts a payload. Both protocols the plugin publishes —
 * `openai-completions` and `anthropic-messages` — are implemented by the
 * installed `dsh-llm-pi-ai` adapter, so the only work left is to state, per
 * model, the facts that adapter cannot infer through an unrecognized gateway
 * URL: how large it is, what it accepts, and how its reasoning control travels
 * on the wire.
 *
 * Two quirks of that adapter shape this module.
 *
 * A route it does not ship in its catalog must declare `api`, `baseURL`, and a
 * **non-empty** `models` list, so a protocol with nothing in it produces no
 * route at all rather than an empty one.
 *
 * Its OpenAI-compatible path refuses to dispatch without either a credential or
 * a non-empty `authorization` header. A Tailscale-authenticated gateway needs
 * neither, so a route with no configured `apiKeyEnv` carries a placeholder
 * header — documented, non-secret, and removable by configuring a credential
 * reference instead.
 *
 * @module dsh-aperture/profile
 */

import type { PiAiCompatProfile, PiAiModelProfile, PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { isDeepSeekFamily } from './registry.ts';
import type { ApertureProtocol, ConfiguredModel, DiscoveredModel } from './types.ts';
import { buildRouteBaseUrl } from './url.ts';

/** Default value of the placeholder credential a keyless route sends. */
export const DEFAULT_PLACEHOLDER_CREDENTIAL = 'dsh-aperture';

/** Reasoning levels offered for a DeepSeek-dialect model. */
const DEEPSEEK_EFFORTS = { off: 'disabled', high: 'high', max: 'max' } as const;

/**
 * Reasoning levels offered for every other reasoning model.
 *
 * `off` is valueless — the adapter maps it to "send nothing", which for an
 * OpenAI-compatible endpoint is how thinking is left to the model — and the one
 * level above it is the widest spelling Aperture accepted across the models it
 * fronted. `minimal`, `xhigh`, and `max` were each rejected with HTTP 400 by at
 * least one upstream, so a discovered model never offers them; a deployment
 * that knows better states them per model in `models`.
 */
const GENERIC_EFFORTS = { off: null, high: 'high' } as const;

/** Everything one publication pass needs. */
export interface ProfileOptions {
  /** Normalized instance root. */
  readonly instanceRoot: string;
  /** Route key owning OpenAI-compatible models. */
  readonly route: string;
  /** Route key owning Anthropic Messages models. */
  readonly anthropicRoute: string;
  /** Selector label for the OpenAI-compatible route. */
  readonly displayName: string;
  /** Selector label for the Anthropic route. */
  readonly anthropicDisplayName: string;
  /** Credential reference, when the deployment configures one. */
  readonly apiKeyEnv?: string;
  /** Extra route headers; these win over the placeholder. */
  readonly headers: Readonly<Record<string, string>>;
  /** Placeholder credential value; empty publishes no placeholder header. */
  readonly placeholderCredential: string;
  /** Configured per-model overrides, consulted for explicit reasoning levels. */
  readonly configured: readonly ConfiguredModel[];
}

/** One route ready to be written into the `llm-pi-ai` section. */
export interface RoutePlan {
  /** Provider route key. */
  readonly provider: string;
  /** The profile itself, exactly as it will be stored. */
  readonly profile: PiAiProviderProfile;
  /** The models this route publishes, for reporting. */
  readonly models: readonly DiscoveredModel[];
}

/** The complete publication plan. */
export interface ProfilePlan {
  /** Routes with at least one model, in a stable order. */
  readonly routes: readonly RoutePlan[];
  /** Discovered models no route can serve. */
  readonly unserved: readonly DiscoveredModel[];
  /** Every route key this plugin owns, whether or not it currently has models. */
  readonly ownedRoutes: readonly string[];
}

/**
 * Turn a normalized registry into provider profiles.
 *
 * @param models - every discovered model.
 * @param options - routing and credential configuration.
 * @returns the routes to publish, plus the models left unserved.
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

/** Build one protocol's route profile. */
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
 * The headers one route sends.
 *
 * A configured `apiKeyEnv` replaces the placeholder entirely — the credential
 * seam then supplies the header. Deployment headers from the plugin's own
 * configuration win over the placeholder in either case, which is how a gateway
 * that wants a real static token gets one.
 *
 * @param protocol - the route's protocol.
 * @param options - configuration.
 * @returns the header dict, or `undefined` when the route needs none.
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

  if (!hasCredential && options.placeholderCredential.length > 0) {
    if (protocol === 'openai-completions') {
      headers.authorization = `Bearer ${options.placeholderCredential}`;
    } else {
      headers['x-api-key'] = options.placeholderCredential;
    }
  }

  Object.assign(headers, options.headers);
  return Object.keys(headers).length === 0 ? undefined : headers;
}

/** Build one configured model entry. */
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

/** Resolve the reasoning fields one model entry carries. */
function resolveReasoning(
  model: DiscoveredModel,
  protocol: ApertureProtocol,
  configured: ConfiguredModel | undefined,
): Pick<PiAiModelProfile, 'reasoningEfforts' | 'compat'> {
  if (configured?.reasoningEfforts !== undefined) {
    return { reasoningEfforts: { ...configured.reasoningEfforts }, ...compatFor(model, protocol) };
  }
  if (!model.reasoning) {
    return {};
  }

  // The Anthropic transport drives thinking through a token budget rather than
  // an effort level, and the gateway's listing says nothing about which budget
  // an upstream accepts. So a discovered Anthropic model is left non-reasoning
  // unless a deployment states otherwise.
  if (protocol === 'anthropic-messages' && configured?.thinking !== true) {
    return {};
  }

  if (isDeepSeekFamily(model)) {
    // `off` must be non-null for the DeepSeek dialect: the adapter sends
    // `thinking: { type: "disabled" }` only when the level maps to a value.
    return { reasoningEfforts: { ...DEEPSEEK_EFFORTS }, ...compatFor(model, protocol) };
  }
  return { reasoningEfforts: { ...GENERIC_EFFORTS }, ...compatFor(model, protocol) };
}

/**
 * The compat block a reasoning model needs.
 *
 * pi-ai detects wire compatibility from the provider id and base URL, and an
 * Aperture URL says nothing to it, so the DeepSeek dialect has to be stated
 * outright. `supportsReasoningEffort` is stated too: a gateway whose URL pi-ai
 * cannot place defaults it to true today, but the switch is what actually makes
 * `reasoning_effort` travel, and a route should not depend on a default.
 *
 * @param model - the model being described.
 * @param protocol - the route's protocol.
 * @returns the compat block, or an empty object.
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
