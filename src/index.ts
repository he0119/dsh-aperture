/**
 * dsh-aperture: discover the models an Aperture gateway serves, and publish
 * them to DeepSeek Harness as `llm-pi-ai` provider routes.
 *
 * Aperture is Tailscale's centralized LLM gateway: one endpoint in front of
 * every upstream a team is entitled to, authenticated by network identity
 * rather than by key. The harness can already *talk* to such a gateway — the
 * `dsh-llm-pi-ai` adapter speaks OpenAI-compatible Chat Completions and
 * Anthropic Messages, which is all Aperture exposes — but nothing makes the
 * catalog refresh itself: the adapter's own "fetch available models" action
 * adopts one draft the user is still editing, and its documented limitation is
 * that "a route's catalog never refreshes itself".
 *
 * This plugin is that missing half. It reads `GET {baseUrl}/v1/models`, decides
 * per model which protocol the gateway actually serves it on, sizes and
 * describes it from the gateway's own fields plus models.dev, and writes the
 * result into `llm-pi-ai`'s provider dictionary — the document the harness
 * itself calls the thing that decides which providers run.
 *
 * It converts no wire format. That is the point.
 *
 * ```yaml
 * - id: aperture
 *   name: 'dsh-aperture'
 *   config:
 *     baseUrl: https://ai.example.ts.net
 * ```
 *
 * @module dsh-aperture
 */

import type { Context } from '@deepseek-ai/cordis';
import type { SettingsProvider } from '@deepseek-ai/dsh-settings';
import { fetchModelsListing } from './aperture.ts';
import { ModelCatalog } from './catalog.ts';
import { registerApertureCommand } from './command.ts';
import { APERTURE_NAMESPACE, Config as ConfigSchema, resolveConfig, type Config } from './config.ts';
import { buildProfilePlan } from './profile.ts';
import { buildRegistry, classifyProtocol } from './registry.ts';
import { ApertureRuntime, message, type RuntimeLogger } from './runtime.ts';

export { fetchModelsListing } from './aperture.ts';
export type { ModelsListing } from './aperture.ts';
export { ModelCatalog } from './catalog.ts';
export {
  APERTURE_NAMESPACE,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL_METADATA_URL,
  PI_AI_NAMESPACE,
  resolveConfig,
} from './config.ts';
export type { Config as ApertureConfig, ResolvedConfig } from './config.ts';
export { DEFAULT_PLACEHOLDER_CREDENTIAL, buildProfilePlan } from './profile.ts';
export type { ProfilePlan, ProfileOptions, RoutePlan } from './profile.ts';
export { buildRegistry, classifyProtocol, isDeepSeekFamily } from './registry.ts';
export type { RegistryResult } from './registry.ts';
export { applySync, clearRoutes, planSync } from './sync.ts';
export type { SyncOutcome } from './sync.ts';
export type { ConfiguredModel, DiscoveredModel, FactSource, Modality, ModelProvenance } from './types.ts';
export { buildModelsEndpoint, buildRouteBaseUrl, normalizeBaseUrl } from './url.ts';
export { Config } from './config.ts';

/** Plugin name used in loader diagnostics. */
export const name = 'dsh-aperture';

/**
 * No service is required to load: discovery works from the composition
 * configuration alone, and both services it *uses* — `settings` and
 * `commands` — are optional and resolved with `ctx.inject`.
 */
export const inject: string[] = [];

/**
 * Publish the gateway's catalog, now and whenever anything changes.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved `aperture` configuration section.
 * @throws Error when the configuration is self-inconsistent (a malformed or
 *   duplicated route key), which no later write could repair.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger as RuntimeLogger;
  const catalog = new ModelCatalog();
  let resolved = resolveConfig(config);
  let settings: SettingsProvider | undefined;

  const runtime = new ApertureRuntime({
    config: () => resolved,
    settings: () => settings,
    logger,
    catalog,
  });

  // The refresh interval is re-armed on every configuration change rather than
  // captured once, so a deployment can turn periodic refresh on or off in the
  // settings document without restarting.
  let timer: ReturnType<typeof setInterval> | undefined;
  const armInterval = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    if (resolved.refreshIntervalMinutes > 0) {
      timer = setInterval(() => void runtime.refresh('interval'), resolved.refreshIntervalMinutes * 60_000);
      timer.unref?.();
    }
  };
  ctx.effect(
    () => {
      armInterval();
      return () => {
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    'aperture refresh interval',
  );

  logger.info(
    'dsh-aperture: %s',
    resolved.instanceRoot === undefined
      ? 'no usable baseUrl yet; discovery is dormant'
      : `watching ${resolved.instanceRoot} for models`,
  );

  // Runs with the composition configuration. When the settings service is
  // mounted, its own attach notification refreshes again with the user layer
  // applied; that second pass compares against what this one published and
  // writes nothing when they agree.
  void runtime.refresh('load');

  ctx.inject(['settings'], (settingsCtx) => {
    settings = settingsCtx.settings;
    try {
      settingsCtx.settings.installSection(ctx, APERTURE_NAMESPACE, ConfigSchema, config, {
        setSource(current) {
          resolved = resolveConfig(current());
          armInterval();
        },
        onChange() {
          void runtime.refresh('settings');
        },
        validate(value) {
          resolveConfig(value);
        },
      });
    } catch (error) {
      logger.error('dsh-aperture: the "aperture" settings section was refused: %s', message(error));
    }
  });

  ctx.inject(['commands'], (commandCtx) => {
    registerApertureCommand(commandCtx, runtime, () => resolved);
  });
}
