/**
 * 浏览器半边的接线与行为。
 *
 * 这个文件不走打包器，因此没有编译器替它检查「握手 id 对不对」「端点与宿主是否同名」
 * 「字典是不是双语齐备」「配置页注册在哪个槽位上」。用例把这些逐个钉住，然后更进一步：
 * 用 `support/mini-react.ts` 真的把配置页渲染出来，走一遍
 * 挂载 → 拉配置 → 改地址 → 保存 → 读报告 的路径。
 *
 * 渲染次数也在被钉住的范围内：注入面每轮渲染都是新对象，effect 依赖一旦写到它上面就会
 * 自激循环——那正是「界面装上了但动不了」这类故障的常见形态。
 *
 * @module dsh-aperture/test/client
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { PANEL_INVOCATIONS, PANEL_NAMESPACE, PANEL_PACKAGE } from '../src/remote.ts';
import {
  MiniReact,
  blur,
  change,
  click,
  findAll,
  findById,
  findButton,
  text,
  toggle,
} from './support/mini-react.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(HERE, '..', 'client', 'aperture.js');

/** 浏览器那一侧的一个端点描述符。 */
interface ClientDescriptor {
  id: string;
  service: string;
  namespace: string;
  method: string;
  invocation: { kind: string };
  parameters: ReadonlyArray<{ name: string; wire: string; source: string; acceptsUndefined?: boolean; codec: Codec }>;
  result: Codec;
}

/**
 * 一个编解码器。
 *
 * `@deepseek-ai/dsh-typert-registry` 只认 strict 模式下的 `create` 工厂；`schema` 字段不被
 * 承认，带它的贡献会在 `$mount` 时整份被拒。
 */
interface Codec {
  mode: string;
  typeSymbol?: string;
  create: () => { parse: (value: unknown, at?: string) => unknown };
}

/** 一次 `slots.register` 的登记。 */
interface Registration {
  options: {
    name: string;
    key: string;
    locale: string;
    inject: () => { panel: PanelFace };
  };
  component: (props: Record<string, unknown>) => unknown;
}

/** `inject` 面交给配置页的端点集合。 */
interface PanelFace {
  status: () => Promise<Report>;
  refresh: () => Promise<{ ok: boolean; summary: string }>;
  withdraw: () => Promise<{ ok: boolean; summary: string }>;
  configuration: () => Promise<Configuration>;
  save: (baseUrl?: string | null, sync?: boolean) => Promise<{ ok: boolean; summary: string }>;
  edit: (id: string, patch: ModelPatch | null) => Promise<{ ok: boolean; summary: string }>;
}

/** 界面为单个模型发出去的补丁。 */
interface ModelPatch {
  name?: string | null;
  api?: string | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  input?: readonly string[] | null;
  thinking?: boolean | null;
  alias?: string | null;
}

/** 报告里的一个模型。 */
interface ModelView {
  id: string;
  name: string;
  route?: string;
  protocol?: string;
  endpoints: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
  input: readonly string[];
  reasoning: boolean;
  provenance: { limits: string; reasoning: string; input: string; name: string };
  overrideKeys?: readonly string[];
  alias?: string;
}

/** 宿主半边返回的整份报告。 */
interface Report {
  place: string;
  refresh?: {
    trigger: string;
    at: string;
    durationMs: number;
    ok: boolean;
    error?: string;
    catalog: { available: boolean; entries: number; reason?: string };
    endpoint?: { url: string; listed: number };
    sync?: { applied: boolean; ops: number; routes: readonly string[]; reason?: string };
  };
  routes: Array<{ provider: string; api?: string; baseURL?: string; models: number }>;
  models: ModelView[];
}

/** 假宿主返回的报告：一条路由一个模型，外加一个未服务的模型。 */
function report(overrides: Partial<Report> = {}): Report {
  return {
    place: 'https://ai.example.ts.net',
    refresh: {
      trigger: '配置变更',
      at: '2026-09-23T04:32:36.802Z',
      durationMs: 286,
      ok: true,
      catalog: { available: true, entries: 422 },
      endpoint: { url: 'https://ai.example.ts.net/v1/models', listed: 16 },
      sync: { applied: true, ops: 2, routes: ['aperture', 'aperture-anthropic'] },
    },
    routes: [{
      provider: 'aperture',
      api: 'openai-completions',
      baseURL: 'https://ai.example.ts.net/v1',
      models: 1,
    }],
    models: [
      {
        id: 'deepseek-flash',
        name: 'DeepSeek Flash',
        route: 'aperture',
        protocol: 'openai-completions',
        endpoints: ['/v1/chat/completions'],
        contextWindow: 1_048_576,
        maxTokens: 384_000,
        input: ['text', 'image'],
        reasoning: true,
        provenance: { limits: 'aperture', reasoning: 'models.dev', input: 'config', name: 'models.dev' },
        overrideKeys: ['thinking'],
        alias: 'deepseek/deepseek-v4-flash',
      },
      {
        id: 'gemini-2.5-flash',
        name: 'gemini-2.5-flash',
        endpoints: ['/v1beta/models/gemini-2.5-flash:generateContent'],
        input: ['text'],
        reasoning: false,
        provenance: { limits: 'default', reasoning: 'default', input: 'default', name: 'default' },
      },
    ],
    ...overrides,
  };
}

/** 配置端点返回的形状。 */
interface Configuration {
  baseUrl: string;
  sync: boolean;
  baseUrlOverridden: boolean;
  syncOverridden: boolean;
  writable: boolean;
}

/** 假宿主返回的配置。 */
function configuration(overrides: Partial<Configuration> = {}): Configuration {
  return {
    baseUrl: 'https://ai.example.ts.net',
    sync: true,
    baseUrlOverridden: true,
    syncOverridden: false,
    writable: true,
    ...overrides,
  };
}

/** 一次加载与驱动留下的全部证据。 */
interface Harness {
  readonly exports: {
    name: string;
    inject: readonly string[];
    apply: (ctx: unknown) => void;
    NS: string;
    REMOTE: { package: string; descriptors: readonly ClientDescriptor[] };
  };
  mounted?: { package: string; descriptors: readonly ClientDescriptor[] };
  readonly mini: MiniReact;
  readonly effectLabels: string[];
  readonly disposers: Record<string, () => void>;
  readonly localeNamespaces: string[];
  readonly dictionaries: Record<string, { zh: Record<string, string>; en: Record<string, string> }>;
  readonly registrations: Registration[];
  readonly slotInjections: string[];
  readonly styles: Array<{ mark: string | null; css: string; removed: boolean }>;
  readonly panelCalls: string[];
  readonly saveCalls: Array<[string | null | undefined, boolean | undefined]>;
  readonly editCalls: Array<[string, ModelPatch | null]>;
}

/** 一份可调的假端点集合。 */
interface FakePanelOptions {
  configuration?: Partial<Configuration>;
  summary?: string;
  fails?: string;
  report?: Report;
}

/** 建一个假 `aperturePanel` 命名空间，并记录调用。 */
function fakeNamespace(harness: Harness, options: FakePanelOptions = {}) {
  const config = configuration(options.configuration);
  const summary = options.summary ?? '已重新发现并发布。';
  const action = { ok: true, summary };
  return {
    status: async () => {
      harness.panelCalls.push('status');
      if (options.fails === 'status') {
        return { ok: false, error: { code: 'gateway/internal', message: '面板暂时连不上后台' } };
      }
      return { ok: true, value: options.report ?? report() };
    },
    configuration: async () => {
      harness.panelCalls.push('configuration');
      return { ok: true, value: config };
    },
    refresh: async () => {
      harness.panelCalls.push('refresh');
      return { ok: true, value: action };
    },
    withdraw: async () => {
      harness.panelCalls.push('withdraw');
      return { ok: true, value: action };
    },
    save: async (baseUrl?: string | null, sync?: boolean) => {
      harness.panelCalls.push('save');
      harness.saveCalls.push([baseUrl, sync]);
      return { ok: true, value: action };
    },
    edit: async (id: string, patch: ModelPatch | null) => {
      harness.panelCalls.push('edit');
      harness.editCalls.push([id, patch]);
      return { ok: true, value: action };
    },
  };
}

/**
 * 按客户端的加载方式加载浏览器半边。
 *
 * @returns 模块导出与记账容器；`react` 由替身充当。
 */
function loadClient(): Harness {
  const reported: Array<{ id: string; factory: (require: (id: string) => unknown) => unknown }> = [];
  const styles: Harness['styles'] = [];
  const mini = new MiniReact();

  const document = {
    head: {
      append: (node: { mark: string | null; css: string; removed: boolean }): void => {
        styles.push(node);
      },
    },
    querySelector: (selector: string): unknown => {
      const wanted = /\[([^\]]+)\]/u.exec(selector)?.[1];
      return styles.find((style) => !style.removed && style.mark === wanted) ?? null;
    },
    createElement: () => {
      const node = {
        mark: null as string | null,
        css: '',
        removed: false,
        setAttribute: (name: string): void => {
          node.mark = name;
        },
        set textContent(value: string) {
          node.css = value;
        },
        remove: (): void => {
          node.removed = true;
        },
      };
      return node;
    },
  };

  const sandbox = {
    window: { __ModuleLoader__: { load: (entry: unknown) => reported.push(entry as never) } },
    document,
  };
  vm.runInNewContext(readFileSync(CLIENT_FILE, 'utf8'), sandbox, { filename: CLIENT_FILE });

  assert.equal(reported.length, 1, '客户端 bundle 必须恰好上报一次');
  const entry = reported[0]!;
  assert.equal(entry.id, 'dsh-aperture', '握手 id 必须是包名');

  const exports = entry.factory((id: string) => {
    if (id === 'react') return mini;
    throw new Error(`客户端半边不应在运行时 require "${id}"：平台基线之外没有模块可解析`);
  }) as Harness['exports'];

  return {
    exports,
    mini,
    effectLabels: [],
    disposers: {},
    localeNamespaces: [],
    dictionaries: {},
    registrations: [],
    slotInjections: [],
    styles,
    panelCalls: [],
    saveCalls: [],
    editCalls: [],
  };
}

/**
 * 驱动一次 `apply`，并把作用域回调也走完。
 *
 * @param options - 假端点选项。
 * @param view - 页主问的那一种视图：`page` 要整块内容，`summary` 只要一行字。
 * @returns 记账容器、注入面、替身、配置页组件与元素工厂。
 */
function driveClient(options: FakePanelOptions = {}, view: 'page' | 'summary' = 'page'): {
  harness: Harness;
  face: PanelFace;
  mini: MiniReact;
  component: Registration['component'];
  element: unknown;
  t: (key: string, params?: Record<string, unknown>) => string;
} {
  const harness = loadClient();
  const mini = harness.mini;

  const ctx = {
    effect: (fn: () => unknown, label: string) => {
      harness.effectLabels.push(label);
      const disposer = fn();
      if (typeof disposer === 'function') harness.disposers[label] = disposer as () => void;
      return disposer;
    },
    inject: (names: readonly string[], run: (scope: unknown) => void) => {
      if (!names.includes('remote.aperturePanel')) return;
      run({
        locale: { bind: (ns: string) => (key: string) => harness.dictionaries[ns]?.zh[key] ?? key },
        remote: { aperturePanel: fakeNamespace(harness, options) },
        slots: {
          inject: (slot: string, callback: () => void) => {
            harness.slotInjections.push(slot);
            callback();
          },
          register: (registration: Registration['options'], component: unknown) => {
            harness.registrations.push({ options: registration, component: component as Registration['component'] });
          },
        },
      });
    },
    locale: {
      register: (ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }) => {
        harness.localeNamespaces.push(ns);
        harness.dictionaries[ns] = dictionaries;
        return () => {};
      },
    },
    remote: {
      $mount: async (contribution: unknown) => {
        harness.mounted = contribution as Harness['mounted'];
        return async () => {};
      },
    },
  };

  harness.exports.apply(ctx);

  const registration = harness.registrations[0];
  assert.ok(registration, 'apply 必须在 plugins.row.config 上注册本行的配置页');
  // 与 locale 服务同一套规则：`{name}` 插值；否则字典模板会原样漏进断言里。
  const t = (key: string, params?: Record<string, unknown>): string =>
    (harness.dictionaries['settings.aperturePanel']?.zh[key] ?? key)
      .replace(/\{(\w+)\}/gu, (match, name: string) => (
        params !== undefined && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ));
  return {
    harness,
    face: registration.options.inject().panel,
    mini,
    component: registration.component,
    element: mini.createElement(registration.component, {
      panel: registration.options.inject().panel,
      t,
      view,
    }),
    t,
  };
}

/**
 * 把 vm 侧的值搬回本侧。
 *
 * 浏览器半边在 `node:vm` 的另一个 realm 里跑，它造出来的对象原型与本侧不同，`assert.deepEqual`
 * 会因为原型不等而失败——因此比较前先过一遍 JSON。
 *
 * @param value - vm 侧的值。
 * @returns 本侧的值。
 */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 从注入的样式表里取一条规则的内容。
 *
 * 选择器按字面量匹配，且支持选择器列表（`A, B { … }`）：只要某一段就等于
 * `[data-dsh-aperture] <selector>` 就算命中。注释先剥掉，否则规则前的那段中文注释会被当成
 * 选择器的一部分。
 *
 * @param css - 样式表全文。
 * @param selector - `[data-dsh-aperture]` 之后的那个选择器。
 * @returns 花括号里的声明；没有这条规则时是空串。
 */
function cssRule(css: string, selector: string): string {
  const wanted = `[data-dsh-aperture] ${selector}`;
  const bare = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  for (const chunk of bare.split('}')) {
    const brace = chunk.indexOf('{');
    if (brace === -1) continue;
    if (chunk.slice(0, brace).split(',').some((part) => part.trim() === wanted)) {
      return chunk.slice(brace + 1);
    }
  }
  return '';
}

/**
 * 展开一个模型：先点开它所在的那张路由卡，再点开这一行。
 *
 * 两级展开在测试里也走同一条路——模型行在收起的路由卡里根本不存在，直接点它会点空。
 *
 * @param mini - 迷你渲染器。
 * @param id - 模型 id。
 * @param route - 它的路由键；缺省按假报告里的 `route` 推，没有就是「未服务」那张卡。
 * @returns 渲染落定后的 Promise。
 */
async function openModel(mini: MiniReact, id: string, route?: string): Promise<void> {
  const key = route ?? report().models.find((model) => model.id === id)?.route ?? 'unserved';
  const toggle = (target: string) => findAll(mini.tree(), (node) => node.props.id === target);
  if (toggle(`dap-model-${id}-toggle`).length === 0) {
    click(toggle(`dap-route-${key}-toggle`)[0]!);
    await mini.flush();
  }
  click(toggle(`dap-model-${id}-toggle`)[0]!);
  await mini.flush();
}

describe('浏览器半边', () => {
  it('以包名握手，只注入平台提供的三个服务', () => {
    const harness = loadClient();
    assert.equal(harness.exports.name, 'dsh-aperture');
    assert.deepEqual([...harness.exports.inject], ['slots', 'locale', 'remote']);
    assert.equal(harness.exports.NS, 'settings.aperturePanel');
  });

  it('端点与宿主半边一一对应', async () => {
    const { harness } = driveClient();
    await new Promise((resolve) => setImmediate(resolve));
    const mounted = harness.mounted;
    assert.ok(mounted, '$mount 必须收到贡献');
    assert.equal(mounted.package, PANEL_PACKAGE);
    assert.equal(PANEL_NAMESPACE, 'aperturePanel');
    const clientEndpoints = Array.from(mounted.descriptors, (descriptor) => `${descriptor.namespace}/${descriptor.method}`).sort();
    const hostEndpoints = PANEL_INVOCATIONS.map((descriptor) => `${descriptor.namespace}/${descriptor.method}`).sort();
    assert.deepEqual(clientEndpoints, hostEndpoints, '两半边的端点集合必须一致');
    assert.deepEqual(
      Array.from(mounted.descriptors, (descriptor) => descriptor.id).sort(),
      PANEL_INVOCATIONS.map((descriptor) => descriptor.id).sort(),
      '端点 id 也必须一致',
    );
  });

  it('每个端点都带 strict 编解码器，可省略的参数才接受缺省', async () => {
    const { harness } = driveClient();
    await new Promise((resolve) => setImmediate(resolve));
    const descriptors = harness.mounted?.descriptors ?? [];
    assert.equal(descriptors.length, 6);
    for (const descriptor of descriptors) {
      assert.equal(descriptor.result.mode, 'strict');
      assert.ok(descriptor.result.typeSymbol);
      // 注册表（@deepseek-ai/dsh-typert-registry）要求 strict 编解码器交出 `create` 工厂，
      // 拿一个 `schema` 字段顶替会让 `$mount` 抛 `strict codec has no create() factory`，
      // 整份贡献被拒、界面安静地什么都不出现。键集与工厂都在这里钉住。
      assert.deepEqual(Object.keys(descriptor.result).sort(), ['create', 'mode', 'typeSymbol']);
      assert.equal(typeof descriptor.result.create().parse, 'function');
      assert.equal(descriptor.invocation.kind, 'direct');
      for (const parameter of descriptor.parameters) {
        assert.equal(parameter.codec.mode, 'strict');
        assert.equal(parameter.source, 'json');
        assert.ok(parameter.codec.typeSymbol);
        assert.deepEqual(
          Object.keys(parameter.codec).sort(),
          parameter.acceptsUndefined === true
            ? ['acceptsUndefined', 'create', 'mode', 'typeSymbol']
            : ['create', 'mode', 'typeSymbol'],
        );
        assert.equal(typeof parameter.codec.create().parse, 'function');
      }
    }
    // 缺省与否由参数自己说了算：`save` 的两个参数没提到就是「不碰」，`edit` 的补丁必须给出
    // ——`null` 是「恢复默认」，缺省不能顺便也当成恢复。
    for (const descriptor of descriptors) {
      const optional = descriptor.method === 'save';
      for (const parameter of descriptor.parameters) {
        assert.equal(parameter.acceptsUndefined, optional, `${descriptor.method}.${parameter.name}`);
      }
    }
    const save = descriptors.find((descriptor) => descriptor.method === 'save');
    assert.ok(save);
    assert.deepEqual(Array.from(save.parameters, (parameter) => parameter.name), ['baseUrl', 'sync']);
    // `null` 是「恢复默认」的哨兵值，两个参数都必须过得了参数校验。
    assert.equal(save.parameters[0]?.codec.create().parse(null), null);
    assert.equal(save.parameters[0]?.codec.create().parse(undefined), undefined);
    assert.throws(() => save.parameters[0]?.codec.create().parse(7), /期望 string/u);
    assert.equal(save.parameters[1]?.codec.create().parse(true), true);
    assert.equal(save.parameters[1]?.codec.create().parse(null), null);
    assert.throws(() => save.parameters[1]?.codec.create().parse('yes'), /期望 boolean/u);
  });

  it('报告的形状有一份 strict 契约，漂移当场炸掉', async () => {
    const { harness } = driveClient();
    await new Promise((resolve) => setImmediate(resolve));
    const status = harness.mounted?.descriptors.find((descriptor) => descriptor.method === 'status');
    assert.ok(status);
    const parse = (value: unknown): unknown => status.result.create().parse(value);
    const payload = report();

    // 合法的报告能原样过去。
    const parsed = parse(payload) as Report;
    assert.equal(parsed.place, 'https://ai.example.ts.net');
    assert.equal(parsed.models.length, 2);
    assert.deepEqual(plain(parsed.models[1]?.provenance), {
      limits: 'default',
      reasoning: 'default',
      input: 'default',
      name: 'default',
    });
    // 嵌套对象与对象数组也要被真的校验到，而不是只看着像。
    assert.throws(() => parse({ ...payload, models: [{ ...payload.models[0], input: 'text' }] }), /models\[0\]\.input/u);
    assert.throws(() => parse({ ...payload, models: [{ ...payload.models[0], provenance: { limits: 1 } }] }), /provenance/u);
    assert.throws(() => parse({ ...payload, routes: [{ provider: 'aperture' }] }), /routes\[0\]\.models/u);
    assert.throws(() => parse({ ...payload, refresh: { trigger: 'x' } }), /refresh\.at/u);
    // 老的两段文本形态已经不认了。
    assert.throws(() => parse({ status: 'x', models: 'y' }), /place/u);
    assert.throws(() => parse(null), /期望一个对象/u);
  });

  it('edit 收一个 id 加一份补丁，允许 null（撤销），但拒绝越界的类型', async () => {
    const { harness } = driveClient();
    await new Promise((resolve) => setImmediate(resolve));
    const edit = harness.mounted?.descriptors.find((descriptor) => descriptor.method === 'edit');
    assert.ok(edit);
    assert.deepEqual(Array.from(edit.parameters, (parameter) => parameter.name), ['id', 'patch']);
    const id = edit.parameters[0]?.codec.create();
    const patch = edit.parameters[1]?.codec.create();
    assert.ok(id);
    assert.ok(patch);
    // 一行一次写入：`null` 补丁表示撤销这个模型的全部覆盖。
    assert.equal(id.parse('a'), 'a');
    assert.equal(patch.parse(null), null);
    assert.deepEqual(plain(patch.parse({ contextWindow: 8, alias: 'x' })), { contextWindow: 8, alias: 'x' });
    assert.equal(patch.parse(undefined), undefined);
    assert.throws(() => id.parse(7), /期望 string/u);
    assert.throws(() => patch.parse({ contextWindow: '8192' }), /contextWindow/u);
    assert.throws(() => patch.parse({ thinking: 'yes' }), /thinking/u);
    assert.throws(() => patch.parse({ input: [7] }), /input\[0\]/u);
    // 只有「可省略」的参数才接受缺省：补丁缺省不是「撤销」，撤销要用显式的 `null`。
    assert.equal(edit.parameters[1]?.acceptsUndefined, false);
    const save = harness.mounted?.descriptors.find((descriptor) => descriptor.method === 'save');
    assert.equal(save?.parameters[0]?.acceptsUndefined, true);
  });

  it('端点名不碰命名空间服务的预置成员', () => {
    // 这条规矩在浏览器里执行，本地跑不到：api-gateway 为每个命名空间建一个
    // `RemoteNamespaceService`，端点会变成它的属性，重名会被 validateContribution 拒绝
    // **整份**贡献——界面安静地什么都不出现，只在控制台留一行 console.error。这里把那份
    // 保留名单抄下来当护栏（来源：@deepseek-ai/dsh-api-gateway 客户端 bundle 的
    // `REMOTE_NAMESPACE_FIELDS` 与 `RemoteNamespaceService.prototype` 的成员）。
    const reserved = new Set([
      'ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace',
      'assertMethodAvailable', 'has', 'install', 'installDirect', 'installScoped', 'remove',
    ]);
    // 名单本身也要被钉住，免得日后有人靠删条目让用例变绿。
    for (const trap of ['ctx', 'empty', 'methods', 'name', 'namespace', 'install', 'remove']) {
      assert.ok(reserved.has(trap), `保留名单漏了 ${trap}`);
    }
    for (const descriptor of PANEL_INVOCATIONS) {
      assert.ok(!reserved.has(descriptor.method), `端点名 ${descriptor.method} 与命名空间服务重名`);
    }
  });

  it('注册双语字典与样式，并把本行的配置页挂在 plugins.row.config 上', () => {
    const { harness } = driveClient();
    assert.deepEqual(harness.localeNamespaces, ['settings.aperturePanel']);
    const dictionary = harness.dictionaries['settings.aperturePanel'];
    assert.ok(dictionary);
    assert.deepEqual(Object.keys(dictionary.zh).sort(), Object.keys(dictionary.en).sort(), '两种语言的键必须一致');
    assert.equal(dictionary.zh.tab, 'Aperture');

    // 键控槽位：键是 `<包名>#<行 id>`，也就是 `cordis.patch.yml` 里那一行；插件页据此把配置页
    // 挂到那一行上。
    assert.deepEqual(harness.slotInjections, ['plugins.row.config']);
    const registration = harness.registrations[0]!;
    assert.equal(registration.options.name, 'plugins.row.config');
    assert.equal(registration.options.key, 'dsh-aperture#aperture');
    assert.equal(registration.options.locale, 'settings.aperturePanel');
    // 列表式槽位那几个选项（id / order / label）在这里都不存在，写了也不会被读。
    const options = registration.options as unknown as Record<string, unknown>;
    assert.equal(options.id, undefined, '键控槽位没有 id');
    assert.equal(options.order, undefined, '键控槽位没有顺序');
    assert.equal(options.label, undefined, '行的标题由包元数据给出，不由组件给');

    assert.equal(harness.styles.length, 1);
    assert.equal(harness.styles[0]?.mark, 'data-dsh-aperture');
    assert.match(harness.styles[0]?.css ?? '', /\.dap-section/u);
    // 卸载时必须把样式表撤掉，否则重载会累积。
    harness.disposers['dsh-aperture: stylesheet']?.();
    assert.equal(harness.styles[0]?.removed, true);
  });

  it('页主问一行字时只给一行字：与包元数据里那句描述同义', () => {
    const { component, t } = driveClient({}, 'summary');
    assert.equal(component({ view: 'summary', t }), '把实例通告的模型发布成 llm-pi-ai 的 provider 路由。');
  });

  it('主按钮自带对比文字色，不靠继承', () => {
    // `--dsw-alias-brand-primary` 在浅色主题里近黑、深色主题里近白，而继承来的正文色与它
    // 同色：只写 background 就是深底深字。这条用例钉住「填了底就必须自己给文字色」。
    const { harness } = driveClient();
    const css = harness.styles[0]?.css ?? '';
    const rule = /\[data-dsh-aperture\] \.dap-button\[data-primary="true"\] \{([^}]*)\}/u.exec(css)?.[1] ?? '';
    assert.match(rule, /background:\s*var\(--dsw-alias-button-primary-fill/u);
    assert.match(rule, /color:\s*var\(--dsw-alias-label-primary-foreground/u);
    // 禁用态换主题自己的 dimmed 填充，而不是把整颗按钮调透明。
    assert.match(css, /\.dap-button\[data-primary="true"\]:disabled \{[^}]*opacity: 1/u);
    // 其余按钮与官方一致：整颗 `opacity: .4`。
    assert.match(css, /\.dap-button:not\(\[data-primary="true"\]\):disabled \{[^}]*opacity: \.4/u);
  });

  it('卡片与卡头照官方「模型」页的形状', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    const css = harness.styles[0]?.css ?? '';
    const tree = mini.tree();

    // 卡片是官方 rowCard：`.5px` 的 l4 边框、16px 圆角、`12px 14px` 内边距，底是透明的。
    // 段卡与路由卡在页面上是同一层，共用同一条规则。
    const card = cssRule(css, '.dap-section');
    assert.match(card, /border:\s*\.5px solid var\(--dsw-alias-border-l4/u);
    assert.match(card, /border-radius:\s*16px/u);
    assert.match(card, /padding:\s*12px 14px/u);
    assert.doesNotMatch(card, /background/u, '卡片底下不铺色，底来自页面');
    assert.equal(card, cssRule(css, '.dap-route'), '路由卡与段卡同一条规则');
    // 模型行是路由编辑区里面的一层：官方 modelEntry 的细框，比卡片明显小一号。
    const entry = cssRule(css, '.dap-model');
    assert.match(entry, /border-radius:\s*10px/u);
    assert.match(entry, /padding:\s*10px 12px/u);
    assert.doesNotMatch(entry, /background/u, '它本来就落在编辑区那块浅色面上');

    // 卡头：身份在左、动作右对齐；卡头上的动作是官方的行内尺寸（28px / 14px 圆角 / 12px 字）。
    assert.match(cssRule(css, '.dap-card-head'), /align-items:\s*center/u);
    assert.match(cssRule(css, '.dap-card-head'), /gap:\s*10px/u);
    assert.match(cssRule(css, '.dap-identity'), /gap:\s*6px/u);
    assert.match(cssRule(css, '.dap-row-actions'), /margin-left:\s*auto/u);
    assert.match(cssRule(css, '.dap-row-actions .dap-button'), /height:\s*28px/u);
    assert.match(cssRule(css, '.dap-row-actions .dap-button'), /border-radius:\s*14px/u);

    // 实例卡一张；模型段是页面级的一节，下面是一张路由卡与一张「未服务」卡。
    const sections = findAll(tree, (node) => node.props.className === 'dap-section');
    assert.equal(sections.length, 1, '实例与最近一次刷新合成了一张卡');
    const heads = findAll(tree, (node) => node.props.className === 'dap-card-head');
    assert.equal(heads.length, 3, '一张段卡 + 一张路由卡 + 一张未服务卡');
    assert.equal(text(findAll(heads[0]!, (node) => node.props.className === 'dap-name')[0]), 'Aperture');
    assert.equal(text(findAll(heads[1]!, (node) => node.props.className === 'dap-name')[0]), 'aperture');
    assert.equal(text(findAll(heads[2]!, (node) => node.props.className === 'dap-name')[0]), '未服务');

    // 面板不自画标题：「插件」页已经画过本行的标题与描述，这里只留段自己那一个标题
    // （`t('title')` 因此从字典里删掉了——同一个说法由包元数据那份 locale 给出）。
    const title = findAll(tree, (node) => node.props.className === 'dap-title');
    assert.deepEqual(title.map((node) => text(node)), ['模型与路由']);
    // 计数标签：实例卡的两枚（覆盖 + 写入方向）、整节一个、两张卡各一个。
    assert.deepEqual(
      findAll(tree, (node) => node.props.className === 'dap-tag').map((node) => text(node)),
      ['已覆盖', '写入 provider 字典', '2 个模型', '1 个模型', '1 个模型'],
    );
  });

  it('身份里的状态点用官方那对 token 上色，并把同一句话写进 title', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    const css = harness.styles[0]?.css ?? '';

    const dot = cssRule(css, '.dap-dot');
    assert.match(dot, /width:\s*8px/u);
    assert.match(dot, /height:\s*8px/u);
    assert.match(dot, /border-radius:\s*50%/u);
    assert.match(cssRule(css, '.dap-dot[data-state="ok"]'), /--dsw-alias-state-success-primary/u);
    assert.match(cssRule(css, '.dap-dot[data-state="bad"]'), /--dsw-alias-state-error-primary/u);

    const dots = findAll(mini.tree(), (node) => node.props.className === 'dap-dot');
    assert.deepEqual(
      dots.map((node) => node.props['data-state']),
      ['ok', 'ok', 'bad'],
      '地址填了且上一轮成功、路由写进了 llm-pi-ai、未服务那张卡没有路由',
    );
    assert.deepEqual(dots.map((node) => node.props.title), [
      '实例地址已配置，最近一次刷新成功',
      '这一轮已写入 llm-pi-ai',
      '这些模型没有路由可用',
    ]);
    for (const node of dots) {
      assert.equal(node.props.role, 'img');
      assert.equal(node.props['aria-label'], node.props.title, '颜色不是唯一的说法');
    }
  });

  it('地址留空或上一轮失败，卡头那颗点都变红，标题点名是哪一种', async () => {
    const refresh = report().refresh!;

    // 地址空着：它是休眠的根因，因此标题说地址，不说刷新。
    const dormant = driveClient({
      configuration: { baseUrl: '' },
      report: report({ refresh: { ...refresh, ok: false, error: '网关不可达' } }),
    });
    dormant.mini.mount(dormant.element);
    await dormant.mini.flush();
    const empty = findAll(dormant.mini.tree(), (node) => node.props.className === 'dap-dot');
    assert.deepEqual(empty.map((node) => node.props['data-state']), ['bad', 'ok', 'bad']);
    assert.equal(empty[0]?.props.title, '没有实例地址');
    assert.match(text(dormant.mini.tree()), /发现处于休眠/u);

    // 地址填着，只是这一轮失败了：同一颗点变红，标题换成失败。
    const failed = driveClient({ report: report({ refresh: { ...refresh, ok: false, error: '网关不可达' } }) });
    failed.mini.mount(failed.element);
    await failed.mini.flush();
    const red = findAll(failed.mini.tree(), (node) => node.props.className === 'dap-dot');
    assert.deepEqual(red.map((node) => node.props['data-state']), ['bad', 'ok', 'bad']);
    assert.equal(red[0]?.props.title, '最近一次刷新失败');
    assert.match(text(failed.mini.tree()), /网关不可达/u);
  });

  it('两级展开：路由卡里装模型清单，模型行自己再展开参数面', async () => {
    const { mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    const cards = findAll(mini.tree(), (node) => node.props.className === 'dap-route');
    assert.deepEqual(
      cards.map((node) => text(findAll(node, (n) => n.props.className === 'dap-name')[0])),
      ['aperture', '未服务'],
      '一条路由一张卡，最后是没有路由可用的那些',
    );
    assert.equal(
      findAll(mini.tree(), (node) => node.props.className === 'dap-model').length,
      0,
      '模型行在收起的路由卡里，页面上还不存在',
    );
    assert.deepEqual(
      findAll(cards[0]!, (node) => node.type === 'button').map((node) => text(node)),
      ['编辑'],
      '路由卡头右边只有这一颗按钮',
    );

    // 第一层：路由卡里那块浅色面，头上是这条路由的地址，里面是它承载的模型清单。
    click(findById(mini.tree(), 'dap-route-aperture-toggle'));
    await mini.flush();
    const openedRoute = findAll(mini.tree(), (node) => node.props.className === 'dap-route')[0]!;
    const editors = findAll(openedRoute, (node) => node.props.className === 'dap-editor');
    assert.equal(editors.length, 1, '浅色面落在**这张路由卡**里面');
    assert.equal(
      text(findAll(editors[0]!, (node) => node.props.className === 'dap-editor-route')[0]),
      '→ https://ai.example.ts.net/v1',
    );
    const rows = findAll(openedRoute, (node) => node.props.className === 'dap-model');
    assert.equal(rows.length, 1, '这条路由只承载一个模型');
    // 模型行是 id 在前、名字在后（官方 modelCatalog 那一行同序），而且不再自己带状态点。
    assert.equal(text(findAll(rows[0]!, (n) => n.props.className === 'dap-model-id')[0]), 'deepseek-flash');
    assert.equal(text(findAll(rows[0]!, (n) => n.props.className === 'dap-name')[0]), 'DeepSeek Flash');
    assert.equal(findAll(rows[0]!, (n) => n.props.className === 'dap-dot').length, 0);
    assert.equal(findAll(rows[0]!, (n) => n.props.className === 'dap-advanced').length, 0, '这一行还没点开');

    // 第二层：参数面落在**这一行里面**，而且不套第二层灰底（同一块浅色面上切一条线）。
    await openModel(mini, 'deepseek-flash');
    const row = findAll(mini.tree(), (node) => node.props.className === 'dap-model')[0]!;
    assert.equal(findAll(row, (node) => node.props.className === 'dap-advanced').length, 1);
    assert.equal(findAll(row, (node) => node.props.className === 'dap-editor').length, 0);
    const actions = findAll(row, (node) => node.props.className === 'dap-actions')[0]!;
    assert.equal(actions.props['data-align'], 'end');
    assert.deepEqual(
      findAll(actions, (node) => node.type === 'button').map((node) => text(node)),
      ['恢复默认', '取消', '保存'],
    );

    // 「未服务」那张卡：展开后头上写着为什么没有路由，行里是它通告的端点。
    click(findById(mini.tree(), 'dap-route-unserved-toggle'));
    await mini.flush();
    const unservedCard = findAll(mini.tree(), (node) => node.props.className === 'dap-route')[1]!;
    assert.match(
      text(findAll(unservedCard, (node) => node.props.className === 'dap-editor')[0]!),
      /没有本插件可发布的端点/u,
    );
    assert.match(
      text(findAll(unservedCard, (node) => node.props.className === 'dap-model-meta')[0]!),
      /通告的端点/u,
    );
  });

  it('路由卡上的点说这一轮写没写进 llm-pi-ai，没有同步结果时就不画点', async () => {
    const refresh = report().refresh!;

    const off = driveClient({
      report: report({
        refresh: { ...refresh, sync: { applied: false, ops: 0, routes: [], reason: '同步已禁用' } },
      }),
    });
    off.mini.mount(off.element);
    await off.mini.flush();
    const dots = findAll(off.mini.tree(), (node) => node.props.className === 'dap-dot');
    assert.deepEqual(dots.map((node) => node.props['data-state']), ['ok', 'bad', 'bad']);
    assert.equal(
      dots[1]!.props.title,
      '这一轮没有写入 llm-pi-ai：同步已禁用',
      '没写进去时把原因一起说出来，而不是让人去别处找',
    );

    const unknown = driveClient({ report: report({ refresh: { ...refresh, sync: undefined } }) });
    unknown.mini.mount(unknown.element);
    await unknown.mini.flush();
    assert.deepEqual(
      findAll(unknown.mini.tree(), (node) => node.props.className === 'dap-dot')
        .map((node) => node.props['data-state']),
      ['ok', 'bad'],
      '报告里没有同步结果就没有状态可说：路由卡不画点，未服务那张照旧',
    );
  });

  it('实例卡把字段摆进官方那块浅色编辑区，动作右对齐且「取消」在「保存」左边', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    const tree = mini.tree();
    const css = harness.styles[0]?.css ?? '';

    const editors = findAll(tree, (node) => node.props.className === 'dap-editor');
    assert.equal(editors.length, 1, '收起时只有实例卡那块编辑区：模型行要按「编辑」才展开');
    const editor = editors[0]!;
    assert.equal(findById(editor, 'dap-base-url').props.value, 'https://ai.example.ts.net');

    // 地址占满整行，标签走官方 fieldLabel（12px/500 的 label-secondary）。
    const cell = findAll(editor, (node) => node.props.className === 'dap-field')[0]!;
    assert.equal(cell.props['data-wide'], 'true');
    assert.equal(cell.props['data-emphasis'], 'true');
    assert.match(cssRule(css, '.dap-field[data-emphasis="true"] > label'), /font-weight:\s*500/u);
    assert.match(cssRule(css, '.dap-field[data-wide="true"]'), /grid-column:\s*1 \/ -1/u);

    const actions = findAll(editor, (node) => node.props.className === 'dap-actions')[0]!;
    assert.equal(actions.props['data-align'], 'end', '动作右对齐');
    assert.deepEqual(
      findAll(actions, (node) => node.type === 'button').map((node) => text(node)),
      ['取消', '保存'],
    );
  });

  it('刷新与撤下路由是实例卡头上的动作，报告没回来时也还在', async () => {
    const { mini, element } = driveClient({ fails: 'status' });
    mini.mount(element);
    await mini.flush();
    const tree = mini.tree();

    const heads = findAll(tree, (node) => node.props.className === 'dap-card-head');
    assert.equal(heads.length, 1, '报告没回来时就只有实例这一张卡');
    const actions = findAll(heads[0]!, (node) => node.props.className === 'dap-row-actions')[0]!;
    assert.deepEqual(
      findAll(actions, (node) => node.type === 'button').map((node) => text(node)),
      ['立即刷新', '撤掉已发布的路由'],
    );
    assert.match(text(tree), /尚未完成任何刷新/u);
    // 卡头那颗点说的是地址与刷新两件事；地址填着、只是还没刷新过，因此是绿的，标题只说地址。
    assert.deepEqual(
      findAll(heads[0]!, (node) => node.props.className === 'dap-dot').map((node) => node.props.title),
      ['实例地址已配置'],
    );
  });

  it('实例卡的头能折起来：默认展开，折起来就不渲染卡体，动作留在外面', async () => {
    const { mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    const instance = findById(mini.tree(), 'dap-card-instance-toggle');
    assert.equal(instance.props['aria-expanded'], 'true', '默认展开');
    assert.equal(instance.props['aria-controls'], 'dap-body-instance');
    assert.equal(findAll(mini.tree(), (node) => node.props.id === 'dap-base-url').length, 1);
    assert.match(text(mini.tree()), /最近一次刷新/u, '刷新那段现在就在同一张卡里');

    click(instance);
    await mini.flush();
    assert.equal(findById(mini.tree(), 'dap-card-instance-toggle').props['aria-expanded'], 'false');
    assert.equal(
      findAll(mini.tree(), (node) => node.props.id === 'dap-body-instance').length,
      0,
      '折起来就整块不渲染，DOM 里不留一个藏着的输入框',
    );
    assert.doesNotMatch(text(mini.tree()), /最近一次刷新/u, '表单与刷新那段一起折起来');

    // 折叠是本地状态，重渲染不会把它弹回来；而按了卡头上的动作，反馈必须看得见——它留在
    // 折叠体外面，否则「折着按了立即刷新」就成了一个没有任何回音的按钮。
    click(findButton(mini.tree(), '立即刷新'));
    await mini.flush();
    assert.equal(
      findAll(mini.tree(), (node) => node.props.id === 'dap-body-instance').length,
      0,
      '刷新一轮之后它还是折着的',
    );
    assert.match(text(mini.tree()), /已重新发现并发布/u);

    click(findById(mini.tree(), 'dap-card-instance-toggle'));
    await mini.flush();
    assert.equal(findAll(mini.tree(), (node) => node.props.id === 'dap-base-url').length, 1, '再点一下回来');
    assert.match(text(mini.tree()), /最近一次刷新/u);
  });

  it('配置页挂载后先显示加载态，再渲染出配置与报告', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);

    assert.match(text(mini.tree()), /正在读取状态/u);
    await mini.flush();
    assert.deepEqual([...harness.panelCalls].sort(), ['configuration', 'status']);
    const tree = mini.tree();
    assert.equal(findById(tree, 'dap-base-url').props.value, 'https://ai.example.ts.net');
    assert.equal(findById(tree, 'dap-sync').props.checked, true);
    assert.match(text(tree), /aperture/u, '路由卡头就是报告里的路由');
    assert.match(text(tree), /openai-completions/u);
    assert.equal(findButton(tree, '保存').props.disabled, true, '没有草稿差异时保存应禁用');
    // 一次交互只该渲染很少几次；多到几十次就说明 effect 在自激。
    assert.ok(mini.renders <= 6, `渲染次数 ${mini.renders} 太多：effect 依赖里多半放了注入面`);
    // 更直接的一条：注入面由渲染器每轮重新组装，因此任何 effect 都不能依赖它（或别的对象）。
    for (const deps of mini.hookDeps()) {
      if (deps === undefined) continue;
      for (const dep of deps) {
        assert.equal(typeof dep, 'number', `effect 依赖里出现了非原始值：${String(dep)}`);
      }
    }
  });

  it('改地址后保存，把草稿原样交给端点', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    change(findById(mini.tree(), 'dap-base-url'), 'https://new.example.ts.net');
    await mini.flush();
    const save = findButton(mini.tree(), '保存');
    assert.equal(save.props.disabled, false);
    click(save);
    await mini.flush();

    assert.deepEqual(harness.saveCalls, [['https://new.example.ts.net', true]]);
    assert.match(text(mini.tree()), /已重新发现并发布/u);
    assert.ok(harness.panelCalls.filter((call) => call === 'configuration').length >= 2, '保存后应重读配置');
  });

  it('「恢复默认」明确传 null：地址与同步开关各撤各的', async () => {
    const { mini, harness, element } = driveClient({ configuration: { syncOverridden: true } });
    mini.mount(element);
    await mini.flush();

    // 「已覆盖」跟着它描述的那个字段走：地址字段一个、同步开关一个，卡头上不再挂（卡头上那句
    // 没有主语的「已覆盖」正是它看着意义不明的原因）。
    const head = findAll(mini.tree(), (node) => node.props.className === 'dap-card-head')[0]!;
    assert.equal(findAll(head, (node) => node.props.className === 'dap-tag').length, 0);
    const badges = findAll(mini.tree(), (node) => node.props.className === 'dap-field-badges');
    assert.equal(badges.length, 2);
    assert.equal(
      findAll(badges[0]!, (node) => node.props.className === 'dap-tag')[0]?.props.title,
      '这一项写在你的设置文件里；存在就算覆盖，值与默认相同也算。',
      '标签自己说清「覆盖」是什么意思',
    );
    const resets = findAll(mini.tree(), (node) => node.props.className === 'dap-reset');
    assert.deepEqual(resets.map((node) => text(node)), ['恢复默认', '恢复默认']);

    click(resets[0]!);
    await mini.flush();
    assert.deepEqual(harness.saveCalls, [[null, undefined]], '地址那颗只撤地址');

    click(findAll(mini.tree(), (node) => node.props.className === 'dap-reset')[1]!);
    await mini.flush();
    assert.deepEqual(harness.saveCalls[1], [undefined, null], '开关那颗只撤开关');
  });

  it('同步开关与两个动作按钮各自打到对应端点', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    toggle(findById(mini.tree(), 'dap-sync'), false);
    await mini.flush();
    click(findButton(mini.tree(), '保存'));
    await mini.flush();
    assert.deepEqual(harness.saveCalls[0], ['https://ai.example.ts.net', false]);

    click(findButton(mini.tree(), '立即刷新'));
    await mini.flush();
    click(findButton(mini.tree(), '撤掉已发布的路由'));
    await mini.flush();
    assert.ok(harness.panelCalls.includes('refresh'));
    assert.ok(harness.panelCalls.includes('withdraw'));
  });

  it('设置文档只读时表单禁用并说明原因', async () => {
    const { mini, element } = driveClient({ configuration: { writable: false } });
    mini.mount(element);
    await mini.flush();

    const tree = mini.tree();
    assert.equal(findById(tree, 'dap-base-url').props.disabled, true);
    assert.match(text(tree), /不接受写入/u);
  });

  it('报告渲染成状态行与按路由分组的模型清单', async () => {
    const { mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    const body = text(mini.tree());

    // 状态段：一次刷新决定了什么，一项一行。
    assert.match(body, /最近一次刷新/u);
    assert.match(body, /配置变更/u);
    assert.match(body, /286ms/u);
    assert.match(body, /成功/u);
    assert.match(body, /422 个条目/u);
    assert.match(body, /列出了 16 行/u);
    assert.match(body, /写入 2 个操作（aperture, aperture-anthropic）/u);

    // 模型段：收起时只有页面级标题、那句「已覆盖几个」与两张卡头（路由 + 未服务）。
    assert.match(body, /模型与路由/u);
    assert.match(body, /已覆盖 1 个模型，其余沿用发现值与清单/u);
    assert.match(body, /aperture/u);
    assert.match(body, /openai-completions/u);
    assert.match(body, /未服务/u);
    // 模型行在路由卡里，第一层展开之前页面上没有它。
    assert.equal(findAll(mini.tree(), (node) => node.props.id === 'dap-model-deepseek-flash-name').length, 0);

    // 第一层：路由卡展开后是浅色面——地址一行，然后是这条路由承载的模型行。
    click(findById(mini.tree(), 'dap-route-aperture-toggle'));
    await mini.flush();
    const listed = text(mini.tree());
    assert.match(listed, /→ https:\/\/ai\.example\.ts\.net\/v1/u);
    assert.match(listed, /deepseek-flash/u);
    assert.match(listed, /DeepSeek Flash/u);
    assert.match(listed, /1\D?048\D?576 上下文窗口/u);
    assert.match(listed, /384\D?000 输出/u);
    assert.match(listed, /文本\+图像/u);
    assert.match(listed, /推理/u);
    assert.match(listed, /清单别名 deepseek\/deepseek-v4-flash/u);
    assert.match(listed, /已覆盖/u, '覆盖过的模型带标签');

    // 「未服务」那张卡里是它通告的端点。
    click(findById(mini.tree(), 'dap-route-unserved-toggle'));
    await mini.flush();
    const unserved = text(mini.tree());
    assert.match(unserved, /未服务：没有本插件可发布的端点/u);
    assert.match(unserved, /gemini-2\.5-flash/u);
    assert.match(unserved, /通告的端点：\/v1beta\/models\/gemini-2\.5-flash:generateContent/u);
    // 来源不堆在行尾：第一层展开时还没有这一行，第二层展开后每条来源跟着它描述的那个字段。
    assert.doesNotMatch(unserved, /每项事实来自/u);
    assert.doesNotMatch(unserved, /生效 1[,\s]?048[,\s]?576/u);

    await openModel(mini, 'deepseek-flash');
    assert.equal(findById(mini.tree(), 'dap-model-deepseek-flash-name').props.value, 'DeepSeek Flash');
    assert.equal(findById(mini.tree(), 'dap-model-deepseek-flash-alias').props.value, 'deepseek/deepseek-v4-flash');
    const opened = text(mini.tree());
    assert.match(opened, /生效 1[,\s]?048[,\s]?576 · 来自 aperture/u, '容量旁边写着它从哪儿来');
    assert.match(opened, /生效 文本\+图像 · 来自 配置/u);
    assert.match(opened, /生效 开 · 来自 models\.dev/u);
    assert.match(opened, /来自 models\.dev/u, '显示名那格只说来源，值在输入框里');
    // 再点一次收起，面板连输入框一起消失。
    await openModel(mini, 'deepseek-flash');
    assert.equal(findAll(mini.tree(), (node) => node.props.id === 'dap-model-deepseek-flash-name').length, 0);
    assert.doesNotMatch(text(mini.tree()), /来自 aperture/u);
  });

  it('没有刷新过时不装作有报告', async () => {
    const { mini, element } = driveClient({ report: report({ refresh: undefined, routes: [], models: [] }) });
    mini.mount(element);
    await mini.flush();
    assert.match(text(mini.tree()), /尚未完成任何刷新/u);
    assert.match(text(mini.tree()), /未发现任何模型/u);
  });

  it('就地编辑模型参数：表单预填生效值，只把改过的字段发出去', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    await openModel(mini, 'deepseek-flash');
    const tree = mini.tree();
    assert.equal(findById(tree, 'dap-model-deepseek-flash-name').props.value, 'DeepSeek Flash', '预填生效值');
    assert.equal(findById(tree, 'dap-model-deepseek-flash-contextWindow').props.value, '1048576');
    assert.equal(findById(tree, 'dap-model-deepseek-flash-alias').props.value, 'deepseek/deepseek-v4-flash');
    assert.equal(findById(tree, 'dap-model-deepseek-flash-text').props.checked, true);
    assert.equal(findById(tree, 'dap-model-deepseek-flash-image').props.checked, true);
    assert.equal(findById(tree, 'dap-model-deepseek-flash-reasoning').props.value, 'on', '有 thinking 覆盖就是它');
    // 面板是官方的参数栅格：每个格子有 12px 的小标签，容量旁边写着生效值与来源。
    assert.match(text(tree), /生效 1[,\s]?048[,\s]?576 · 来自 aperture/u);

    change(findById(tree, 'dap-model-deepseek-flash-contextWindow'), '32768');
    await mini.flush();
    // 草稿期间出现「待保存」标签，动手前不打端点。
    assert.match(text(mini.tree()), /待保存/u);
    assert.deepEqual(harness.editCalls, [], '按下保存之前不该写任何东西');
    click(findById(mini.tree(), 'dap-model-deepseek-flash-save'));
    await mini.flush();

    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', { contextWindow: 32768 }]]);
    assert.match(text(mini.tree()), /已重新发现并发布/u);
    // 保存后收起面板、重读报告与配置，列表里马上能看到新的覆盖。
    assert.equal(findAll(mini.tree(), (node) => node.props.id === 'dap-model-deepseek-flash-save').length, 0);
    assert.equal(harness.panelCalls.filter((call) => call === 'edit').length, 1);
    assert.ok(harness.panelCalls.filter((call) => call === 'status').length >= 2);
  });

  it('每行各自保存：只写这一行，另一行留在那儿', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    // 两行同时展开、都改了东西，这时按哪一行就只写哪一行。
    await openModel(mini, 'deepseek-flash');
    await openModel(mini, 'gemini-2.5-flash');
    change(findById(mini.tree(), 'dap-model-deepseek-flash-contextWindow'), '32768');
    change(findById(mini.tree(), 'dap-model-gemini-2.5-flash-api'), 'anthropic-messages');
    await mini.flush();

    click(findById(mini.tree(), 'dap-model-deepseek-flash-save'));
    await mini.flush();
    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', { contextWindow: 32768 }]]);
    // 保存的那一行收起了，另一行还开着、草稿还在。
    assert.equal(findAll(mini.tree(), (node) => node.props.id === 'dap-model-deepseek-flash-contextWindow').length, 0);
    assert.equal(findById(mini.tree(), 'dap-model-gemini-2.5-flash-api').props.value, 'anthropic-messages');
    assert.match(text(mini.tree()), /待保存/u);

    click(findById(mini.tree(), 'dap-model-gemini-2.5-flash-save'));
    await mini.flush();
    assert.deepEqual(plain(harness.editCalls), [
      ['deepseek-flash', { contextWindow: 32768 }],
      ['gemini-2.5-flash', { api: 'anthropic-messages' }],
    ]);
  });

  it('留空表示这一项不覆盖，清空的字段传 null', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openModel(mini, 'deepseek-flash');

    change(findById(mini.tree(), 'dap-model-deepseek-flash-name'), '');
    change(findById(mini.tree(), 'dap-model-deepseek-flash-contextWindow'), '');
    toggle(findById(mini.tree(), 'dap-model-deepseek-flash-image'), false);
    await mini.flush();
    click(findById(mini.tree(), 'dap-model-deepseek-flash-save'));
    await mini.flush();

    assert.deepEqual(plain(harness.editCalls), [[
      'deepseek-flash',
      { name: null, contextWindow: null, input: ['text'] },
    ]]);
  });

  it('「取消」丢掉草稿并收起，什么都不发', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    await openModel(mini, 'deepseek-flash');
    change(findById(mini.tree(), 'dap-model-deepseek-flash-contextWindow'), '1');
    await mini.flush();
    assert.match(text(mini.tree()), /待保存/u);

    click(findById(mini.tree(), 'dap-model-deepseek-flash-cancel'));
    await mini.flush();
    assert.deepEqual(harness.editCalls, [], '取消不该打端点');
    assert.doesNotMatch(text(mini.tree()), /待保存/u);
    assert.equal(findAll(mini.tree(), (node) => node.props.id === 'dap-model-deepseek-flash-name').length, 0);

    // 再展开一次：输入框回到生效值，改动确实被丢掉了。
    await openModel(mini, 'deepseek-flash');
    assert.equal(findById(mini.tree(), 'dap-model-deepseek-flash-contextWindow').props.value, '1048576');
  });

  it('「恢复默认」只清掉用户层里确实写过的那些键，而且只动这一行', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    // 这一行用户层里写过 thinking。别名是清单给的、不是用户写的，因此不去碰它：报告里的
    // `overrideKeys` 说的是用户层写过哪些键，界面不再拿生效值去猜。
    await openModel(mini, 'deepseek-flash');
    click(findById(mini.tree(), 'dap-model-deepseek-flash-revert'));
    await mini.flush();

    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', { thinking: null }]]);
    assert.match(text(mini.tree()), /已重新发现并发布/u);
    // 写的是别的行？不可能：端点一次只收一个 id。
    assert.equal(findAll(mini.tree(), (node) => node.props.id === 'dap-model-deepseek-flash-toggle').length, 1);
  });

  it('别名也写在用户层里时，跟着一起撤（别名用空串表示「不要再覆盖」）', async () => {
    const base = report().models[0]!;
    const { harness, mini, element } = driveClient({
      report: report({ models: [{ ...base, overrideKeys: ['thinking', 'alias'] }, report().models[1]!] }),
    });
    mini.mount(element);
    await mini.flush();

    await openModel(mini, 'deepseek-flash');
    click(findById(mini.tree(), 'dap-model-deepseek-flash-revert'));
    await mini.flush();

    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', { thinking: null, alias: '' }]]);
  });

  it('标签的 title 点名覆盖了哪几项：界面不编辑的键也说得出来', async () => {
    const base = report().models[0]!;
    const { mini, element } = driveClient({
      report: report({
        models: [{ ...base, overrideKeys: ['contextWindow', 'reasoningEfforts'] }, report().models[1]!],
      }),
    });
    mini.mount(element);
    await mini.flush();
    await openModel(mini, 'deepseek-flash');

    // 实例卡上那两枚字段标签也带 title，因此这里看的是全部标签里有没有这一句。
    const titles = findAll(mini.tree(), (node) => node.props.className === 'dap-tag')
      .map((node) => node.props.title);
    assert.ok(titles.includes('这一行在设置文件里写了：上下文、推理档位'), titles.join(' / '));
  });

  it('报告里出现界面不认识的覆盖键时，整条撤销——不然那颗「已覆盖」按不下去', async () => {
    const base = report().models[0]!;
    const { harness, mini, element } = driveClient({
      report: report({
        models: [
          { ...base, overrideKeys: ['reasoningEfforts'], alias: undefined },
          report().models[1]!,
        ],
      }),
    });
    mini.mount(element);
    await mini.flush();

    await openModel(mini, 'deepseek-flash');
    click(findById(mini.tree(), 'dap-model-deepseek-flash-revert'));
    await mini.flush();
    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', null]]);
  });

  it('容量认 1M、100K 这种写法，回写成能原样读回来的最短那个', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openModel(mini, 'deepseek-flash');
    const tree = mini.tree();

    // 回写：384000 是整千，写成 384K；1048576 不是整千，照原样写出来（官方 formatCapacity 同此）。
    assert.equal(findById(tree, 'dap-model-deepseek-flash-maxTokens').props.value, '384K');
    assert.equal(findById(tree, 'dap-model-deepseek-flash-contextWindow').props.value, '1048576');
    assert.match(text(tree), /1M、100K/u, '写法写在提示里，不然没人猜得到');

    change(findById(tree, 'dap-model-deepseek-flash-contextWindow'), '1M');
    await mini.flush();
    change(findById(mini.tree(), 'dap-model-deepseek-flash-maxTokens'), '100k');
    await mini.flush();
    click(findById(mini.tree(), 'dap-model-deepseek-flash-save'));
    await mini.flush();

    // K/M 是十进制的：1M = 1000000、100k = 100000，大小写一样。
    assert.deepEqual(plain(harness.editCalls), [
      ['deepseek-flash', { contextWindow: 1_000_000, maxTokens: 100_000 }],
    ]);
  });

  it('失焦时写法定形，只换个写法不算改动', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openModel(mini, 'deepseek-flash');

    // 小写 k 定形回大写 K。
    change(findById(mini.tree(), 'dap-model-deepseek-flash-maxTokens'), '100k');
    await mini.flush();
    blur(findById(mini.tree(), 'dap-model-deepseek-flash-maxTokens'));
    await mini.flush();
    assert.equal(findById(mini.tree(), 'dap-model-deepseek-flash-maxTokens').props.value, '100K');

    // 写成展开的 384000（生效值就是 384K）：值没变，因此不该出现「待保存」，保存键也还禁用。
    change(findById(mini.tree(), 'dap-model-deepseek-flash-maxTokens'), '384000');
    await mini.flush();
    blur(findById(mini.tree(), 'dap-model-deepseek-flash-maxTokens'));
    await mini.flush();
    assert.equal(findById(mini.tree(), 'dap-model-deepseek-flash-maxTokens').props.value, '384K');
    assert.doesNotMatch(text(mini.tree()), /待保存/u);
    assert.equal(findById(mini.tree(), 'dap-model-deepseek-flash-save').props.disabled, true);
    assert.deepEqual(harness.editCalls, []);
  });

  it('非法的容量在本地就被挡下来，不打端点', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openModel(mini, 'deepseek-flash');

    // 不在词汇里的写法（后缀只认 K/M）、不是整数的、小于 1 的，都在本地挡下。
    for (const bad of ['0', '1.5', '1G', '一百', '1MB']) {
      change(findById(mini.tree(), 'dap-model-deepseek-flash-maxTokens'), bad);
      await mini.flush();
      click(findById(mini.tree(), 'dap-model-deepseek-flash-save'));
      await mini.flush();
      assert.deepEqual(harness.editCalls, [], `${bad} 不该发出去`);
      assert.match(text(mini.tree()), /必须是不小于 1 的整数/u, `${bad} 该有一句人话`);
    }

    // 改回一个读得出来的写法就能存。
    change(findById(mini.tree(), 'dap-model-deepseek-flash-maxTokens'), '64K');
    await mini.flush();
    click(findById(mini.tree(), 'dap-model-deepseek-flash-save'));
    await mini.flush();
    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', { maxTokens: 64_000 }]]);
  });

  it('未服务的模型可以就地指定协议，让它变得可服务', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    await openModel(mini, 'gemini-2.5-flash');
    const tree = mini.tree();
    assert.equal(findById(tree, 'dap-model-gemini-2.5-flash-api').props.value, '', '没有覆盖时「跟随发现」');
    assert.match(text(tree), /填上协议可以让它在对应路由上发布/u);

    change(findById(tree, 'dap-model-gemini-2.5-flash-api'), 'openai-completions');
    await mini.flush();
    click(findById(mini.tree(), 'dap-model-gemini-2.5-flash-save'));
    await mini.flush();
    assert.deepEqual(plain(harness.editCalls), [['gemini-2.5-flash', { api: 'openai-completions' }]]);
  });

  it('端点失败时把原因摆在界面上，而不是留在控制台', async () => {
    const { mini, element } = driveClient({ fails: 'status' });
    mini.mount(element);
    await mini.flush();

    assert.match(text(mini.tree()), /面板暂时连不上后台/u);
  });
});
