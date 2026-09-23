/**
 * The discovery runtime: one refresh at a time, one remembered outcome.
 *
 * Refreshes come from four directions — plugin load, a settings change, the
 * refresh interval, and the `/aperture` command — and two of them can easily
 * overlap, because a settings change committed by this plugin's own write wakes
 * the same watcher that triggered the write. So refreshes are single-flight:
 * a request that arrives mid-refresh records itself as the next run instead of
 * starting a second one, and the loop re-runs once with the newest
 * configuration.
 *
 * The remembered outcome is what `/aperture` reports. It is deliberately not a
 * cache of the catalog: the catalog lives in the settings document, which is
 * what actually serves requests.
 *
 * @module dsh-aperture/runtime
 */

import type { SettingsProvider } from '@deepseek-ai/dsh-settings';
import { fetchModelsListing } from './aperture.ts';
import { ModelCatalog, type CatalogLoad } from './catalog.ts';
import { PI_AI_NAMESPACE, type ResolvedConfig } from './config.ts';
import { buildProfilePlan, type ProfilePlan, type RoutePlan } from './profile.ts';
import { buildRegistry } from './registry.ts';
import { applySync, clearRoutes, type SyncOutcome } from './sync.ts';
import type { DiscoveredModel } from './types.ts';

/** Minimal logging surface the runtime writes diagnostics through. */
export interface RuntimeLogger {
  error(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  debug(message: string, ...rest: unknown[]): void;
}

/** One completed refresh. */
export interface RefreshOutcome {
  /** What asked for this refresh. */
  readonly trigger: string;
  /** Whether discovery and publication both succeeded. */
  readonly ok: boolean;
  /** When it finished. */
  readonly at: Date;
  /** How long it took. */
  readonly durationMs: number;
  /** The URL that answered, when one did. */
  readonly endpoint?: string;
  /** Number of model rows the gateway listed. */
  readonly listed: number;
  /** Every normalized model. */
  readonly models: readonly DiscoveredModel[];
  /** The routes the plan published. */
  readonly routes: readonly RoutePlan[];
  /** Models no route can serve. */
  readonly unserved: readonly DiscoveredModel[];
  /** What the catalog contributed. */
  readonly catalog: CatalogLoad;
  /** What the settings write did, when one was attempted. */
  readonly sync?: SyncOutcome;
  /** The failure, when the refresh failed. */
  readonly error?: string;
}

/** Everything the runtime reads from its host. */
export interface RuntimeDeps {
  /** The currently authoritative configuration. */
  readonly config: () => ResolvedConfig;
  /** The settings service, once it exists. */
  readonly settings: () => SettingsProvider | undefined;
  /** Named logger. */
  readonly logger: RuntimeLogger;
  /** models.dev cache, shared across refreshes. */
  readonly catalog: ModelCatalog;
}

/** Single-flight discovery and publication. */
export class ApertureRuntime {
  private readonly deps: RuntimeDeps;
  private running: Promise<RefreshOutcome> | undefined;
  private queued: string | undefined;
  private latest: RefreshOutcome | undefined;

  /**
   * @param deps - host services and the configuration thunk.
   */
  constructor(deps: RuntimeDeps) {
    this.deps = deps;
  }

  /** The most recent completed refresh, when one has completed. */
  last(): RefreshOutcome | undefined {
    return this.latest;
  }

  /**
   * Refresh, or queue a refresh behind the one already running.
   * @param trigger - what asked; reported by `/aperture`.
   * @returns the outcome of the refresh this call participated in.
   */
  async refresh(trigger: string): Promise<RefreshOutcome> {
    if (this.running !== undefined) {
      this.queued = trigger;
      return this.running;
    }
    this.running = this.run(trigger);
    try {
      return await this.running;
    } finally {
      this.running = undefined;
      const queued = this.queued;
      this.queued = undefined;
      if (queued !== undefined) {
        void this.refresh(queued);
      }
    }
  }

  /**
   * Withdraw this plugin's routes from the settings document.
   * @returns a human-readable result for the command surface.
   */
  async remove(): Promise<string> {
    const settings = this.deps.settings();
    if (settings === undefined) {
      return 'the settings service is not mounted; nothing to remove';
    }
    const config = this.deps.config();
    const owned = [config.route, config.anthropicRoute];
    try {
      const outcome = await clearRoutes(settings, owned);
      return outcome.applied
        ? `removed ${outcome.ops} route(s) from the "${PI_AI_NAMESPACE}" section: ${owned.join(', ')}`
        : `nothing removed: ${outcome.reason ?? 'unknown reason'}`;
    } catch (error) {
      return `removing the routes failed: ${message(error)}`;
    }
  }

  /** One refresh, never throwing. */
  private async run(trigger: string): Promise<RefreshOutcome> {
    const started = Date.now();
    const at = new Date();
    try {
      return await this.execute(trigger, started, at);
    } catch (error) {
      // Nothing above may reject: every caller is a fire-and-forget `void`, and
      // an unhandled rejection inside the host's loader is not an acceptable
      // way to report a bad catalog.
      const outcome: RefreshOutcome = {
        trigger,
        ok: false,
        at,
        durationMs: Date.now() - started,
        listed: 0,
        models: [],
        routes: [],
        unserved: [],
        catalog: { entries: 0, reason: 'not reached' },
        error: message(error),
      };
      this.latest = outcome;
      this.deps.logger.warn('refresh failed: %s', outcome.error ?? '');
      return outcome;
    }
  }

  /** The body of one refresh. */
  private async execute(trigger: string, started: number, at: Date): Promise<RefreshOutcome> {
    const config = this.deps.config();

    if (config.instanceRoot === undefined) {
      const outcome: RefreshOutcome = {
        trigger,
        ok: false,
        at,
        durationMs: Date.now() - started,
        listed: 0,
        models: [],
        routes: [],
        unserved: [],
        catalog: { entries: 0, reason: 'not attempted' },
        error: config.rawBaseUrl.length === 0 ? 'no baseUrl is configured' : `baseUrl "${config.rawBaseUrl}" is not a usable URL`,
      };
      this.latest = outcome;
      return outcome;
    }

    const catalog = await this.deps.catalog.load(config.modelMetadataUrl, config.timeoutMs);

    let listed: readonly unknown[];
    let endpoint: string;
    try {
      const listing = await fetchModelsListing(config.instanceRoot, { timeoutMs: config.timeoutMs });
      listed = listing.entries;
      endpoint = listing.endpoint;
    } catch (error) {
      const outcome: RefreshOutcome = {
        trigger,
        ok: false,
        at,
        durationMs: Date.now() - started,
        listed: 0,
        models: [],
        routes: [],
        unserved: [],
        catalog,
        error: message(error),
      };
      this.latest = outcome;
      // A failed refresh publishes nothing: the catalog already in the settings
      // document keeps serving, which a transient network error must not undo.
      this.deps.logger.warn('discovery failed; keeping the published catalog: %s', outcome.error ?? '');
      return outcome;
    }

    const registry = buildRegistry(
      listed,
      {
        models: config.models,
        enabledModelIds: config.enabledModelIds,
        modelAliases: config.modelAliases,
        defaultContextWindow: config.defaultContextWindow,
        images: config.images,
        reasoning: config.reasoning,
      },
      catalog.lookup,
    );

    const plan = buildProfilePlan(registry.models, {
      instanceRoot: config.instanceRoot,
      route: config.route,
      anthropicRoute: config.anthropicRoute,
      displayName: config.displayName,
      anthropicDisplayName: config.anthropicDisplayName,
      ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
      headers: config.headers,
      placeholderCredential: config.placeholderCredential,
      configured: config.models,
    });

    const sync = await this.publish(config, plan);
    const outcome: RefreshOutcome = {
      trigger,
      ok: true,
      at,
      durationMs: Date.now() - started,
      endpoint,
      listed: listed.length,
      models: registry.models,
      routes: plan.routes,
      unserved: plan.unserved,
      catalog,
      ...(sync === undefined ? {} : { sync }),
    };
    this.latest = outcome;

    this.deps.logger.info(
      'discovered %d model(s) from %s; published %d route(s)%s',
      registry.models.length,
      endpoint,
      plan.routes.length,
      sync?.applied === true ? '' : ` (${sync?.reason ?? 'not written'})`,
    );
    return outcome;
  }

  /** Write the plan, or explain why nothing was written. */
  private async publish(config: ResolvedConfig, plan: ProfilePlan): Promise<SyncOutcome | undefined> {
    if (!config.sync) {
      return { applied: false, ops: 0, routes: [], reason: 'sync is disabled' };
    }
    const settings = this.deps.settings();
    if (settings === undefined) {
      return { applied: false, ops: 0, routes: [], reason: 'the settings service is not mounted' };
    }
    try {
      return await applySync(settings, plan.routes, plan.ownedRoutes);
    } catch (error) {
      this.deps.logger.warn('publishing the discovered catalog failed: %s', message(error));
      return { applied: false, ops: 0, routes: [], reason: message(error) };
    }
  }
}

/** Render an unknown throwable as a one-line reason. */
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
