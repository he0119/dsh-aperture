/**
 * The write stage: publish the plan into the `llm-pi-ai` settings section.
 *
 * The section belongs to another plugin — `@deepseek-ai/dsh-llm-pi-ai` — and
 * the settings seam has no ownership check, so writing it is permitted. It is
 * also the sanctioned mechanism rather than a workaround: the harness composes
 * the pi-ai adapter dormant and states that "which providers run is the user's
 * settings document". Discovery that produced anything else would have to
 * reimplement a wire protocol, and this plugin exists precisely because it does
 * not have to.
 *
 * Three properties make the write safe to repeat.
 *
 * It is a no-op when nothing changed, compared against the **resolved** section
 * rather than the raw one, so a deployment's own composition layer does not
 * look like drift.
 *
 * It writes only the route keys the plugin owns, with path-addressed ops, so
 * every other provider in the section survives untouched.
 *
 * It never runs from a failed discovery: an unreachable gateway keeps the
 * catalog that is already serving, because a refresh that deletes working
 * models on a transient network error is worse than one that does nothing.
 *
 * @module dsh-aperture/sync
 */

import type { SettingsPathOp, SettingsProvider } from '@deepseek-ai/dsh-settings';
import { PI_AI_NAMESPACE } from './namespaces.ts';
import type { RoutePlan } from './profile.ts';

/** The result of one publication attempt. */
export interface SyncOutcome {
  /** Whether a write was issued. */
  readonly applied: boolean;
  /** Number of path ops the write carried. */
  readonly ops: number;
  /** Route keys the plan published. */
  readonly routes: readonly string[];
  /** Why nothing was written, when nothing was. */
  readonly reason?: string;
}

/**
 * Compute the path ops that bring one section in line with a plan.
 *
 * @param current - the resolved `llm-pi-ai` value, or `undefined` when the
 *   namespace is not registered.
 * @param routes - the routes the plan wants to exist.
 * @param ownedRoutes - every route key this plugin owns, so a route that
 *   stopped having models is removed rather than left serving a stale catalog.
 * @returns the ops to apply; empty when the section already matches.
 */
export function planSync(
  current: unknown,
  routes: readonly RoutePlan[],
  ownedRoutes: readonly string[],
): SettingsPathOp[] {
  const providers = readProviders(current);
  // A section that cannot hold a provider dict is not one this plugin can plan
  // against: writing into it would create a shape the adapter refuses anyway.
  if (providers === undefined) {
    return [];
  }

  const ops: SettingsPathOp[] = [];
  const desired = new Map(routes.map((route) => [route.provider, route.profile]));

  for (const provider of ownedRoutes) {
    const profile = desired.get(provider);
    if (profile === undefined) {
      if (provider in providers) {
        ops.push({ op: 'unset', path: ['providers', provider] });
      }
      continue;
    }
    if (deepEqualJson(providers[provider], profile)) {
      continue;
    }
    ops.push({ op: 'set', path: ['providers', provider], value: profile });
  }

  return ops;
}

/**
 * Publish one plan into the `llm-pi-ai` section.
 *
 * @param settings - the settings service.
 * @param routes - the routes to publish.
 * @param ownedRoutes - every route key this plugin owns.
 * @returns what happened, including the reason when nothing was written.
 */
export async function applySync(
  settings: SettingsProvider,
  routes: readonly RoutePlan[],
  ownedRoutes: readonly string[],
): Promise<SyncOutcome> {
  const current = settings.get(PI_AI_NAMESPACE);
  if (current === undefined) {
    return {
      applied: false,
      ops: 0,
      routes: [],
      reason: `the "${PI_AI_NAMESPACE}" settings namespace is not registered; is @deepseek-ai/dsh-llm-pi-ai mounted?`,
    };
  }

  const providers = readProviders(current);
  if (providers === undefined) {
    return { applied: false, ops: 0, routes: [], reason: `the "${PI_AI_NAMESPACE}" section is not a provider dict` };
  }

  const ops = planSync(current, routes, ownedRoutes);
  if (ops.length === 0) {
    return { applied: false, ops: 0, routes: routes.map((route) => route.provider), reason: 'already in sync' };
  }

  try {
    await settings.mutate(PI_AI_NAMESPACE, ops, currentRevision(settings));
  } catch (error) {
    // A concurrent writer (the Models page, another process) moved the section
    // between the read and the write. One retry with a fresh revision is enough:
    // the ops are path-addressed, so re-planning cannot lose their edits.
    if (!isConflict(error)) {
      throw error;
    }
    const retryOps = planSync(settings.get(PI_AI_NAMESPACE), routes, ownedRoutes);
    if (retryOps.length === 0) {
      return { applied: false, ops: 0, routes: routes.map((route) => route.provider), reason: 'already in sync' };
    }
    await settings.mutate(PI_AI_NAMESPACE, retryOps, currentRevision(settings));
  }

  return { applied: true, ops: ops.length, routes: routes.map((route) => route.provider) };
}

/**
 * Withdraw every route this plugin owns from the section.
 * @param settings - the settings service.
 * @param ownedRoutes - the route keys to remove.
 * @returns what happened.
 */
export async function clearRoutes(settings: SettingsProvider, ownedRoutes: readonly string[]): Promise<SyncOutcome> {
  const current = settings.get(PI_AI_NAMESPACE);
  if (current === undefined) {
    return {
      applied: false,
      ops: 0,
      routes: [],
      reason: `the "${PI_AI_NAMESPACE}" settings namespace is not registered`,
    };
  }
  const providers = readProviders(current);
  if (providers === undefined) {
    return { applied: false, ops: 0, routes: [], reason: `the "${PI_AI_NAMESPACE}" section is not a provider dict` };
  }
  const ops: SettingsPathOp[] = [];
  for (const provider of ownedRoutes) {
    if (provider in providers) {
      ops.push({ op: 'unset', path: ['providers', provider] });
    }
  }
  if (ops.length === 0) {
    return { applied: false, ops: 0, routes: [], reason: 'no routes to remove' };
  }
  await settings.mutate(PI_AI_NAMESPACE, ops, currentRevision(settings));
  return { applied: true, ops: ops.length, routes: [] };
}

/** Read the provider dict out of a resolved section value. */
function readProviders(current: unknown): Record<string, unknown> | undefined {
  if (current === null || typeof current !== 'object') {
    return undefined;
  }
  const providers = (current as { providers?: unknown }).providers;
  // An absent key is an empty dict: the adapter's schema defaults it, so a
  // section that has never carried a provider is exactly the expected state.
  if (providers === undefined) {
    return {};
  }
  return providers !== null && typeof providers === 'object' && !Array.isArray(providers)
    ? (providers as Record<string, unknown>)
    : undefined;
}

/** The current revision of the pi-ai section, when the provider exposes one. */
function currentRevision(settings: SettingsProvider): number | undefined {
  try {
    return settings.describe().find((descriptor) => descriptor.ns === PI_AI_NAMESPACE)?.revision;
  } catch {
    return undefined;
  }
}

/** Whether one throwable is the settings seam's stale-revision conflict. */
function isConflict(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT';
}

/**
 * Structural JSON equality.
 *
 * Written out rather than imported because the values compared here are
 * exactly JSON: a profile this plugin generated and the profile the settings
 * seam resolved back out of the document. Key order is not part of that
 * identity, so it is normalized away.
 *
 * @param left - one JSON value.
 * @param right - the other.
 * @returns whether the two are structurally equal.
 */
export function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => deepEqualJson(value, right[index]));
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => key in rightRecord && deepEqualJson(leftRecord[key], rightRecord[key]));
}
