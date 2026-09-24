/**
 * 配置页背后的三个端点。
 *
 * 配置页本身在浏览器里，无法在这里执行；能在这里钉住的是它依赖的那份契约：报告是结构化数据
 * （哪个模型属于哪条路由、每条事实来自哪里、用户写了哪些覆盖），刷新用界面这个来源触发，
 * 模型参数写进 `aperture` 段并带上版本号、按字段合并且非法值在写入前就被挡下来，并且三个端点
 * 都不抛异常——失败是要显示的结果，不是要分辨的 rejection。
 *
 * 地址与同步开关不在这份契约里：那两项由配置页交给页主递来的设置表单（`form.mutate`），
 * 版本校验与冲突恢复都是设置接缝自己的事（浏览器半边的用例在 `test/client.test.ts`）。
 *
 * @module dsh-aperture/test/panel
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SettingsForms, SettingsPathOp } from '@deepseek-ai/dsh-settings';
import type { ModelCatalog } from '../src/catalog.ts';
import { memoizedConfig, resolveConfig, type Config } from '../src/config.ts';
import { createPanelOps, type PanelDeps, type PanelModelPatch } from '../src/panel.ts';
import type { RoutePlan } from '../src/profile.ts';
import { ApertureRuntime, type RefreshOutcome, type RuntimeLogger } from '../src/runtime.ts';
import type { DiscoveredModel } from '../src/types.ts';

/** 什么都不输出的 logger。 */
const quiet: RuntimeLogger = { error() {}, info() {}, warn() {}, debug() {} };

/** 一个已发现模型，其来源全写在报告行里。 */
function model(id: string): DiscoveredModel {
  return {
    id,
    name: id.toUpperCase(),
    protocol: 'openai-completions',
    endpoints: ['/v1/chat/completions'],
    contextWindow: 1_048_576,
    maxTokens: 384_000,
    input: ['text'],
    reasoning: false,
    provenance: { limits: 'aperture', reasoning: 'models.dev', input: 'config', name: 'models.dev' },
  };
}

/** 一条已发布的路由。 */
function routePlan(provider: string): RoutePlan {
  return {
    provider,
    profile: { displayName: provider, api: 'openai-completions', baseURL: 'https://ai.example.ts.net/v1', models: [{ id: 'm' }] },
    models: [model('m')],
  };
}

/** 一次已完成的刷新。 */
function outcome(overrides: Partial<RefreshOutcome> = {}): RefreshOutcome {
  const discovered = [model('deepseek-flash')];
  return {
    trigger: '加载',
    ok: true,
    at: new Date('2026-09-22T16:31:02.184Z'),
    durationMs: 412,
    endpoint: 'https://ai.example.ts.net/v1/models',
    listed: 1,
    models: discovered,
    routes: [{ ...routePlan('aperture'), models: discovered }],
    unserved: [],
    catalog: { entries: 422, lookup: () => undefined },
    ...overrides,
  };
}

/** 一次写入的完整记录。 */
interface Write {
  readonly ns: string;
  readonly ops: readonly SettingsPathOp[];
  readonly expectedRevision: number | undefined;
}

/** `aperture` 段在假设置里的样子。 */
interface FakeAperture {
  value?: unknown;
  user?: unknown;
  revision?: number;
}

/** 一个记录写入的设置服务。 */
function fakeSettings(
  value: unknown,
  options: { fail?: string; aperture?: FakeAperture } = {},
) {
  const writes: Write[] = [];
  let revision = 1;
  const service = {
    describe: () => [
      { ns: 'llm-pi-ai', revision, value },
      ...(options.aperture === undefined
        ? []
        : [{
          ns: 'aperture',
          revision: options.aperture.revision ?? 7,
          value: options.aperture.value,
          user: options.aperture.user,
        }]),
    ],
    mutate: async (ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> => {
      if (options.fail !== undefined) throw new Error(options.fail);
      writes.push({ ns, ops, expectedRevision });
      revision += 1;
    },
  };
  return { service: service as unknown as SettingsForms, writes };
}

/** 一个只记住触发的运行时替身。 */
function fakeRuntime(first?: RefreshOutcome, next?: RefreshOutcome) {
  const triggers: string[] = [];
  let latest = first;
  const runtime = {
    last: () => latest,
    refresh: async (trigger: string) => {
      triggers.push(trigger);
      if (next !== undefined) latest = next;
      // 真的运行时永远返回一份结果（刷新失败也是一种结果），替身也照此：没摆报告时给一次空的
      // 成功结果，好让只关心写入的用例不必先准备一份发现结果。`last()` 仍然可以是空的——那说的
      // 是「还一次都没刷新过」，与这次调用的结果不是一回事。
      return latest ?? outcome({ trigger, listed: 0, models: [], routes: [], unserved: [] });
    },
  };
  return { runtime: runtime as unknown as ApertureRuntime, triggers };
}

/**
 * 一个真的会落盘的设置服务替身。
 *
 * 两件事照真的来：`mutate` 把路径操作应用到 `aperture` 段上，并且**每次提交都换一份新的解析
 * 结果**（身份变了才是新版本，运行时靠它判断一轮刷新读的是不是此刻的配置）；通知也照真的来路
 * ——宿主半边监听 Loader 的 `loader/volatile-update` 来唤起刷新，这里把那个「该刷新了」交给
 * 调用方去接。
 *
 * @param options - `aperture` 段的起点。
 * @returns 设置服务、读当前配置段的 thunk，以及登记变更通知的地方。
 */
function liveSettings(options: { baseUrl?: string; models?: unknown[] } = {}) {
  let section: Record<string, unknown> = {
    baseUrl: options.baseUrl ?? 'https://ai.example.ts.net',
    route: 'aperture',
    anthropicRoute: 'aperture-anthropic',
    models: options.models ?? [],
  };
  let user: Record<string, unknown> = { models: section.models };
  let revision = 1;
  let notify: (() => void) | undefined;

  const service = {
    describe: () => [{ ns: 'aperture', revision, value: section, user }],
    mutate: async (_ns: string, ops: readonly SettingsPathOp[]): Promise<void> => {
      const next = { ...section };
      const nextUser = { ...user };
      for (const op of ops) {
        const [head, tail] = op.path;
        if (head === undefined) throw new Error('路径为空');
        // 这一条只走容量那条路：别的路径写错了就该响亮，而不是被替身悄悄放过。
        if (tail !== undefined) throw new Error(`替身不认识的路径：${op.path.join('.')}`);
        if (op.op === 'set') {
          next[head] = op.value;
          nextUser[head] = op.value;
        } else {
          delete next[head];
          delete nextUser[head];
        }
      }
      section = next;
      user = nextUser;
      revision += 1;
      notify?.();
    },
  };
  return {
    service: service as unknown as SettingsForms,
    source: (() => section) as () => Config,
    onChange: (fn: () => void) => {
      notify = fn;
    },
  };
}

/**
 * 组装端点。
 *
 * @param overrides - 覆盖某一项依赖（默认是「有报告、写入成功」的世界）。
 * @returns 端点与替身。
 */
function panel(overrides: Partial<PanelDeps> & {
  first?: RefreshOutcome;
  next?: RefreshOutcome;
  settingsValue?: unknown;
  settingsFail?: string;
  aperture?: FakeAperture;
} = {}) {
  const { runtime, triggers } = fakeRuntime(overrides.first, overrides.next);
  const { service, writes } = fakeSettings(overrides.settingsValue ?? { providers: {} }, {
    fail: overrides.settingsFail,
    aperture: overrides.aperture,
  });
  const ops = createPanelOps({
    runtime: overrides.runtime ?? runtime,
    config: overrides.config ?? (() => resolveConfig({ baseUrl: 'https://ai.example.ts.net', route: 'aperture' })),
    settings: overrides.settings ?? service,
  });
  return { ops, triggers, writes };
}

describe('panel.status', () => {
  it('在没有刷新过时如实说明', () => {
    const { ops } = panel();
    const report = ops.status();
    assert.equal(report.refresh, undefined);
    assert.deepEqual(report.routes, []);
    assert.deepEqual(report.models, []);
  });

  it('报告把发现过程决定了什么摆成数据', () => {
    const { ops } = panel({ first: outcome() });
    const report = ops.status();
    assert.equal(report.place, 'https://ai.example.ts.net');
    assert.deepEqual(report.routes, [{
      provider: 'aperture',
      api: 'openai-completions',
      baseURL: 'https://ai.example.ts.net/v1',
      models: 1,
    }]);
    assert.deepEqual(report.refresh, {
      trigger: '加载',
      at: '2026-09-22T16:31:02.184Z',
      durationMs: 412,
      ok: true,
      catalog: { available: true, entries: 422 },
      endpoint: { url: 'https://ai.example.ts.net/v1/models', listed: 1 },
    });

    const [first] = report.models;
    assert.equal(first?.id, 'deepseek-flash');
    assert.equal(first?.route, 'aperture');
    assert.equal(first?.protocol, 'openai-completions');
    assert.equal(first?.contextWindow, 1_048_576);
    assert.equal(first?.maxTokens, 384_000);
    assert.deepEqual(first?.input, ['text']);
    assert.equal(first?.reasoning, false);
    // 每条事实的来源就是这个配置页存在的理由，因此它必须在数据里。
    assert.deepEqual(first?.provenance, {
      limits: 'aperture',
      reasoning: 'models.dev',
      input: 'config',
      name: 'models.dev',
    });
  });

  it('「已覆盖」只看用户层写了哪些键：schema 补出来的空值不算，写过的别名算', () => {
    // 生效值里带着 schema 补出来的 `input: []`（没写的数组字段会被补成空数组）。它是「没写」，
    // 不是覆盖——把它当覆盖，界面上那颗「已覆盖」就会永远挂着：撤的时候发的是 `input: null`，
    // 而用户层里根本没有这个键。
    const materialized = { id: 'deepseek-flash', input: [], reasoningEfforts: {} };
    const { ops } = panel({
      first: outcome(),
      config: () => resolveConfig({
        baseUrl: 'https://ai.example.ts.net',
        route: 'aperture',
        models: [materialized],
        modelAliases: { 'deepseek-flash': 'deepseek/deepseek-v4-flash' },
      }),
      aperture: {
        value: { models: [materialized], modelAliases: { 'deepseek-flash': 'deepseek/deepseek-v4-flash' } },
        user: {
          models: [{ id: 'deepseek-flash', reasoningEfforts: {} }],
          modelAliases: { 'deepseek-flash': 'deepseek/deepseek-v4-flash' },
        },
      },
    });
    const [first] = ops.status().models;
    // `reasoningEfforts` 界面不编辑，但它确实写在用户层里；别名在另一张表，对界面是同一件事。
    assert.deepEqual(first?.overrideKeys, ['reasoningEfforts', 'alias']);
    assert.equal(first?.alias, 'deepseek/deepseek-v4-flash');
  });

  it('用户层写下的字段就是覆盖，值与默认相同也算', () => {
    const { ops } = panel({
      first: outcome(),
      aperture: {
        value: {},
        user: { models: [{ id: 'deepseek-flash', name: 'Flash', contextWindow: 8192, thinking: false }] },
      },
    });
    assert.deepEqual(ops.status().models[0]?.overrideKeys, ['name', 'contextWindow', 'thinking']);
  });

  it('用户层什么都没写过时，一行标签都不挂', () => {
    const { ops } = panel({ first: outcome() });
    assert.equal(ops.status().models[0]?.overrideKeys, undefined);
  });

  it('没有任何路由能服务的模型排在最后，并带上它通告的端点', () => {
    const routed = model('deepseek-flash');
    const unserved: DiscoveredModel = {
      id: 'gemini-2.5-flash',
      name: 'gemini-2.5-flash',
      endpoints: ['/v1beta/models/gemini-2.5-flash:generateContent'],
      input: ['text'],
      reasoning: false,
      provenance: { limits: 'aperture', reasoning: 'models.dev', input: 'config', name: 'models.dev' },
    };
    const { ops } = panel({
      first: outcome({
        models: [routed, unserved],
        routes: [{ ...routePlan('aperture'), models: [routed] }],
        unserved: [unserved],
      }),
    });
    const models = ops.status().models;
    assert.deepEqual(models.map((entry) => entry.id), ['deepseek-flash', 'gemini-2.5-flash']);
    assert.equal(models[1]?.route, undefined);
    assert.equal(models[1]?.protocol, undefined);
    assert.deepEqual(models[1]?.endpoints, ['/v1beta/models/gemini-2.5-flash:generateContent']);
  });
});

describe('panel.edit', () => {
  /** 一段有覆盖、也有别条目的 `aperture` 段。 */
  const section = {
    value: {
      models: [
        { id: 'other', api: 'anthropic-messages' },
        { id: 'deepseek-flash', reasoningEfforts: { low: 'low' } },
      ],
    },
    user: {},
    revision: 11,
  };

  it('把改动的字段合并进那一条，别的条目与界面不编辑的字段都不动', async () => {
    const { ops, writes } = panel({ aperture: section });
    const action = await ops.edit('deepseek-flash', { contextWindow: 8192, thinking: false });
    assert.equal(action.ok, true);
    assert.match(action.summary, /已保存 "deepseek-flash" 的参数/u);
    assert.equal(writes[0]?.ns, 'aperture');
    assert.equal(writes[0]?.expectedRevision, 11, '写入带上刚读到的版本号');
    assert.deepEqual(writes[0]?.ops, [{
      op: 'set',
      path: ['models'],
      value: [
        { id: 'other', api: 'anthropic-messages' },
        // `reasoningEfforts` 界面根本不编辑，因此它必须原样活着。
        { id: 'deepseek-flash', reasoningEfforts: { low: 'low' }, contextWindow: 8192, thinking: false },
      ],
    }]);
  });

  it('写入成功但重新发现失败时，那句话分开说', async () => {
    const { ops } = panel({
      first: outcome(),
      next: outcome({ ok: false, error: '网关不可达' }),
      aperture: section,
    });
    const action = await ops.edit('deepseek-flash', { contextWindow: 8192 });
    assert.equal(action.ok, true, '写入本身是成功的');
    assert.match(action.summary, /已保存 "deepseek-flash" 的参数/u);
    assert.match(action.summary, /但重新发现没有成功：网关不可达/u);
  });

  it('写回时剔掉 schema 补出来的空值，不把「没写」变成用户的覆盖', async () => {
    const { ops, writes } = panel({
      aperture: {
        value: { models: [{ id: 'deepseek-flash', input: [], reasoningEfforts: {} }] },
        user: { models: [{ id: 'deepseek-flash', reasoningEfforts: {} }] },
      },
    });
    await ops.edit('deepseek-flash', { contextWindow: 8192 });
    assert.deepEqual(writes[0]?.ops, [{
      op: 'set',
      path: ['models'],
      value: [{ id: 'deepseek-flash', contextWindow: 8192 }],
    }]);
  });

  it('改一条就是一次写入：另一个模型改不改与它无关', async () => {
    const { ops, writes } = panel({ aperture: section });
    await ops.edit('other', { maxTokens: 4096 });
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.ops, [{
      op: 'set',
      path: ['models'],
      value: [
        { id: 'other', api: 'anthropic-messages', maxTokens: 4096 },
        { id: 'deepseek-flash', reasoningEfforts: { low: 'low' } },
      ],
    }]);
  });

  it('改一条不会让它在数组里换位置：顺序来自发现顺序，不来自用户改过哪一条', async () => {
    const { ops, writes } = panel({
      aperture: { value: { models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, user: {} },
    });
    await ops.edit('b', { contextWindow: 2 });
    assert.deepEqual(writes[0]?.ops, [{
      op: 'set',
      path: ['models'],
      value: [{ id: 'a' }, { id: 'b', contextWindow: 2 }, { id: 'c' }],
    }]);

    // 新条目排在原来那些之后。
    const added = panel({ aperture: { value: { models: [{ id: 'a' }, { id: 'b' }] }, user: {} } });
    await added.ops.edit('c', { contextWindow: 2 });
    assert.deepEqual(added.writes[0]?.ops, [{
      op: 'set',
      path: ['models'],
      value: [{ id: 'a' }, { id: 'b' }, { id: 'c', contextWindow: 2 }],
    }]);
  });

  it('新的模型新增一条覆盖；只有别名时不去写一条空条目', async () => {
    const { ops, writes } = panel({ aperture: { value: { models: [] }, user: {} } });
    await ops.edit('deepseek-flash', { alias: 'deepseek/deepseek-v4-flash' });
    assert.deepEqual(writes[0]?.ops, [{
      op: 'set',
      path: ['modelAliases', 'deepseek-flash'],
      value: 'deepseek/deepseek-v4-flash',
    }]);
  });

  it('空字符串与 null 都是「这一项不覆盖」', async () => {
    const settings = () => ({
      aperture: { value: { models: [{ id: 'deepseek-flash', name: 'Flash', contextWindow: 8192 }] }, user: {} },
    });
    // 清掉一个字段：其余字段还在，于是这一条只是变短。
    const first = panel(settings());
    await first.ops.edit('deepseek-flash', { name: '  ' });
    assert.deepEqual(first.writes[0]?.ops, [{
      op: 'set',
      path: ['models'],
      value: [{ id: 'deepseek-flash', contextWindow: 8192 }],
    }]);

    // 清到没有字段：整条移除，而不是留下一条只有 id 的空覆盖。
    const second = panel(settings());
    await second.ops.edit('deepseek-flash', { name: null, contextWindow: null });
    assert.deepEqual(second.writes[0]?.ops, [{ op: 'set', path: ['models'], value: [] }]);
  });

  it('null 撤销这个模型的全部覆盖，含清单别名', async () => {
    const { ops, writes } = panel({
      aperture: {
        value: { models: [{ id: 'deepseek-flash', contextWindow: 8192 }], modelAliases: { 'deepseek-flash': 'x' } },
        user: { modelAliases: { 'deepseek-flash': 'x' } },
      },
    });
    const action = await ops.edit('deepseek-flash', null);
    assert.equal(action.ok, true);
    assert.match(action.summary, /已撤销 "deepseek-flash" 的全部覆盖/u);
    assert.deepEqual(writes[0]?.ops, [
      { op: 'set', path: ['models'], value: [] },
      { op: 'unset', path: ['modelAliases', 'deepseek-flash'] },
    ]);
  });

  it('逐个字段置空也是撤销：界面只清它认识的那些，别的手写字段活着', async () => {
    // 「撤销覆盖」按钮发的是这种补丁：报告里写着被覆盖过的字段逐个 `null`，因此
    // `reasoningEfforts` 这种界面不编辑的键不会被一起扔掉（`null` 补丁才会整条删掉）。
    const { ops, writes } = panel({
      aperture: {
        value: {
          models: [{ id: 'deepseek-flash', contextWindow: 8192, reasoningEfforts: { low: 'low' } }],
        },
        user: {},
      },
    });
    const action = await ops.edit('deepseek-flash', { contextWindow: null });
    assert.equal(action.ok, true);
    assert.deepEqual(writes[0]?.ops, [{
      op: 'set',
      path: ['models'],
      value: [{ id: 'deepseek-flash', reasoningEfforts: { low: 'low' } }],
    }]);
  });

  it('别名不是用户层写的就不去删它：删不存在的键要么白写、要么被当成坏路径', async () => {
    // 生效别名来自组合层（或清单），用户层没有这个键；同时改一个真要写的字段，
    // 好让「别名没有产生操作」这件事是在一次真实写入里被验证的。
    const { ops, writes } = panel({
      aperture: {
        value: {
          models: [{ id: 'deepseek-flash', contextWindow: 8192 }],
          modelAliases: { 'deepseek-flash': 'from-composition' },
        },
        user: {},
      },
    });
    const action = await ops.edit('deepseek-flash', { alias: '', contextWindow: 4096 });
    assert.equal(action.ok, true);
    assert.match(action.summary, /已保存/u);
    assert.deepEqual(writes[0]?.ops, [{
      op: 'set',
      path: ['models'],
      value: [{ id: 'deepseek-flash', contextWindow: 4096 }],
    }]);
  });

  it('没有任何改动时不写设置，也不算失败', async () => {
    const { ops, writes } = panel({ aperture: section });
    const action = await ops.edit('deepseek-flash', {});
    assert.equal(action.ok, true);
    assert.match(action.summary, /没有要保存的改动/u);
    assert.deepEqual(writes, []);
  });

  it('非法值在写入前就被挡下来：坏配置会让下一轮刷新直接抛异常', async () => {
    // 类型系统挡不住界面发来的坏值，运行时校验才是权威的，因此这里故意喂进去。
    const invalid: unknown[] = [
      { api: 'gemini-native' },
      { contextWindow: 0 },
      { contextWindow: 1.5 },
      { maxTokens: -1 },
      { input: ['audio'] },
    ];
    for (const patch of invalid) {
      const { ops, writes } = panel({ aperture: section });
      const action = await ops.edit('deepseek-flash', patch as PanelModelPatch);
      assert.equal(action.ok, false, `${JSON.stringify(patch)} 应当被拒绝`);
      assert.match(action.summary, /deepseek-flash/u, '说清楚是哪个模型被拒绝');
      assert.deepEqual(writes, [], `${JSON.stringify(patch)} 不该写进设置`);
    }
  });

  it('缺少 id 或缺少补丁时都不写入，而是说清楚', async () => {
    const blank = panel({ aperture: section });
    const action = await blank.ops.edit('   ', { contextWindow: 1 });
    assert.equal(action.ok, false);
    assert.match(action.summary, /缺少模型 id/u);
    assert.deepEqual(blank.writes, []);

    // `undefined` 不是「撤销」：撤销要用显式的 `null`。
    const missing = panel({ aperture: section });
    const nothing = await missing.ops.edit('deepseek-flash', undefined as unknown as null);
    assert.equal(nothing.ok, false);
    assert.match(nothing.summary, /缺少要写入的参数/u);
    assert.deepEqual(missing.writes, []);
  });

  it('写入被拒绝时返回失败原因', async () => {
    const { ops } = panel({ aperture: section, settingsFail: '设置文档刚被别人改过' });
    const action = await ops.edit('deepseek-flash', { contextWindow: 8192 });
    assert.equal(action.ok, false);
    assert.match(action.summary, /设置文档刚被别人改过/u);
  });
});

describe('panel.refresh', () => {
  it('用界面这个来源触发刷新，并带回一句结论', async () => {
    const { ops, triggers } = panel({ first: outcome(), next: outcome({ trigger: '设置界面', listed: 2 }) });
    const action = await ops.refresh();
    assert.deepEqual(triggers, ['设置界面']);
    assert.equal(action.ok, true);
    assert.match(action.summary, /已重新发现并发布/u);
    // 报告随之更新，配置页再读一次就能看到新一轮来源。
    assert.equal(ops.status().refresh?.trigger, '设置界面');
  });

  it('把失败当作结果而不是异常', async () => {
    const { ops } = panel({ first: outcome({ ok: false, error: '取不到清单：ECONNREFUSED' }) });
    const action = await ops.refresh();
    assert.equal(action.ok, false);
    assert.match(action.summary, /ECONNREFUSED/u);
  });
});

describe('写完等一轮刷新落地', () => {
  it('模型参数写完之后重读报告，拿到的是新配置算出来的那一份', async () => {
    const original = globalThis.fetch;
    // 让发现慢一拍：不等刷新的实现会在这里露出来——它返回时报告还是旧的那一份，而配置页
    // 拿到回答就会重读，于是「保存了却没变」。
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const store = liveSettings({ models: [{ id: 'm', contextWindow: 1000 }] });
      const config = memoizedConfig(store.source);
      const runtime = new ApertureRuntime({
        config,
        settings: store.service,
        logger: quiet,
        // 清单只报可用性：这一条看的不是 models.dev，而是配置里的覆盖。
        catalog: { load: async () => ({ entries: 0 }) } as unknown as ModelCatalog,
      });
      // 照 `index.ts` 的接法：配置一变就唤起一轮刷新（宿主那边是 Loader 的
      // `loader/volatile-update`）。
      store.onChange(() => void runtime.refresh('配置变更'));
      const ops = createPanelOps({ runtime, config, settings: store.service });

      await ops.refresh();
      assert.equal(ops.status().models[0]?.contextWindow, 1000, '第一轮读的是旧配置');

      await ops.edit('m', { contextWindow: 2000 });
      assert.equal(ops.status().models[0]?.contextWindow, 2000);
    } finally {
      globalThis.fetch = original;
    }
  });
});
