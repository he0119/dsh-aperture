/**
 * 插件入口的接线。
 *
 * `apply` 里没有算法，只有「跟宿主约定了什么」：过期重算的刷新间隔、配置变更那一件事、设置
 * 页的归属声明、以及只有装配了 Typert 网关的 profile 才有的配置页半边。这些约定全都只以副作用
 * 的形式存在（effect、事件、注入、挂服务），没有它们，本插件在真实宿主里要么不刷新、要么在
 * 设置页上多出一个没人要的通用表单、要么在 headless profile 里连发现都不跑。
 *
 * 因此这里钉住的是**登记了什么**，而不是等待它发生：`ctx` 是一个把每次调用都记下来的替身，
 * `setInterval`/`clearInterval` 被换成记账的替身（时间因此不需要真的流逝，也不会留下定时器），
 * `fetch` 被换掉（发现那一轮真的跑，但一个请求也不发出去）。`src/index.ts` 里读不到的部分——
 * 真 Cordis 的纤维状态机与注入时序——由替身替下，测试只断言插件自己的行为。
 *
 * @module dsh-aperture/test/index
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings';
import { Config, type ConfigRef, type FilledConfig } from '../src/config.ts';
import { apply } from '../src/index.ts';
import type { PanelOps } from '../src/panel.ts';
import type { PanelReport } from '../src/report.ts';
import { AperturePanelService, PANEL_CONTRIBUTION } from '../src/remote.ts';

/** 一个端点 URL，用来验证那一轮发现真的发出去了。 */
const MODELS_ENDPOINT = 'https://ai.example.ts.net/v1/models';

/** 一次 `ctx.effect` 的登记。 */
interface EffectRecord {
  /** 诊断用的标签，也是「这个 effect 是干什么的」唯一可读的来源。 */
  readonly label: string;
  /** 回调交给 Cordis 的清理函数（如果它返回了的话）。 */
  readonly dispose: unknown;
}

/** 一条日志。 */
interface LogRecord {
  readonly level: 'error' | 'info' | 'warn' | 'debug';
  readonly args: readonly unknown[];
}

/** 一次 `ctx.plugin` 的登记，连同它发生在哪一层上下文上。 */
interface PluginRecord {
  readonly via: 'root' | 'panel';
  readonly service: unknown;
  readonly ops: unknown;
}

/** 假上下文里记下来的全部东西。 */
interface Harness {
  readonly ctx: Context;
  readonly fiber: unknown;
  /** 根上下文上的 effect，按登记顺序。 */
  readonly effects: readonly EffectRecord[];
  /** 面板子上下文上的 effect，按登记顺序。 */
  readonly panelEffects: readonly EffectRecord[];
  /** 事件名 → 监听者。 */
  readonly handlers: ReadonlyMap<string, ReadonlyArray<() => void>>;
  /** `ctx.inject` 收到的依赖声明，按登记顺序。 */
  readonly injections: ReadonlyArray<readonly string[]>;
  /** `typert.register` 收到的贡献。 */
  readonly contributions: readonly unknown[];
  /** `ctx.plugin` 收到的服务与 ops。 */
  readonly plugins: readonly PluginRecord[];
  /** `settings.configure` 收到的呈现策略与归属。 */
  readonly presentations: ReadonlyArray<{ readonly presentation: unknown; readonly owner: unknown }>;
  /** 全部日志。 */
  readonly logs: readonly LogRecord[];
  /** 触发一个事件，把它的监听者跑一遍。 */
  emit(event: string): void;
}

/**
 * 一份「活的」配置引用。
 *
 * `get()` 一直返回同一个对象时就是同一份配置；`update` 换的是一个**新**对象，那才是新版本——
 * 这正是 `memoizedConfig` 与运行时单飞判定所依赖的约定（见 `src/config.ts`）。值本身由真的
 * `Config` schema 补齐缺省，因此这里只负责「活」的那一半，不是另写一套配置默认值。
 *
 * @param overrides - 覆盖在缺省值之上的配置段字段。
 * @returns 配置引用与换值的方法。
 */
function liveConfig(overrides: Config = {}): { ref: ConfigRef; update(next: Config): void } {
  const filled = (patch: Config): FilledConfig =>
    Config({ baseUrl: 'https://ai.example.ts.net', modelMetadataUrl: '', ...patch }).get() as FilledConfig;
  let current = filled(overrides);
  return {
    ref: { get: () => current } as unknown as ConfigRef,
    update(next: Config): void {
      current = filled({ ...current, ...next });
    },
  };
}

/**
 * 一个把每次调用都记下来的插件上下文。
 *
 * `effect` 的回调当场执行：真 Cordis 也是当场执行、当场收下清理函数，因此「登记了什么」与
 * 「卸载时会撤掉什么」都能在这里看见。`inject` 则按同一份约定分两种世界——依赖在场时回调跑，
 * 缺席时一次都不跑（真 Cordis 就是这么等着的）。
 *
 * @param options - `typert` 表示这一次注入会不会兑现。
 * @returns 假上下文与它的账本。
 */
function harness(options: { readonly typert?: boolean } = {}): Harness {
  const effects: EffectRecord[] = [];
  const panelEffects: EffectRecord[] = [];
  const handlers = new Map<string, Array<() => void>>();
  const injections: Array<readonly string[]> = [];
  const contributions: unknown[] = [];
  const plugins: PluginRecord[] = [];
  const presentations: Array<{ presentation: unknown; owner: unknown }> = [];
  const logs: LogRecord[] = [];
  /** 假的纤维：只用来验证 `configure` 的归属是不是插件自己那一个。 */
  const fiber = { name: '假的 fiber' };

  const effect = (execute: () => unknown, label = 'anonymous'): void => {
    effects.push({ label, dispose: execute() });
  };
  const log = (level: LogRecord['level']) =>
    (...args: unknown[]): void => {
      logs.push({ level, args });
    };

  // 注入兑现时交给回调用的是一个派生子上下文：它继承父上下文的账本，另外多出 `typert` 与
  // `plugin` 两项——插件半边正是靠这两项把配置页挂上去的。
  const panelCtx = {
    effect: (execute: () => unknown, label = 'anonymous'): void => {
      panelEffects.push({ label, dispose: execute() });
    },
    typert: {
      register: (contribution: unknown): (() => void) => {
        contributions.push(contribution);
        return () => {};
      },
    },
    plugin: (service: unknown, ops: unknown): void => {
      plugins.push({ via: 'panel', service, ops });
    },
  };

  const settings = {
    writable: true,
    describe: (): SettingsDescriptor[] => [],
    mutate: async (_ns: string, _ops: readonly SettingsPathOp[]): Promise<void> => {},
    configure: (presentation: unknown, owner: unknown): (() => void) => {
      presentations.push({ presentation, owner });
      return () => {};
    },
  };

  const ctx = {
    logger: { error: log('error'), info: log('info'), warn: log('warn'), debug: log('debug') },
    settings,
    fiber,
    effect,
    on(event: string, handler: () => void): void {
      const list = handlers.get(event);
      if (list === undefined) handlers.set(event, [handler]);
      else list.push(handler);
    },
    inject(deps: readonly string[], callback: (panel: unknown) => void): void {
      injections.push(deps);
      if (options.typert === true && deps.includes('typert')) callback(panelCtx);
    },
    plugin(service: unknown, ops: unknown): void {
      plugins.push({ via: 'root', service, ops });
    },
  } as unknown as Context;

  return {
    ctx,
    fiber,
    effects,
    panelEffects,
    handlers,
    injections,
    contributions,
    plugins,
    presentations,
    logs,
    emit(event: string): void {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

/** 一次被记下来的 `setInterval`。 */
interface TimerRecord {
  readonly callback: () => void;
  readonly delay: number;
  readonly handle: unknown;
  /** `unref()` 被调用了几次。 */
  unrefs(): number;
}

/** 记账用的定时器替身。 */
interface TimerStub {
  /** 按装上顺序记下的定时器。 */
  readonly installed: readonly TimerRecord[];
  /** 被 `clearInterval` 撤掉的句柄。 */
  readonly cleared: readonly unknown[];
  restore(): void;
}

/**
 * 换掉 `setInterval`/`clearInterval`。
 *
 * 刷新间隔是分钟级的，真等下去没有意义；而留下的真定时器会拖着测试进程。这里只记账：延迟是
 * 多少、有没有 `unref`、什么时候被撤掉，以及——由测试自己决定——到点那一刻的回调长什么样。
 *
 * @returns 账本与还原函数。
 */
function stubTimers(): TimerStub {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const installed: TimerRecord[] = [];
  const cleared: unknown[] = [];
  globalThis.setInterval = ((callback: () => void, delay?: number) => {
    let unrefs = 0;
    const handle = {
      unref(): void {
        unrefs += 1;
      },
    };
    installed.push({ callback, delay: delay ?? 0, handle, unrefs: () => unrefs });
    return handle as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: unknown) => {
    cleared.push(handle);
  }) as unknown as typeof clearInterval;
  return {
    installed,
    cleared,
    restore(): void {
      globalThis.setInterval = originalSet;
      globalThis.clearInterval = originalClear;
    },
  };
}

/**
 * 换掉 `globalThis.fetch`，把每个请求的 URL 记下来，并一律应答一份空清单。
 *
 * 插件加载本身就会起一轮发现，因此测试绝不会等一个真请求：端点应答空清单，那一轮就完整跑完，
 * 「有没有发出去请求、发到哪」也就成了可断言的事实。
 *
 * @returns 请求过的 URL 与还原函数。
 */
function stubFetch(): { urls: string[]; restore(): void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    urls,
    restore(): void {
      globalThis.fetch = original;
    },
  };
}

/** 让即发即忘的那一轮刷新（`void runtime.refresh(...)`）跑到它该到的地方。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** 取出唯一那个被挂上去的面板服务 ops。 */
function panelOps(record: Harness): PanelOps {
  const entry = record.plugins.find((candidate) => candidate.via === 'panel');
  assert.ok(entry !== undefined, '面板服务应当已经挂在注入兑现的那层上下文上');
  return entry.ops as PanelOps;
}

describe('apply 登记的 effect', () => {
  it('两个 effect 各自登记：刷新间隔与设置呈现，标签就是它们的用途', () => {
    const record = harness();
    apply(record.ctx, liveConfig().ref);

    assert.deepEqual(
      record.effects.map((effect) => effect.label),
      ['aperture refresh interval', 'aperture settings presentation'],
      '登记的 effect 就是这两个，标签能让人在诊断里认出它们',
    );
    assert.equal(typeof record.effects[0]?.dispose, 'function', '间隔 effect 交出一个清理函数，卸载时据此撤掉定时器');
    assert.equal(typeof record.effects[1]?.dispose, 'function', '设置呈现交出 configure 的 disposer');
  });

  it('refreshIntervalMinutes 为 0 时不装定时器，但加载那一轮发现照跑', async () => {
    const timers = stubTimers();
    const net = stubFetch();
    try {
      const record = harness();
      apply(record.ctx, liveConfig().ref);
      assert.deepEqual(timers.installed, [], '0 表示只在加载与配置变更时刷新');

      await settle();
      assert.deepEqual(net.urls, [MODELS_ENDPOINT], '插件加载本身就是启动发现的那个动作');
      assert.equal(
        record.logs.filter((entry) => entry.level === 'warn').length,
        0,
        '空清单是正常应答，不是失败',
      );
    } finally {
      net.restore();
      timers.restore();
    }
  });

  it('间隔大于 0 时按分钟装上定时器并 unref，到点就是一轮「定时」刷新', async () => {
    const timers = stubTimers();
    const net = stubFetch();
    try {
      const record = harness({ typert: true });
      apply(record.ctx, liveConfig({ refreshIntervalMinutes: 5 }).ref);

      const timer = timers.installed[0];
      assert.ok(timer !== undefined, '配了间隔就要装上定时器');
      assert.equal(timer.delay, 5 * 60_000, '间隔以分钟配置，装上的是毫秒');
      assert.equal(timer.unrefs(), 1, '周期刷新不该拖着进程不放');
      assert.equal(timers.installed.length, 1, '只装一个');

      await settle();
      const fetched = net.urls.length;
      timer.callback();
      await settle();
      assert.equal(net.urls.length, fetched + 1, '到点触发一轮刷新');
      assert.equal(
        (panelOps(record).status() as PanelReport).refresh?.trigger,
        '定时',
        '这一轮的来源就是「定时」，配置页的状态段照它说话',
      );

      // 卸载：effect 交出的清理函数必须把句柄撤掉，而不是留下一个没人管的定时器。
      (record.effects[0]?.dispose as () => void)();
      assert.deepEqual(timers.cleared, [timer.handle], '清理函数撤掉的就是装上的那个句柄');
    } finally {
      net.restore();
      timers.restore();
    }
  });

  it('配置变更事件既重算间隔又唤起一轮刷新；回到 0 就把定时器撤掉', async () => {
    const timers = stubTimers();
    const net = stubFetch();
    try {
      const config = liveConfig({ refreshIntervalMinutes: 5 });
      const record = harness({ typert: true });
      apply(record.ctx, config.ref);

      assert.deepEqual([...record.handlers.keys()], ['loader/volatile-update'], '配置变更只有这一条来路');
      await settle();
      const first = timers.installed[0];
      assert.ok(first !== undefined);
      const fetched = net.urls.length;

      // Loader 在一次 volatile-only 更新落地之后发这个事件，此时 `get()` 已经是新值。
      config.update({ refreshIntervalMinutes: 10 });
      record.emit('loader/volatile-update');

      assert.deepEqual(timers.cleared, [first.handle], '旧定时器先撤掉');
      assert.equal(timers.installed.length, 2, '按新配置重新装一个');
      assert.equal(timers.installed[1]?.delay, 10 * 60_000, '间隔在每次配置变更时重算，而不是只捕获一次');
      await settle();
      assert.equal(net.urls.length, fetched + 1, '这个事件同时唤起一轮刷新');

      // 关掉周期刷新：这一轮之后不再有定时器，也不必重启。
      config.update({ refreshIntervalMinutes: 0 });
      record.emit('loader/volatile-update');
      assert.equal(timers.installed.length, 2, '0 不装新的定时器');
      assert.deepEqual(timers.cleared, [first.handle, timers.installed[1]?.handle], '把上一个撤掉');
    } finally {
      net.restore();
      timers.restore();
    }
  });

  it('告诉设置接缝本插件自己画配置页，且归属就是插件自己那根纤维', () => {
    const record = harness();
    apply(record.ctx, liveConfig().ref);

    assert.equal(record.presentations.length, 1, '只声明一次页面归属');
    assert.deepEqual(record.presentations[0]?.presentation, { auto: false }, '关掉通用表单：配置页由浏览器半边画');
    assert.equal(record.presentations[0]?.owner, record.fiber, '归属传的是 ctx.fiber，不是随便一根纤维');
  });
});

describe('apply 的面板半边', () => {
  it('typert 兑现时：登记贡献、挂上宿主服务，ops 接在真的运行时与活配置上', async () => {
    const net = stubFetch();
    try {
      const record = harness({ typert: true });
      apply(record.ctx, liveConfig().ref);

      assert.deepEqual(record.injections, [['typert']], '按需注入，而不是声明为必需依赖');
      assert.deepEqual(record.panelEffects.map((effect) => effect.label), ['aperture panel invocations']);
      assert.equal(record.contributions[0], PANEL_CONTRIBUTION, '登记的就是手写的那份宿主贡献');
      assert.equal(record.contributions.length, 1, '一份贡献登记一次');

      const plugin = record.plugins.find((candidate) => candidate.via === 'panel');
      assert.equal(plugin?.service, AperturePanelService, '宿主服务类原样交给 Cordis 去构造');
      assert.equal(record.plugins.length, 1, '面板服务只挂一次');

      const ops = panelOps(record);
      for (const method of ['status', 'refresh', 'configuration', 'save', 'edit'] as const) {
        assert.equal(typeof ops[method], 'function', `端点 ${method} 必须真的存在`);
      }

      await settle();
      // ops 接的是**同一个**运行时：报告里就是刚才那次加载触发的那一轮。
      assert.equal((ops.status() as PanelReport).refresh?.trigger, '插件加载');
      // 也接的是同一份活配置。
      assert.equal(ops.configuration().baseUrl, 'https://ai.example.ts.net');
      assert.equal(ops.configuration().sync, true, '同步默认打开');
    } finally {
      net.restore();
    }
  });

  it('typert 缺席时整块跳过，发现照常运行', async () => {
    const net = stubFetch();
    try {
      const record = harness();
      apply(record.ctx, liveConfig().ref);

      assert.deepEqual(record.injections, [['typert']], '仍然按需声明，只是这次没有兑现');
      assert.deepEqual(record.contributions, [], '没有注册表就不登记贡献');
      assert.deepEqual(record.plugins, [], '也不挂宿主服务');
      assert.deepEqual(record.panelEffects, [], '连 effect 都不登记');

      await settle();
      assert.deepEqual(net.urls, [MODELS_ENDPOINT], '没有界面的部署照样获得发现能力');
    } finally {
      net.restore();
    }
  });
});

describe('apply 的两种配置边界', () => {
  it('没有 baseUrl 时只说一句休眠，一个请求也不发', async () => {
    const net = stubFetch();
    try {
      const record = harness();
      apply(record.ctx, liveConfig({ baseUrl: '' }).ref);

      const info = record.logs.filter((entry) => entry.level === 'info');
      assert.equal(info.length, 1, '加载时只说一句人话');
      assert.equal(info[0]?.args[0], 'dsh-aperture: %s');
      assert.match(String(info[0]?.args[1]), /休眠/u, '说的是休眠，而不是失败');

      await settle();
      assert.deepEqual(net.urls, [], '没有地址就没有请求');
      assert.deepEqual(record.logs.filter((entry) => entry.level === 'warn'), [], '休眠不是一次失败的刷新');
    } finally {
      net.restore();
    }
  });

  it('配置自相矛盾时 apply 响亮抛出，而不是带着坏配置继续跑', () => {
    const record = harness();
    assert.throws(
      () => apply(record.ctx, liveConfig({ route: 'Bad_Route' }).ref),
      /必须是小写连字符形式/u,
      '路由键不合文法：这是配置错误，不是可以继续的状态',
    );
    assert.throws(
      () => apply(harness().ctx, liveConfig({ models: [{ id: 'a' }, { id: 'a' }] }).ref),
      /重复列出了/u,
      '跨字段的错误同样在加载这一轮就抛出来',
    );
  });
});
