import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SettingsPathOp, SettingsProvider } from '@deepseek-ai/dsh-settings';
import type { RoutePlan } from '../src/profile.ts';
import { applySync, clearRoutes, deepEqualJson, planSync } from '../src/sync.ts';

/** One planned route with a trivially recognizable profile. */
function routePlan(provider: string, marker: string): RoutePlan {
  return {
    provider,
    profile: { displayName: provider, api: 'openai-completions', baseURL: `https://x/${marker}`, models: [{ id: 'm' }] },
    models: [],
  };
}

const OWNED = ['aperture', 'aperture-anthropic'];

describe('deepEqualJson', () => {
  it('ignores key order', () => {
    assert.equal(deepEqualJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true);
  });

  it('separates different shapes', () => {
    assert.equal(deepEqualJson({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(deepEqualJson([1, 2], [2, 1]), false);
    assert.equal(deepEqualJson(null, {}), false);
    assert.equal(deepEqualJson({ a: undefined }, {}), true);
  });
});

describe('planSync', () => {
  it('writes both routes into an empty section', () => {
    const ops = planSync({ providers: {} }, [routePlan('aperture', 'a'), routePlan('aperture-anthropic', 'b')], OWNED);
    assert.deepEqual(
      ops.map((op) => op.op),
      ['set', 'set'],
    );
    assert.deepEqual(ops[0]?.path, ['providers', 'aperture']);
  });

  it('writes nothing when the section already matches', () => {
    const routes = [routePlan('aperture', 'a')];
    const ops = planSync({ providers: { aperture: routes[0]?.profile } }, routes, OWNED);
    assert.deepEqual(ops, []);
  });

  it('removes a route that stopped having models', () => {
    const ops = planSync({ providers: { aperture: { models: [] } } }, [], OWNED);
    assert.deepEqual(ops, [{ op: 'unset', path: ['providers', 'aperture'] }]);
  });

  it('leaves providers it does not own untouched', () => {
    const ops = planSync({ providers: { workbuddy: { api: 'openai-completions' } } }, [], OWNED);
    assert.deepEqual(ops, []);
  });

  it('plans nothing when the namespace value is not a provider dict', () => {
    assert.deepEqual(planSync(undefined, [routePlan('aperture', 'a')], OWNED), []);
    assert.deepEqual(planSync({ providers: 7 }, [], OWNED), []);
  });
});

/** A settings service that records writes and can refuse one revision. */
function fakeSettings(value: unknown, options: { conflictOnce?: boolean } = {}) {
  const writes: Array<readonly SettingsPathOp[]> = [];
  let revision = 1;
  let conflict = options.conflictOnce ?? false;
  let current = value;
  const service = {
    get: () => current,
    describe: () => [{ ns: 'llm-pi-ai', revision }],
    mutate: async (_ns: string, ops: readonly SettingsPathOp[]): Promise<void> => {
      if (conflict) {
        conflict = false;
        revision += 1;
        const error = new Error('stale revision') as Error & { code: string };
        error.code = 'SETTINGS_CONFLICT';
        throw error;
      }
      writes.push(ops);
      current = { providers: Object.fromEntries(ops.flatMap((op) => (op.op === 'set' ? [[op.path[1]!, op.value]] : []))) };
      revision += 1;
    },
  };
  return { service: service as unknown as SettingsProvider, writes };
}

describe('applySync', () => {
  it('explains itself when the pi-ai namespace is not registered', async () => {
    const { service } = fakeSettings(undefined);
    const outcome = await applySync(service, [routePlan('aperture', 'a')], OWNED);
    assert.equal(outcome.applied, false);
    assert.match(outcome.reason ?? '', /not registered/);
  });

  it('explains itself when the section is already in sync', async () => {
    const routes = [routePlan('aperture', 'a')];
    const { service } = fakeSettings({ providers: { aperture: routes[0]?.profile } });
    const outcome = await applySync(service, routes, OWNED);
    assert.equal(outcome.applied, false);
    assert.equal(outcome.reason, 'already in sync');
  });

  it('writes the plan once', async () => {
    const { service, writes } = fakeSettings({ providers: {} });
    const outcome = await applySync(service, [routePlan('aperture', 'a')], OWNED);
    assert.equal(outcome.applied, true);
    assert.equal(writes.length, 1);
    assert.equal(outcome.ops, 1);
  });

  it('retries once when another writer moved the section', async () => {
    const { service, writes } = fakeSettings({ providers: {} }, { conflictOnce: true });
    const outcome = await applySync(service, [routePlan('aperture', 'a')], OWNED);
    assert.equal(outcome.applied, true);
    assert.equal(writes.length, 1);
  });

  it('surfaces a refusal that is not a conflict', async () => {
    const service = {
      get: () => ({ providers: {} }),
      describe: () => [{ ns: 'llm-pi-ai', revision: 1 }],
      mutate: async (): Promise<void> => {
        throw new Error('model "x" has an empty reasoningEfforts');
      },
    } as unknown as SettingsProvider;
    await assert.rejects(() => applySync(service, [routePlan('aperture', 'a')], OWNED), /empty reasoningEfforts/);
  });
});

describe('clearRoutes', () => {
  it('removes exactly the routes it owns', async () => {
    const { service, writes } = fakeSettings({ providers: { aperture: {}, workbuddy: {}, 'aperture-anthropic': {} } });
    const outcome = await clearRoutes(service, OWNED);
    assert.equal(outcome.applied, true);
    assert.deepEqual(writes[0], [
      { op: 'unset', path: ['providers', 'aperture'] },
      { op: 'unset', path: ['providers', 'aperture-anthropic'] },
    ]);
  });

  it('reports nothing to do when the routes are already absent', async () => {
    const { service } = fakeSettings({ providers: { workbuddy: {} } });
    const outcome = await clearRoutes(service, OWNED);
    assert.equal(outcome.applied, false);
    assert.equal(outcome.reason, 'no routes to remove');
  });
});
