import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SettingsPathOp, SettingsProvider } from '@deepseek-ai/dsh-settings';
import type { RoutePlan } from '../src/profile.ts';
import { applySync, clearRoutes, deepEqualJson, planSync } from '../src/sync.ts';

/** 一条计划中的路由，其 profile 可被轻易识别。 */
function routePlan(provider: string, marker: string): RoutePlan {
  return {
    provider,
    profile: { displayName: provider, api: 'openai-completions', baseURL: `https://x/${marker}`, models: [{ id: 'm' }] },
    models: [],
  };
}

const OWNED = ['aperture', 'aperture-anthropic'];

describe('deepEqualJson', () => {
  it('忽略键的顺序', () => {
    assert.equal(deepEqualJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true);
  });

  it('区分不同的结构', () => {
    assert.equal(deepEqualJson({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(deepEqualJson([1, 2], [2, 1]), false);
    assert.equal(deepEqualJson(null, {}), false);
    assert.equal(deepEqualJson({ a: undefined }, {}), true);
  });
});

describe('planSync', () => {
  it('把两个路由写入空的配置段', () => {
    const ops = planSync({ providers: {} }, [routePlan('aperture', 'a'), routePlan('aperture-anthropic', 'b')], OWNED);
    assert.deepEqual(
      ops.map((op) => op.op),
      ['set', 'set'],
    );
    assert.deepEqual(ops[0]?.path, ['providers', 'aperture']);
  });

  it('当配置段已经一致时不写入任何内容', () => {
    const routes = [routePlan('aperture', 'a')];
    const ops = planSync({ providers: { aperture: routes[0]?.profile } }, routes, OWNED);
    assert.deepEqual(ops, []);
  });

  it('移除已不再拥有模型的路由', () => {
    const ops = planSync({ providers: { aperture: { models: [] } } }, [], OWNED);
    assert.deepEqual(ops, [{ op: 'unset', path: ['providers', 'aperture'] }]);
  });

  it('不触碰它不拥有的 provider', () => {
    const ops = planSync({ providers: { workbuddy: { api: 'openai-completions' } } }, [], OWNED);
    assert.deepEqual(ops, []);
  });

  it('当命名空间的值不是 provider 字典时不规划任何操作', () => {
    assert.deepEqual(planSync(undefined, [routePlan('aperture', 'a')], OWNED), []);
    assert.deepEqual(planSync({ providers: 7 }, [], OWNED), []);
  });
});

/** 一个记录写入、并能拒绝一个带版本号的设置服务。 */
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
  it('在 llm-pi-ai 命名空间未注册时给出说明', async () => {
    const { service } = fakeSettings(undefined);
    const outcome = await applySync(service, [routePlan('aperture', 'a')], OWNED);
    assert.equal(outcome.applied, false);
    assert.match(outcome.reason ?? '', /未注册/);
  });

  it('在配置段已处于同步状态时给出说明', async () => {
    const routes = [routePlan('aperture', 'a')];
    const { service } = fakeSettings({ providers: { aperture: routes[0]?.profile } });
    const outcome = await applySync(service, routes, OWNED);
    assert.equal(outcome.applied, false);
    assert.equal(outcome.reason, '已处于同步状态');
  });

  it('只写入一次计划', async () => {
    const { service, writes } = fakeSettings({ providers: {} });
    const outcome = await applySync(service, [routePlan('aperture', 'a')], OWNED);
    assert.equal(outcome.applied, true);
    assert.equal(writes.length, 1);
    assert.equal(outcome.ops, 1);
  });

  it('在另一个写入者改动了配置段时重试一次', async () => {
    const { service, writes } = fakeSettings({ providers: {} }, { conflictOnce: true });
    const outcome = await applySync(service, [routePlan('aperture', 'a')], OWNED);
    assert.equal(outcome.applied, true);
    assert.equal(writes.length, 1);
  });

  it('上报非冲突的拒绝', async () => {
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
  it('只移除它拥有的路由', async () => {
    const { service, writes } = fakeSettings({ providers: { aperture: {}, workbuddy: {}, 'aperture-anthropic': {} } });
    const outcome = await clearRoutes(service, OWNED);
    assert.equal(outcome.applied, true);
    assert.deepEqual(writes[0], [
      { op: 'unset', path: ['providers', 'aperture'] },
      { op: 'unset', path: ['providers', 'aperture-anthropic'] },
    ]);
  });

  it('当路由已不存在时报告无事可做', async () => {
    const { service } = fakeSettings({ providers: { workbuddy: {} } });
    const outcome = await clearRoutes(service, OWNED);
    assert.equal(outcome.applied, false);
    assert.equal(outcome.reason, '没有需要移除的路由');
  });
});
