/**
 * 客户端半边（源码 `src/client/`，被测的是打包产物 `lib/client.js`）的接线与页面行为。
 *
 * 这一份测试对着两件事：
 *
 * - **接缝**：上报的模块 id、`inject` 依赖、配置页注册到哪个槽位、注入面上的名字与形状、
 *   effect 的标签、样式表与字典的注册与撤销。这些是宿主与渲染器看见的东西，改一个字都是破坏
 *   性变更。
 * - **页面**：挂载之后读设置、改输入、按保存会走哪个端点、写成什么补丁、失败时界面说不说
 *   实话。页面逻辑几乎都在组件里，因此只能在能跑 effect 的渲染器里走一遍。
 *
 * 官方组件（`@deepseek-ai/dsh-client-ui-primitives`）按真实版本装在 devDependencies 里，但那只是
 * 为了让 `tsc -p tsconfig.client.json` 和打包器看见真实类型：这里**不跑**它们——vm 里没有模块表、
 * 也没有真的 React。因此 `react` 与官方原语都喂替身模块，替身钉住的是被测代码依赖的那个接缝——
 * prop 的名字与含义、按钮该在什么时候出现、`SettingsFormModel` 的草稿与围栏语义。官方组件的观感
 * 与行为不在本仓库的测试范围内，这里只保证被测代码依赖的那套语义与官方一致。
 *
 * 测的是**产物**而不是源码：客户端半边要先打包（`npm run build:client`，`npm test` 的 pretest 已经
 * 做了），因为 `window.__ModuleLoader__.load` 那层包法是打包器套上去的——那正是要钉住的契约之一。
 *
 * 渲染走 `test/support/mini-react`：它实现 `createElement` 与 automatic runtime 的
 * `jsx` / `jsxs` / `Fragment`，加上 `useState` + `useEffect`，按提交循环驱动到稳定，于是
 * 「挂载 → 拉设置 → 改输入 → 按保存」这条路径可以在纯 Node 里走完。
 *
 * @module dsh-aperture/test/client
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import vm from 'node:vm';

import { MiniReact, change, click, findAll, findById, findButton, text } from './support/mini-react.ts';
import type { HostElement } from './support/mini-react.ts';
import { PANEL_INVOCATIONS, PANEL_NAMESPACE, PANEL_PACKAGE } from '../src/remote.ts';
import { APERTURE_NAMESPACE } from '../src/config.ts';
import type { PanelModel, PanelRefresh, PanelReport } from '../src/report.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 打包产物；`exports["./client"]` 指向的就是它。 */
const CLIENT_FILE = join(HERE, '..', 'lib', 'client.js');

/** 浏览半边上报的模块 id。 */
const PACKAGE = 'dsh-aperture';
/** 官方 UI 原语包名（本仓库里只有替身）。 */
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives';
/** 配置页注册的槽位。 */
const CONFIG_SLOT = 'plugins.bundle.config';
/** 字典命名空间。 */
const NS = 'settings.aperturePanel';
/** 设置命名空间。 */
const SETTINGS_NS = 'aperture';
/** 设置里这一页编辑的字段。 */
const FIELDS = ['baseUrl', 'sync'];
/** 样式表元素认领自己用的名字（官方那套 `data-plugin-css` 的写法：包名/文件名），与 `src/client/styles.ts` 里的常量一致。 */
const STYLE_OWNER = 'dsh-aperture/styles.css';

/** 上报给 `window.__ModuleLoader__` 的一份模块。 */
interface LoadedEntry {
  readonly id: string;
  readonly factory: (require: (id: string) => unknown) => unknown;
}

/** Remote 贡献里的一个端点描述符。 */
interface ClientDescriptor {
  readonly id: string;
  readonly service: string;
  readonly namespace: string;
  readonly method: string;
  readonly invocation: { readonly kind: string };
  readonly parameters: ReadonlyArray<{
    readonly name: string;
    readonly wire: string;
    readonly source: string;
    readonly codec: Codec;
  }>;
  readonly result: unknown;
}

/** 端点描述符上的编解码器（直通：原样过线）。 */
interface Codec {
  readonly mode: string;
  readonly typeSymbol: string;
  readonly create: () => { readonly parse: (value: unknown) => unknown };
}

/** 一个设置项的一次写入。 */
type SettingsOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] };

/** 一行模型的覆盖补丁；`null` 表示整条撤掉。 */
interface ModelPatch {
  readonly name?: string | null;
  readonly api?: string | null;
  readonly contextWindow?: number | null;
  readonly maxTokens?: number | null;
  readonly input?: readonly string[] | null;
  readonly thinking?: boolean | null;
  readonly alias?: string | null;
}

/**
 * 夹具的三种形状直接用宿主那份报告类型，不再照抄一遍。
 *
 * 抄过的那一份已经飘过一次：它多出一个 `PanelReport` 从来没有过的 `summary`，而页面根本不读
 * 这个字段，于是谁也没发现。改成别名之后，宿主删一个字段、改一个名字，这里当场编译不过。
 */
type ModelView = PanelModel;
type RefreshView = PanelRefresh;
type Report = PanelReport;

/** 设置接缝那一份快照（真实快照上还有别的字段，这一页只读这几个）。 */
interface SectionState {
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly value?: { readonly baseUrl?: unknown; readonly sync?: unknown } | undefined;
  /** 用户层：这一项**覆盖过**没有，看它在这里在不在，不看值跟谁相等。 */
  readonly user?: Record<string, unknown> | undefined;
  /** 用户层之下的合成值；官方那一份拿它当「恢复默认」之后该显示的东西。 */
  readonly base?: { readonly baseUrl?: unknown; readonly sync?: unknown } | undefined;
  readonly revision?: number | undefined;
  readonly writable?: boolean | undefined;
}

/** 设置表单模型要看到的那一份控制器（官方 `SettingsFormScope` 的替身）。 */
interface FormFace {
  getSnapshot: () => SectionState;
  subscribe: (listener: () => void) => () => void;
  mutate: (ops: readonly SettingsOp[], revision?: number | undefined) => Promise<boolean>;
}

/** 替身控制器另外给测试用的那点东西。 */
interface FakeForm extends FormFace {
  /** 从宿主那边推一份新快照过来（订阅者应当被叫醒）。 */
  publish(overrides: Partial<SectionState>): void;
}

/** 一次动作的结果（`PanelAction`）：落地了没有，加一句人话。 */
interface PanelAction {
  readonly ok: boolean;
  readonly summary: string;
}

/** 半边要挂到 Remote 服务上的那份贡献。 */
interface RemoteContribution {
  readonly package: string;
  readonly descriptors: readonly ClientDescriptor[];
}

/** 注入面：官方设置表单与报告端点。 */
interface InjectFace {
  readonly hooks: { readonly apertureCard: { getSnapshot: () => unknown; subscribe: (l: () => void) => () => void } };
  readonly panel: {
    status: () => Promise<Report>;
    /** 跑一轮发现：回来的是一句结果，不是报告。 */
    refresh: () => Promise<PanelAction>;
    /** 写一行模型；`null` 是整条撤回。 */
    writeModel: (id: string, patch: ModelPatch | null) => Promise<PanelAction>;
  };
  readonly edit: (field: string, text: string) => void;
  /** 「恢复默认」：官方那一份只**落草稿**，落笔要等保存。 */
  readonly resetField: (field: string) => void;
  readonly discard: () => void;
  /** 保存：官方那一份回的是 `Promise<void>`，成没成看 `failed()`。 */
  readonly save: () => Promise<void>;
  readonly failed: () => boolean;
}

/** 注册到槽位上的那一份贡献。 */
interface Registration {
  readonly options: {
    readonly name: string;
    readonly key: string;
    readonly locale: string;
    readonly inject: () => InjectFace;
  };
  readonly component: unknown;
}

/** 假 DOM 里的一张样式表。 */
interface FakeStyle {
  readonly dataset: Record<string, string>;
  textContent: string;
  parentNode: { removeChild(node: unknown): void } | null;
  removed: boolean;
}

/** 半边导出的那点成员。 */
interface ClientExports {
  readonly name: string;
  readonly inject: readonly string[];
  readonly apply: (ctx: unknown) => void;
  readonly NS: string;
  readonly SETTINGS_NS: string;
  readonly FIELDS: readonly string[];
  readonly REMOTE: RemoteContribution;
}

/** 一次加载攒下来的观测面。 */
interface Harness {
  readonly exports: ClientExports;
  /** `$mount` 收到的那份贡献；挂载是异步的，flush 之后才有。 */
  mounted?: RemoteContribution;
  readonly mini: MiniReact;
  readonly effectLabels: string[];
  readonly disposers: Record<string, () => void>;
  readonly localeNamespaces: string[];
  readonly dictionaries: Record<string, { zh: Record<string, string>; en: Record<string, string> }>;
  readonly registrations: Registration[];
  /** `ctx.inject` 声明的依赖。 */
  readonly dependencies: string[];
  /** `slots.inject` 要过的槽位。 */
  readonly slotInjections: string[];
  readonly styles: FakeStyle[];
  readonly panelCalls: string[];
  readonly writes: Array<{ readonly ops: readonly SettingsOp[]; readonly revision: number | undefined }>;
  readonly editCalls: Array<[string, ModelPatch | null]>;
  readonly configNamespaces: string[];
  readonly formReads: string[];
  readonly consoleErrors: unknown[];
  /** 控制器上挂着的订阅者数量；`dispose()` 之后必须回到 0。 */
  subscriptions: number;
}

/** 造端点的行为开关。 */
interface FakePanelOptions {
  readonly report?: Report;
  readonly section?: Partial<SectionState>;
  /** 控制器回绝写入。 */
  readonly refused?: boolean;
  /**
   * 让某一个端点出错：
   *
   * - `'status'`：面板整个连不上（调用失败，页面拿到的是「连不上」那句话）。
   * - `'refresh'`：面板在，但这一轮发现没成功（`ok: false` 加一句原因）。
   * - `'edit'`：写这一行的时候面板连不上（调用失败）。
   */
  readonly fails?: 'status' | 'refresh' | 'edit';
}

/** 一次 `driveClient` 交出来的东西。 */
interface Driven {
  readonly harness: Harness;
  readonly mini: MiniReact;
  readonly controller: FakeForm;
  readonly props: Record<string, unknown>;
  readonly element: unknown;
  readonly t: (key: string, params?: Record<string, unknown>) => string;
}

// ---------------------------------------------------------------------- 夹具

/** 报告里那个已经发布在路由上的模型。 */
function deepseek(overrides: Partial<ModelView> = {}): ModelView {
  return {
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
    ...overrides,
  };
}

/** 报告里那个还没有路由可服务的模型。 */
function gemini(overrides: Partial<ModelView> = {}): ModelView {
  return {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    endpoints: [],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    input: ['text'],
    reasoning: false,
    provenance: { limits: 'models.dev', reasoning: 'default', input: 'models.dev', name: 'models.dev' },
    overrideKeys: [],
    ...overrides,
  };
}

/** 默认那份报告。 */
function report(overrides: Partial<Report> = {}): Report {
  return {
    place: 'https://ai.example.ts.net',
    refresh: {
      trigger: '配置变更',
      at: '2026-09-24T08:00:00.000Z',
      durationMs: 286,
      ok: true,
      catalog: { available: true, entries: 422 },
      endpoint: { url: 'https://ai.example.ts.net/v1/models', listed: 16 },
      sync: { applied: true, ops: 2, routes: ['aperture', 'aperture-anthropic'] },
    },
    routes: [
      { provider: 'aperture', api: 'openai-completions', baseURL: 'https://ai.example.ts.net/v1', models: 1 },
    ],
    models: [deepseek(), gemini()],
    ...overrides,
  };
}

/** 默认那份设置快照。 */
function section(overrides: Partial<SectionState> = {}): SectionState {
  return {
    status: 'ready',
    value: { baseUrl: 'https://ai.example.ts.net', sync: true },
    // 用户层里只有 baseUrl：于是「已覆盖」与「恢复默认」只在地址那一项上。
    user: { baseUrl: 'https://ai.example.ts.net' },
    // 用户层之下的合成值：sync 的缺省是开，baseUrl 没有缺省（于是「恢复默认」把输入框清空）。
    base: { sync: true },
    revision: 4,
    writable: true,
    ...overrides,
  };
}

// ------------------------------------------------------------ 官方组件的替身

/** 官方设置表单交给页面的那份状态。 */
interface ShellState {
  readonly available: boolean;
  readonly writable: boolean;
  readonly dirty: boolean;
  readonly invalid: boolean;
  readonly saving: boolean;
  readonly failed: boolean;
}

/** 官方设置表单里一个字段此刻的样子。 */
interface FieldState {
  readonly text: string;
  readonly overridden: boolean;
  readonly invalid: boolean;
}

/** 一个字段的读写规格（`SettingsFieldSpec`）。 */
interface FieldSpec {
  readonly field: string;
  readonly format: (value: unknown) => string;
  readonly parse: (text: string) =>
    | { readonly kind: 'clear' }
    | { readonly kind: 'set'; readonly value: unknown }
    | undefined;
}

/** 文本字段：原样读写，空串是「这一项不覆盖」。被测代码只从这个包里要这一种字段规格。 */
function settingsTextField(field: string): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)),
    parse: (text) => (text === '' ? { kind: 'clear' } : { kind: 'set', value: text }),
  };
}

/**
 * `SettingsFormModel` 的替身：官方那一份的**语义**，不是它的实现。
 *
 * 被测代码只经手它这四件事，因此这四件必须像真的：
 *
 * - `shell()`：`available` 来自快照的 `status`；`dirty` / `invalid` 由草稿算出来；
 *   `saving` / `failed` 是这一份模型自己的状态。
 * - `field(name)` 的 `overridden` 是「这一刻这一项算不算覆盖」：没动过的时候看**用户层里在不在**
 *   （`stored`），落过草稿就按草稿会不会写成 `set` 算。于是文档里早就写过 baseUrl 时，页面一挂载
 *   就该挂着「已覆盖」，而把输入框清空又会让这个标签当场消失。
 * - `resetField` 与 `edit` 都只**落草稿**，落笔全在 `save()`；`save()` 只把改动过的字段拼成 op，
 *   带上**第一次落草稿时读到的那个 `revision`**（不是保存那一刻的）交给控制器；回绝时 `failed`
 *   亮起、草稿留着（用户写的东西不该因为一次冲突没写成就消失）。没有可写的改动、只读、或草稿
 *   非法时，`save()` 连端点都不碰。
 * - `bind(project)`：返回官方的选择器 store；草稿或快照一变就重新投影并叫醒订阅者。
 */
class FakeSettingsFormModel {
  private readonly scope: FormFace;
  private readonly specs: readonly FieldSpec[];
  /** 落下的草稿：`clear` 是「恢复默认」那一路（真模型把两者存在同一个 `staged` 里）。 */
  private readonly staged = new Map<string, { readonly text: string; readonly clear: boolean }>();
  private readonly listeners = new Set<() => void>();
  private readonly stop: () => void;
  /** 第一次落草稿时读到的快照；写入的 `revision` 围栏取自它。 */
  private baseline: SectionState | undefined;
  private saving = false;
  private failed = false;
  private projected: unknown = null;

  constructor(scope: FormFace, specs: readonly FieldSpec[]) {
    this.scope = scope;
    this.specs = specs;
    this.stop = scope.subscribe(() => this.invalidate());
  }

  /** 官方表单要的那份状态。 */
  shell(): ShellState {
    const snapshot = this.scope.getSnapshot();
    const plan = this.plan();
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable === true,
      // 非法草稿也是一条计划（它挡下保存），因此同样算「有改动」。
      dirty: plan.ops.length > 0 || plan.invalid,
      invalid: plan.invalid,
      saving: this.saving,
      failed: this.failed,
    };
  }

  /** 一个字段在输入框里的样子。 */
  field(name: string): FieldState {
    const spec = this.specOf(name);
    const staged = this.staged.get(name);
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(name)), overridden: this.stored(name), invalid: false };
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text);
    return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined };
  }

  /** 页面拿得到的动作面。 */
  actions(): {
    edit: (field: string, text: string) => void;
    resetField: (field: string) => void;
    save: () => void;
    discard: () => void;
  } {
    return {
      edit: (field, text) => {
        this.stage(field, { text, clear: false });
      },
      resetField: (field) => {
        // 官方那一份把「恢复默认」也落成草稿：输入框回到用户层之下的值，写入要等保存那一下。
        this.stage(field, { text: this.specOf(field).format(this.baseValue(field)), clear: true });
      },
      save: () => {
        void this.save();
      },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return;
        this.staged.clear();
        this.baseline = undefined;
        this.failed = false;
        this.invalidate();
      },
    };
  }

  /** 官方表单那颗保存按钮走的路：把改动过的那几项拼成一次带版本围栏的写入。 */
  async save(): Promise<void> {
    const plan = this.plan();
    // 官方的围栏：没有可写的改动、正在保存、文档只读、草稿非法，四样里占一样就直接返回。
    if (plan.ops.length === 0 || this.saving || this.scope.getSnapshot().writable !== true || plan.invalid) return;
    this.saving = true;
    this.failed = false;
    this.invalidate();
    try {
      if (!(await this.scope.mutate(plan.ops, this.baseline?.revision))) {
        this.failed = true;
        return;
      }
      this.staged.clear();
      this.baseline = undefined;
    } catch {
      this.failed = true;
    } finally {
      this.saving = false;
      this.invalidate();
    }
  }

  /** 给渲染器的选择器 store（投影缓存到下一次通知为止）。 */
  bind(project: () => unknown): { getSnapshot: () => unknown; subscribe: (listener: () => void) => () => void } {
    return {
      getSnapshot: () => {
        if (this.projected === null) this.projected = project();
        return this.projected;
      },
      subscribe: (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
    };
  }

  /** 卸载：断开对控制器的订阅。 */
  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private specOf(name: string): FieldSpec {
    const spec = this.specs.find((candidate) => candidate.field === name);
    if (spec === undefined) throw new Error(`没有这个字段：${name}`);
    return spec;
  }

  /** 生效值：用户层盖过之后这一页实际读到的那个。 */
  private sectionValue(name: string): unknown {
    return this.scope.getSnapshot().value?.[name as 'baseUrl' | 'sync'];
  }

  /** 用户层之下的合成值；「恢复默认」把输入框摆回这里。 */
  private baseValue(name: string): unknown {
    return this.scope.getSnapshot().base?.[name as 'baseUrl' | 'sync'];
  }

  /** 这一项在不在用户层里——真模型就是这么判「覆盖过没有」的，不比值。 */
  private stored(field: string): boolean {
    const user = this.scope.getSnapshot().user;
    return user !== undefined && Object.hasOwn(user, field);
  }

  /** 落一份草稿；第一次落的时候记住基线快照（写入的 `revision` 围栏取自它）。 */
  private stage(field: string, edit: { readonly text: string; readonly clear: boolean }): void {
    this.baseline ??= this.scope.getSnapshot();
    this.staged.set(field, edit);
    this.failed = false;
    this.invalidate();
  }

  /** 一次保存会写什么：按落草稿的顺序，逐项算出 op 或「这一项不合法」。 */
  private plan(): { ops: SettingsOp[]; invalid: boolean } {
    const ops: SettingsOp[] = [];
    let invalid = false;
    for (const [field, staged] of this.staged) {
      const spec = this.specOf(field);
      // 「恢复默认」只有在这一项**确实覆盖过**时才有东西可撤。（真模型的 `stored`。）
      if (staged.clear) {
        if (this.stored(field)) ops.push({ op: 'unset', path: [field] });
        continue;
      }
      // 与生效值字面相同的草稿不算改动（真模型比的是解析后的值）。
      if (staged.text === spec.format(this.sectionValue(field))) continue;
      const write = spec.parse(staged.text);
      if (write === undefined) {
        invalid = true;
        continue;
      }
      ops.push(write.kind === 'clear'
        ? { op: 'unset', path: [field] }
        : { op: 'set', path: [field], value: write.value });
    }
    return { ops, invalid };
  }

  private invalidate(): void {
    this.projected = null;
    for (const listener of this.listeners) listener();
  }
}

/** 造出官方原语替身：只有被测代码用到的那些组件与那一个模型。 */
function createPrimitives(renderer: MiniReact): Record<string, unknown> {
  /** `React.createElement`；替身渲染出来的全是宿主标签（`form` / `input` / `button`…）。 */
  const h = renderer.createElement;

  const SettingsForm = (raw: Record<string, unknown>): unknown => {
    const props = raw as {
      labels: { unavailable: string; readOnly: string; saveFailed: string; save: string; saving: string };
      state: ShellState;
      onSave: () => void;
      children?: unknown;
    };
    const { labels, state } = props;
    if (!state.available) return h('form', null, labels.unavailable);
    return h(
      'form',
      null,
      state.writable ? null : h('p', { className: 'sf-readOnly' }, labels.readOnly),
      state.failed ? h('p', { className: 'sf-saveFailed' }, labels.saveFailed) : null,
      h(
        'button',
        { type: 'button', disabled: !state.writable || state.saving, onClick: props.onSave },
        state.saving ? labels.saving : labels.save,
      ),
      props.children,
    );
  };

  const SettingsValueField = (raw: Record<string, unknown>): unknown => {
    const props = raw as {
      id: string;
      label: string;
      hint: string;
      placeholder?: string;
      text: string;
      overridden: boolean;
      invalid: boolean;
      disabled: boolean;
      overriddenLabel: string;
      resetLabel: string;
      invalidLabel: string;
      onEdit: (text: string) => void;
      onReset: () => void;
      help?: { label: string; content: unknown };
    };
    return h(
      'label',
      null,
      props.label,
      h('span', { className: 'sf-hint' }, props.hint),
      // 真字段把长解释收在「i」按钮里，替身也留一个，好让那些句子仍进得了断言。
      props.help === undefined
        ? null
        : h('button', { type: 'button', className: 'sf-help', title: props.help.label }, props.help.content),
      h('input', {
        id: props.id,
        ...(props.placeholder === undefined ? {} : { placeholder: props.placeholder }),
        value: props.text,
        disabled: props.disabled,
        onChange: (event: { target: { value: string } }) => props.onEdit(event.target.value),
      }),
      props.overridden ? h('span', { className: 'sf-badges' }, props.overriddenLabel) : null,
      props.overridden
        ? h(
          'button',
          { type: 'button', id: `${props.id}-reset`, onClick: props.onReset, disabled: props.disabled },
          props.resetLabel,
        )
        : null,
      props.invalid ? h('span', { className: 'sf-invalid' }, props.invalidLabel) : null,
    );
  };

  const Switch = (raw: Record<string, unknown>): unknown => {
    const props = raw as {
      checked: boolean;
      label?: string;
      disabled?: boolean;
      onChange: (checked: boolean) => void;
    };
    return h(
      'button',
      {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        disabled: props.disabled === true,
        onClick: () => props.onChange(!props.checked),
      },
      props.label ?? null,
    );
  };

  const Checkbox = (raw: Record<string, unknown>): unknown => {
    const props = raw as { checked: boolean; label?: string; disabled?: boolean; onChange: (checked: boolean) => void };
    return h(
      'button',
      {
        type: 'button',
        role: 'checkbox',
        'aria-checked': props.checked ? 'true' : 'false',
        disabled: props.disabled === true,
        onClick: () => props.onChange(!props.checked),
      },
      props.label ?? null,
    );
  };

  const Button = (raw: Record<string, unknown>): unknown => {
    const props = raw as { onClick?: () => void; disabled?: boolean; title?: string; icon?: unknown; children?: unknown };
    return h(
      'button',
      {
        type: 'button',
        onClick: props.onClick,
        disabled: props.disabled === true,
        ...(props.title === undefined ? {} : { title: props.title }),
      },
      props.icon ?? null,
      props.children,
    );
  };

  /** 图标替身：真图标是 svg，这里只要能进树、能认出来就够。 */
  const Icon = (raw: Record<string, unknown>): unknown => h('span', { className: 'sf-icon', size: raw.size });

  const Tag = (raw: Record<string, unknown>): unknown => {
    const props = raw as { tone?: string; children?: unknown };
    return h('span', { tone: props.tone ?? 'neutral' }, props.children);
  };

  const StateDot = (raw: Record<string, unknown>): unknown => {
    const props = raw as { state?: string; size?: number };
    return h('span', { state: props.state ?? 'idle', size: props.size ?? 8 });
  };

  const DisclosureRow = (raw: Record<string, unknown>): unknown => {
    const props = raw as {
      icon?: unknown;
      title?: unknown;
      open: boolean;
      expandable?: boolean;
      onToggle?: () => void;
      collapsedContent?: unknown;
      children?: unknown;
    };
    return h(
      'div',
      { className: 'sf-disclosure', 'aria-expanded': props.open ? 'true' : 'false' },
      props.icon ?? null,
      h('span', { className: 'sf-title' }, props.title),
      // 真的折叠按钮里是一枚图标；替身拿一个字符顶着，好让渲染出来的树看得懂。
      h(
        'button',
        { type: 'button', 'aria-expanded': props.open ? 'true' : 'false', onClick: props.onToggle },
        props.open ? '▾' : '▸',
      ),
      props.open ? props.children : props.collapsedContent,
    );
  };

  const SegmentedControl = (raw: Record<string, unknown>): unknown => {
    const props = raw as {
      id: string;
      label?: string;
      value: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      onChange: (value: string) => void;
      disabled?: boolean;
    };
    return h(
      'div',
      { className: 'sf-segmented' },
      props.options.map((option) => h(
        'button',
        {
          type: 'button',
          id: `${props.id}-${option.value}`,
          disabled: props.disabled === true,
          // 选中的那一项同时挂上两个标记，替身之外的两个方向都能认出来。
          ...(option.value === props.value
            ? { 'aria-pressed': 'true', 'data-active': '' }
            : { 'aria-pressed': 'false' }),
          onClick: () => props.onChange(option.value),
        },
        option.label,
      )),
    );
  };

  return {
    SettingsForm,
    SettingsValueField,
    Switch,
    Checkbox,
    Button,
    Tag,
    StateDot,
    DisclosureRow,
    SegmentedControl,
    SettingsFormModel: FakeSettingsFormModel,
    settingsTextField,
    IconChevronRightOutlineRegular: Icon,
    IconRefreshOutlineRegular: Icon,
  };
}

// ------------------------------------------------------------------ 假 DOM

/** 一张样式表要像的那点样子：`dataset`、`textContent`、`parentNode.removeChild`。 */
function fakeDocument(styles: FakeStyle[]): Record<string, unknown> {
  const head = {
    appendChild(node: FakeStyle) {
      styles.push(node);
      node.parentNode = { removeChild: (child: unknown) => { if (child === node) node.removed = true; } };
      return node;
    },
    removeChild(node: FakeStyle) {
      node.removed = true;
      return node;
    },
  };
  return {
    head,
    createElement: (tag: string) => (tag === 'style'
      ? { dataset: {}, textContent: '', parentNode: null, removed: false }
      : { dataset: {}, parentNode: null }),
    // `installStyles` 拿这个把上一次自己插进去的那张删掉（热替换）。
    querySelector: (selector: string) => {
      const match = /^style\[data-plugin-css="(.+)"\]$/u.exec(selector);
      if (match === null) return null;
      return styles.find((style) => style.dataset.pluginCss === match[1] && style.removed !== true) ?? null;
    },
  };
}

// --------------------------------------------------------------- 加载半边

/** 把半边加载起来：给它一个 `window` 与一个假的 `document`，`react` 与官方原语给替身。 */
function loadClient(): Harness {
  assert.ok(
    existsSync(CLIENT_FILE),
    `${CLIENT_FILE} 不存在：先打包客户端半边（npm run build:client）。`,
  );
  const reported: LoadedEntry[] = [];
  const styles: FakeStyle[] = [];
  const consoleErrors: unknown[] = [];
  const mini = new MiniReact();
  const primitives = createPrimitives(mini);
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (entry: LoadedEntry) => {
          reported.push(entry);
        },
      },
    },
    document: fakeDocument(styles),
    console: {
      error: (...args: unknown[]) => consoleErrors.push(args),
      warn: () => {},
      log: () => {},
    },
  };
  vm.runInNewContext(readFileSync(CLIENT_FILE, 'utf8'), sandbox, { filename: CLIENT_FILE });
  assert.equal(reported.length, 1, '半边应当只上报一份模块');
  const entry = reported[0]!;
  assert.equal(entry.id, PACKAGE);
  const exports = entry.factory((id: string) => {
    if (id === 'react') return mini;
    // JSX 走 automatic runtime：`jsx` / `jsxs` / `Fragment` 由替身一并提供。
    if (id === 'react/jsx-runtime') return mini;
    if (id === PRIMITIVES) return primitives;
    throw new Error(`客户端半边不应在运行时 require "${id}"：平台基线之外没有模块可解析`);
  }) as ClientExports;
  return {
    exports,
    mini,
    effectLabels: [],
    disposers: {},
    localeNamespaces: [],
    dictionaries: {},
    registrations: [],
    dependencies: [],
    slotInjections: [],
    styles,
    panelCalls: [],
    writes: [],
    editCalls: [],
    configNamespaces: [],
    formReads: [],
    consoleErrors,
    subscriptions: 0,
  };
}

// --------------------------------------------------------------- 假控制器

/** 造一个设置控制器：记下每次写入，还能从「宿主那边」推一份新快照过来。 */
function fakeForm(harness: Harness, options: FakePanelOptions): FakeForm {
  let state = section(options.section);
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => {
      harness.formReads.push(state.status);
      return state;
    },
    subscribe: (listener) => {
      harness.subscriptions += 1;
      listeners.add(listener);
      return () => {
        harness.subscriptions -= 1;
        listeners.delete(listener);
      };
    },
    mutate: async (ops, revision) => {
      harness.writes.push({ ops, revision });
      // 只记账，不把写入回灌进快照：真宿主会让 `user` 跟着变，这一份替身故意留简单。因此用例
      // 不该断言「保存之后快照长什么样」——那是宿主那一半的实现。
      return options.refused !== true;
    },
    publish: (overrides) => {
      state = section({ ...options.section, ...overrides });
      for (const listener of listeners) listener();
    },
  };
}

/** 造一个报告端点命名空间：`{ok: true, value}` 或 `{ok: false, error}`。 */
function fakeNamespace(harness: Harness, options: FakePanelOptions): Record<string, unknown> {
  const payload = options.report ?? report();
  /** 一次动作的结果（`PanelAction`）：宿主那边已经跑完了一轮发现。 */
  const action = { ok: true as const, summary: '已重新发现并发布。' };
  return {
    status: async () => {
      harness.panelCalls.push('status');
      // 面板整个连不上：这一层失败是「调用」失败，抛给页面的是那句连不上的话。
      return options.fails === 'status'
        ? { ok: false as const, error: { code: 'unavailable', message: '后台还没起来' } }
        : { ok: true as const, value: payload };
    },
    refresh: async () => {
      harness.panelCalls.push('refresh');
      // 面板在，但这轮发现没成功：端点照样按契约回话，只是 ok 是 false。
      return options.fails === 'refresh'
        ? { ok: true as const, value: { ok: false as const, summary: '刷新没有成功：网关没回应' } }
        : { ok: true as const, value: action };
    },
    edit: async (id: string, patch: ModelPatch | null) => {
      harness.panelCalls.push('edit');
      harness.editCalls.push([id, patch]);
      // 写这一行的时候面板连不上：调用失败，原因要出现在界面上。
      return options.fails === 'edit'
        ? { ok: false as const, error: { code: 'unavailable', message: '写这一行的时候后台断了' } }
        : { ok: true as const, value: action };
    },
  };
}

// ------------------------------------------------------------ 注入面与挂载

/**
 * 槽位渲染器把注入面里的 `hooks` 变成 `useXxx` 选择器钩子：`useState` 存当前投影，
 * `useEffect` 订阅 store、变了就重渲染。依赖数组是空的（只订阅一次）——这是渲染器那一侧的
 * 钩子，不参与「组件自己的 effect 依赖里不能有对象」那条守卫。
 */
function slotHooks(mini: MiniReact, hooks: Record<string, { getSnapshot: () => unknown; subscribe: (l: () => void) => () => void }>): Record<string, unknown> {
  const built: Record<string, unknown> = {};
  for (const [name, store] of Object.entries(hooks)) {
    const hookName = `use${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    built[hookName] = (selector: (snapshot: unknown) => unknown): unknown => {
      const [snapshot, setSnapshot] = mini.useState<unknown>(() => store.getSnapshot());
      mini.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), []);
      return selector(snapshot);
    };
  }
  return built;
}

/** 把半边 apply 起来，再把配置页当成渲染器那样挂上去。 */
function driveClient(options: FakePanelOptions = {}, withoutService = false): Driven {
  const harness = loadClient();

  /** locale 服务给的那支 `t`：字典里没有就原样漏出键名，占位符由这里填。 */
  const translate = (namespace: string, key: string, params?: Record<string, unknown>): string => {
    const template = harness.dictionaries[namespace]?.zh[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/gu, (match, name: string) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
  };
  const t = (key: string, params?: Record<string, unknown>): string => translate(NS, key, params);

  const controller = fakeForm(harness, options);
  const namespace = fakeNamespace(harness, options);

  const effect = (fn: () => unknown, label: string): unknown => {
    harness.effectLabels.push(label);
    const disposer = fn();
    if (typeof disposer === 'function') harness.disposers[label] = disposer as () => void;
    return disposer;
  };

  const scope = {
    locale: { bind: (namespace0: string) => (key: string, params?: Record<string, unknown>) => translate(namespace0, key, params) },
    remote: { [PANEL_NAMESPACE]: namespace },
    slots: {
      inject: (name: string, run: () => void) => {
        harness.slotInjections.push(name);
        run();
      },
      register: (options0: Registration['options'], component: unknown) => {
        harness.registrations.push({ options: options0, component });
        return () => {};
      },
    },
    effect,
  };

  const ctx = {
    effect,
    inject: (names: readonly string[], run: (scope0: unknown) => void) => {
      harness.dependencies.push(...names);
      run(scope);
    },
    locale: {
      register: (namespace0: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }) => {
        harness.localeNamespaces.push(namespace0);
        harness.dictionaries[namespace0] = dictionaries;
        return () => {};
      },
    },
    remote: {
      $mount: async (contribution: { package: string; descriptors: readonly ClientDescriptor[] }) => {
        harness.mounted = contribution;
        return async () => {};
      },
    },
    configForms: withoutService
      ? undefined
      : {
        get: (namespace0: string) => {
          harness.configNamespaces.push(namespace0);
          return controller;
        },
      },
  };

  harness.exports.apply(ctx);

  const registration = harness.registrations[0];
  assert.ok(registration, '配置页应当注册到槽位上');

  // 渲染器每轮渲染都会重新组装注入面。这里用一组 getter 把这件事还原：每读一次都是新的包装
  // 对象（里面的函数与 store 仍是同一份）。因此「把注入面放进 effect 依赖」在真渲染器里会自
  // 激，在这里却不会自己炸——那条守卫得靠 `hookDeps` 与渲染次数上限直接钉。
  const props: Record<string, unknown> = {
    t,
    get useApertureCard() {
      return slotHooks(harness.mini, registration.options.inject().hooks).useApertureCard;
    },
    get panel() {
      return registration.options.inject().panel;
    },
    get edit() {
      return registration.options.inject().edit;
    },
    get resetField() {
      return registration.options.inject().resetField;
    },
    get discard() {
      return registration.options.inject().discard;
    },
    get save() {
      return registration.options.inject().save;
    },
    get failed() {
      return registration.options.inject().failed;
    },
  };

  return {
    harness,
    mini: harness.mini,
    controller,
    props,
    element: harness.mini.createElement(registration.component, props),
    t,
  };
}

// ------------------------------------------------------------------ 小工具

/** 跨 realm 的东西（组件在 vm 里造的对象）没法直接 deepEqual，先过一遍 JSON。 */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** 页面上那句提示语。 */
function bannerOf(mini: MiniReact): HostElement {
  const [found] = findAll(mini.tree(), (node) => node.props.className === 'dap-banner');
  assert.ok(found, '页面上应当有一句提示语');
  return found;
}

/** 一个模型的 `li`。 */
function rowOf(mini: MiniReact, id: string): HostElement {
  const [found] = findAll(mini.tree(), (node) => node.type === 'li' && node.props.key === id);
  assert.ok(found, `找不到模型行 ${id}`);
  return found;
}

/** 一行里那个折叠按钮。 */
function toggleOf(row: HostElement): HostElement {
  const [found] = findAll(row, (node) => node.type === 'button' && node.props['aria-expanded'] !== undefined);
  assert.ok(found, '这一行应当有一个折叠按钮');
  return found;
}

/** 展开一行模型。 */
async function openRow(mini: MiniReact, id: string): Promise<void> {
  click(toggleOf(rowOf(mini, id)));
  await mini.flush();
}

/** 一行里的一颗按钮。 */
function rowButton(mini: MiniReact, id: string, label: string): HostElement {
  return findButton(rowOf(mini, id), label);
}

/**
 * 这一行那颗保存按钮。
 *
 * 不能用 `rowButton(..., '保存')`：`findButton` 是「文本包含」，而行首那颗折叠按钮把名字、标签与
 * 事实一起读进来——改过东西之后标签里就有「有未保存的改动」，于是「包含保存」的第一个按钮是行首那颗，
 * 一点就把这一行收起来了。这里按整段文本量，跟设置表单那颗保存按钮同一个办法。
 */
function rowSave(mini: MiniReact, id: string): HostElement {
  const [found] = findAll(rowOf(mini, id), (node) => node.type === 'button'
    && (text(node) === '保存' || text(node) === '保存中…'));
  assert.ok(found, `模型行 ${id} 应当有一颗保存按钮`);
  return found;
}

/** 设置表单那颗保存按钮：文案随 `state.saving` 变，因此按「在 form 里」定位。 */
function settingsSave(mini: MiniReact): HostElement {
  const [form] = findAll(mini.tree(), (node) => node.type === 'form');
  assert.ok(form, '页面里应当有官方设置表单');
  const [save] = findAll(form, (node) => node.type === 'button' && (text(node) === '保存' || text(node) === '保存中…'));
  assert.ok(save, '设置表单应当有一颗保存按钮');
  return save;
}

/** 设置表单那两行：`baseUrl` 的输入框与 `sync` 的开关。 */
function addressInput(mini: MiniReact): HostElement {
  return findById(mini.tree(), 'dap-base-url');
}

function syncSwitch(mini: MiniReact): HostElement {
  const [found] = findAll(mini.tree(), (node) => node.props.role === 'switch');
  assert.ok(found, '页面里应当有一个同步开关');
  return found;
}

/** 页面上的标签（替身把官方 `Tag` 渲染成带 `tone` 的 `span`）。 */
function tags(node: unknown): HostElement[] {
  return findAll(node, (element) => element.type === 'span' && element.props.tone !== undefined);
}

/** 分段控件此刻选中的那一项（替身把选中项写成 `aria-pressed="true"` 加 `data-active`）。 */
function activeSegment(node: unknown): string {
  const [pressed] = findAll(node, (element) => element.props['aria-pressed'] === 'true');
  assert.ok(pressed, '分段控件应当有一项是选中的');
  const marked = findAll(node, (element) => element.props['data-active'] !== undefined);
  assert.deepEqual(marked, [pressed], '选中的标记只该有一处');
  return text(pressed);
}

/** 千位分隔符跟随语言环境，跟着被测代码一起算就不会跟 locale 打架。 */
function count(value: number): string {
  return value.toLocaleString();
}

// -------------------------------------------------------------------- 用例

describe('客户端半边', () => {
  it('上报的模块 id 与依赖都是接缝的一部分', () => {
    const { harness } = driveClient();
    assert.equal(harness.exports.name, PACKAGE);
    assert.equal(harness.exports.NS, NS);
    assert.equal(harness.exports.SETTINGS_NS, SETTINGS_NS);
    assert.equal(harness.exports.SETTINGS_NS, APERTURE_NAMESPACE, '设置命名空间必须与宿主那一半一致');
    assert.deepEqual([...harness.exports.FIELDS], FIELDS);
    // 声明的服务清单与真正去要的那一份必须对得上。
    assert.deepEqual(plain(harness.exports.inject), ['slots', 'locale', 'remote', 'configForms']);
    assert.deepEqual([...harness.dependencies], ['remote.aperturePanel']);
    assert.deepEqual([...harness.slotInjections], [CONFIG_SLOT]);
  });

  it('把 aperturePanel 贡献挂到 Remote 服务上', async () => {
    const { harness } = driveClient();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(harness.mounted, '应当调用 ctx.remote.$mount');
    assert.equal(harness.mounted.package, PANEL_PACKAGE);
    assert.equal(harness.mounted, harness.exports.REMOTE, '挂上去的就是导出的那一份贡献');
    assert.equal(harness.mounted.descriptors.length, PANEL_INVOCATIONS.length);
    assert.deepEqual(
      plain(harness.mounted.descriptors.map((descriptor) => descriptor.method)),
      PANEL_INVOCATIONS.map((invocation) => invocation.method),
    );
  });

  it('端点一一对应：方法名、参数名、调用方式与编解码器', async () => {
    const { harness } = driveClient();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(harness.mounted);
    for (const [index, descriptor] of harness.mounted.descriptors.entries()) {
      const expected = PANEL_INVOCATIONS[index]!;
      assert.equal(descriptor.id, `${PACKAGE}#${PANEL_NAMESPACE}/${expected.method}`);
      assert.equal(descriptor.service, PANEL_NAMESPACE);
      assert.equal(descriptor.namespace, PANEL_NAMESPACE);
      assert.equal(descriptor.invocation.kind, 'direct');
      assert.deepEqual(
        plain(descriptor.parameters.map((parameter) => parameter.name)),
        expected.parameters.map((parameter) => parameter.name),
      );
      const codec = descriptor.result as Codec;
      for (const parameter of descriptor.parameters) {
        assert.equal(parameter.wire, parameter.name, '参数名与线名一致，宿主按同一次序读');
        assert.equal(parameter.source, 'json');
        assert.equal(parameter.codec, descriptor.result, '参数的编解码器与结果同一份');
      }
      // 直通编解码器：值原样过线，因此端点两边的类型就是同一份 JSON。
      assert.equal(codec.mode, 'strict');
      assert.equal(codec.typeSymbol, `${PACKAGE}/types#any`);
      assert.equal(codec.create().parse('原样'), '原样');
      assert.equal(codec.create().parse(undefined), undefined);
      // 贡献要冻住：渲染器与注册表都会把它放进长期缓存。
      assert.equal(Object.isFrozen(descriptor), true);
      assert.equal(Object.isFrozen(descriptor.parameters), true);
      assert.equal(Object.isFrozen(codec), true);
    }
  });

  it('端点名不与 Remote 服务的保留成员撞车', async () => {
    const { harness } = driveClient();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(harness.mounted);
    const reserved = new Set([
      'ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace',
      'assertMethodAvailable', 'has', 'install', 'installDirect', 'installScoped', 'remove',
    ]);
    for (const descriptor of harness.mounted.descriptors) {
      assert.equal(reserved.has(descriptor.method), false, `${descriptor.method} 撞上了保留成员`);
    }
    assert.deepEqual(
      plain(harness.mounted.descriptors.map((descriptor) => descriptor.method).sort()),
      ['edit', 'refresh', 'status'],
    );
  });

  it('注入面上的名字与形状：hooks 与表单动作都在', () => {
    const { harness } = driveClient();
    const registration = harness.registrations[0]!;
    assert.equal(registration.options.name, CONFIG_SLOT);
    assert.equal(registration.options.key, PACKAGE);
    assert.equal(registration.options.locale, NS);
    // 页主只递 view，标题取自包元数据，因此这里不该再声明 id / order / label / tab。
    assert.deepEqual(Object.keys(registration.options).sort(), ['inject', 'key', 'locale', 'name']);

    const face = registration.options.inject();
    assert.equal(typeof face.hooks.apertureCard.getSnapshot, 'function');
    assert.equal(typeof face.hooks.apertureCard.subscribe, 'function');
    for (const name of ['status', 'refresh', 'writeModel'] as const) {
      assert.equal(typeof face.panel[name], 'function', `panel.${name} 应当是函数`);
    }
    for (const name of ['edit', 'resetField', 'discard', 'save', 'failed'] as const) {
      assert.equal(typeof face[name], 'function', `${name} 应当是函数`);
    }
  });

  it('设置那一份表单按命名空间去要，注册了字典与样式表，卸载时收回', () => {
    const { harness } = driveClient();
    assert.deepEqual([...harness.configNamespaces], [SETTINGS_NS]);
    assert.deepEqual([...harness.localeNamespaces], [NS]);

    assert.deepEqual([...harness.effectLabels], [
      'dsh-aperture: dictionaries',
      'dsh-aperture: stylesheet',
      'dsh-aperture: remote contribution',
      'dsh-aperture: settings form',
    ]);

    const zh = harness.dictionaries[NS]?.zh;
    const en = harness.dictionaries[NS]?.en;
    assert.ok(zh, '应当注册中文词典');
    assert.ok(en, '应当注册英文词典');
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '两种语言的键必须一一对应');
    assert.equal(zh.saveRow, '保存');
    assert.equal(en.saveRow, 'Save');
    assert.equal(zh.resetField, '恢复默认');
    assert.equal(zh.tab, undefined, '标题来自包元数据，字典里不该再有 tab 这一项');

    assert.equal(harness.styles.length, 1, '应当只注入一张样式表');
    const style = harness.styles[0]!;
    assert.equal(style.dataset.plugin, PACKAGE);
    assert.equal(style.dataset.pluginCss, STYLE_OWNER);
    assert.match(style.textContent, /\[data-dsh-aperture\]/u, '选择器必须收在根节点之下');
    assert.match(style.textContent, /\.dap-rows/u);
    assert.match(style.textContent, /\.dap-banner/u);
    assert.equal(style.removed, false);

    harness.disposers['dsh-aperture: stylesheet']?.();
    assert.equal(style.removed, true, '卸载时样式表要摘掉');
  });

  it('样式表：没有同名规则，也没有引用这一页没定义的 token', () => {
    const { harness } = driveClient();
    const css = harness.styles[0]?.textContent ?? '';
    assert.ok(css.length > 0, '应当注入样式表');

    // 同一个选择器写两遍，后一条会整条压掉前一条。`.dap-facts` 就吃过这个亏：报告那张 `dl` 先占了
    // 这个名字，模型行再拿它装事实，于是「路由 x · 协议 y」被报告的竖排规则压成了一条一行。
    const counts = new Map<string, number>();
    for (const [, raw = ''] of css.matchAll(/([^{}]+)\{/gu)) {
      const selector = raw.trim();
      if (selector === '' || selector.includes('@')) continue;
      counts.set(selector, (counts.get(selector) ?? 0) + 1);
    }
    assert.deepEqual(
      [...counts].filter(([, count]) => count > 1).map(([selector]) => selector),
      [],
      '同一个选择器不许定义两次',
    );
    assert.ok(counts.size > 20, `样式表里应当有几十条规则，实际 ${String(counts.size)} 条`);

    // 颜色只许用「这一页真的定义过」的名字，两类：Theme 检查面列出的那些，以及官方原语自己引用的那些。
    // 反例是 `--dsw-alias-settings-card-*`：它只活在官方「模型」页那份组件 CSS 里，插件页上没有定义，
    // `var()` 于是落到回落值（白 16% 的描边），亮色主题下白底白边——卡片连边都看不见。
    const allowed = new Set([
      // Theme 检查面（client / Theme / listTokens）列出的
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-overlay',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-brand-primary',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-state-error-primary',
      '--dsw-alias-state-idle-primary',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-warn-primary',
      '--dsw-specific-sidebar-fill',
      // 官方原语包自己引用的（在 primitives 的 *.module.css 里能搜到）
      '--dsw-alias-bg-layer-3',
      '--dsw-alias-border-l3',
      '--dsw-alias-border-l4',
      '--dsw-alias-interactive-bg-hover',
      '--dsw-alias-label-tertiary',
      '--dsw-alias-label-dimmed',
      '--dsw-alias-bg-module-platform',
      // 圆角：主题里定义的一整套，原语用的是 sm / md / lg
      '--dsw-radius-xs',
      '--dsw-radius-sm',
      '--dsw-radius-md',
      '--dsw-radius-lg',
      '--dsw-radius-xl',
    ]);
    const used = new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+)/gu)].map(([, name]) => name!));
    assert.ok(used.size > 5, `样式表里应当引用好几个 token，实际 ${String(used.size)} 个`);
    assert.deepEqual(
      [...used].filter((name) => !allowed.has(name)).sort(),
      [],
      '引用了这一页没定义的 token',
    );
  });

  it('表单订阅设置快照，dispose() 之后订阅者回到 0', () => {
    const { harness } = driveClient();
    assert.ok(harness.subscriptions >= 1, '表单模型要订阅控制器');
    harness.disposers['dsh-aperture: settings form']?.();
    assert.equal(harness.subscriptions, 0, '卸载之后不该还挂着一个订阅者');
  });

  it('挂载：读一次报告、读一次设置，页面上留下模型与路由', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    assert.ok(harness.panelCalls.includes('status'), '挂载要先读一次报告');
    assert.equal(harness.panelCalls.includes('refresh'), false, '读报告不该顺手刷新');
    const tree = mini.tree();
    assert.match(text(tree), /一行一个模型/u);
    // 设置表单那一段的输入框与提示语都在（模型那一段的断言各自另有用例）。
    assert.match(text(tree), /Aperture 的地址/u);
    assert.equal(findAll(tree, (node) => node.type === 'li' && node.props.className === 'dap-card').length, 2);
    assert.equal(findById(tree, 'dap-base-url').props.value, 'https://ai.example.ts.net');
    assert.equal(syncSwitch(mini).props['aria-checked'], 'true');
  });

  it('设置投影跟着控制器变，不必重挂', async () => {
    const { controller, mini, element, harness } = driveClient();
    mini.mount(element);
    await mini.flush();
    const before = harness.formReads.length;

    controller.publish({ value: { baseUrl: 'https://elsewhere.example.ts.net', sync: false } });
    await mini.flush();

    assert.equal(addressInput(mini).props.value, 'https://elsewhere.example.ts.net');
    assert.equal(syncSwitch(mini).props['aria-checked'], 'false');
    assert.ok(harness.formReads.length > before, '投影应当重新读一次快照');
  });

  it('改地址后保存：只写改过的那一项，带上读到的 revision，再等一轮重新发现', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    change(addressInput(mini), 'https://gateway.example.ts.net');
    await mini.flush();
    click(settingsSave(mini));
    await mini.flush();

    assert.deepEqual(plain(harness.writes), [{
      ops: [{ op: 'set', path: ['baseUrl'], value: 'https://gateway.example.ts.net' }],
      revision: 4,
    }]);
    assert.equal(harness.panelCalls.filter((call) => call === 'refresh').length, 1, '保存成功之后要重跑一轮');
    const banner = bannerOf(mini);
    assert.equal(banner.props['data-ok'], 'true');
    assert.match(text(banner), /已保存：已重新发现并发布/u);
  });

  it('同步开关也是同一份表单里的一项', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    click(syncSwitch(mini));
    await mini.flush();
    assert.equal(syncSwitch(mini).props['aria-checked'], 'false');
    click(settingsSave(mini));
    await mini.flush();

    assert.deepEqual(plain(harness.writes), [{
      ops: [{ op: 'set', path: ['sync'], value: false }],
      revision: 4,
    }]);
  });

  it('「已覆盖」看的是用户层里在不在这一项，不看值跟谁一样', async () => {
    const { mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    // 默认快照的 `user` 里只有 baseUrl，因此只有地址那一项挂着标签与「恢复默认」——文档里写过
    // 就算覆盖过，不必等用户先动一下手。
    assert.match(text(mini.tree()), /已覆盖/u);
    assert.equal(
      findAll(mini.tree(), (node) => node.props.id === 'dap-base-url-reset').length,
      1,
      '用户层里覆盖过的项才给「恢复默认」',
    );
    const [toggleRow] = findAll(mini.tree(), (node) => node.props.className === 'dap-toggleRow');
    assert.ok(toggleRow, '同步开关那一行');
    assert.equal(
      findAll(toggleRow, (node) => node.type === 'button' && text(node).includes('恢复默认')).length,
      0,
      '没覆盖过的那一项不给「恢复默认」',
    );
  });

  it('恢复默认：落一份「撤掉这一项」的草稿，保存那一下才写 unset', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    click(findById(mini.tree(), 'dap-base-url-reset'));
    await mini.flush();

    // 官方那一份把「恢复默认」也落成草稿：此刻一个 op 都还没写。输入框摆回用户层之下的值，
    // 「已覆盖」当场消失——这一项不再覆盖了。
    assert.deepEqual(harness.writes, [], '按一下「恢复默认」不落笔');
    assert.equal(addressInput(mini).props.value, '', '输入框回到用户层之下的值');
    assert.equal(
      findAll(mini.tree(), (node) => node.props.id === 'dap-base-url-reset').length,
      0,
      '撤掉覆盖，「已覆盖」跟着消失',
    );

    click(settingsSave(mini));
    await mini.flush();
    assert.deepEqual(
      plain(harness.writes),
      [{ ops: [{ op: 'unset', path: ['baseUrl'] }], revision: 4 }],
      '写的是 unset，不是一个默认值',
    );

    // 同步那一项用户层里本来就没有：改一下再「恢复默认」只是把草稿撤了，没有覆盖可撤，于是
    // 保存连端点都不碰，而生效值仍是开。
    click(syncSwitch(mini));
    await mini.flush();
    const [toggleRow] = findAll(mini.tree(), (node) => node.props.className === 'dap-toggleRow');
    assert.ok(toggleRow, '同步开关那一行');
    click(findButton(toggleRow, '恢复默认'));
    await mini.flush();
    click(settingsSave(mini));
    await mini.flush();

    assert.equal(harness.writes.length, 1, '没有覆盖可撤，就不写任何 op');
    assert.equal(syncSwitch(mini).props['aria-checked'], 'true', '撤掉的是覆盖，不是生效值');
  });

  it('注入面上的 discard 就是官方表单那颗「放弃」：丢草稿，不写任何东西', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    change(addressInput(mini), 'https://typo.example.ts.net');
    await mini.flush();
    assert.equal(addressInput(mini).props.value, 'https://typo.example.ts.net');

    // 替身没有画出「放弃」那颗按钮（官方表单长什么样不在这一份测试的范围里），这里直接按
    // 渲染器会按的那条路走：拿注入面上的 discard。
    harness.registrations[0]!.options.inject().discard();
    await mini.flush();

    assert.equal(addressInput(mini).props.value, 'https://ai.example.ts.net', '草稿丢掉，回到生效值');
    assert.deepEqual(harness.writes, [], '放弃不该碰设置文档');
  });

  it('没有改动时一个 op 都不写，但保存这件事本身会重跑一轮发现', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    click(settingsSave(mini));
    await mini.flush();

    // 官方那份模型在没有可写的改动时直接返回：连 `mutate` 都不调用（不是「调用一次空计划」）。
    assert.deepEqual(plain(harness.writes), [], '没有可写的改动，连端点都不碰');
    assert.equal(harness.panelCalls.filter((call) => call === 'refresh').length, 1, '保存这一下本来就要等一轮发现落地');
  });

  it('写入被拒：界面说实话，不假装成功', async () => {
    const { harness, mini, element } = driveClient({ refused: true });
    mini.mount(element);
    await mini.flush();

    change(addressInput(mini), 'https://gateway.example.ts.net');
    await mini.flush();
    click(settingsSave(mini));
    await mini.flush();

    assert.equal(harness.writes.length, 1, '试过写入，但被回绝了');
    assert.equal(harness.panelCalls.includes('refresh'), false, '没写成就没有「重新发现」这回事');
    assert.match(text(mini.tree()), /没被接受/u, '表单要说清这一笔没落下去');
    assert.match(text(bannerOf(mini)), /没有写入/u);
    assert.equal(addressInput(mini).props.value, 'https://gateway.example.ts.net', '草稿留着，用户不必重打一遍');
  });

  it('文档只读时控件全部停用', async () => {
    const { mini, element } = driveClient({ section: { writable: false } });
    mini.mount(element);
    await mini.flush();

    assert.match(text(mini.tree()), /只读/u);
    assert.equal(addressInput(mini).props.disabled, true);
    assert.equal(syncSwitch(mini).props.disabled, true);
    assert.equal(settingsSave(mini).props.disabled, true);
  });

  it('没有设置服务时页面照旧立得住，只是那份表单读不到', async () => {
    const { harness, mini, element } = driveClient({}, true);
    mini.mount(element);
    await mini.flush();

    assert.deepEqual([...harness.configNamespaces], [], '没有服务就不该去要命名空间');
    assert.match(text(mini.tree()), /这一份设置现在读不到/u);
    const [form] = findAll(mini.tree(), (node) => node.type === 'form');
    assert.ok(form, '表单本身还要在');
    assert.equal(findAll(form, (node) => node.type === 'button').length, 0, '读不到就没有可按的东西');
    assert.equal(findAll(mini.tree(), (node) => node.props.id === 'dap-base-url').length, 0);
    assert.match(text(mini.tree()), /一行一个模型/u, '模型那一段与设置服务无关');
    assert.equal(findAll(mini.tree(), (node) => node.type === 'li' && node.props.className === 'dap-card').length, 2);
  });
});

describe('模型行与刷新', () => {
  it('模型行收起时只剩一行事实，展开才给编辑器', async () => {
    const { mini, element, t } = driveClient();
    mini.mount(element);
    await mini.flush();

    const row = rowOf(mini, 'deepseek-flash');
    assert.equal(toggleOf(row).props['aria-expanded'], 'false');
    const collapsed = text(row);
    for (const fragment of [
      'aperture',
      'openai-completions',
      t('factContextWindow', { count: count(1_048_576) }),
      t('factMaxTokens', { count: count(384_000) }),
      t('modalityText') + '+' + t('modalityImage'),
      t('reasoningOn'),
      t('factAlias', { alias: 'deepseek/deepseek-v4-flash' }),
      t('overriddenCount', { count: 1 }),
    ]) {
      assert.ok(collapsed.includes(fragment), `收起的一行应当写着 ${fragment}`);
    }
    assert.equal(findAll(row, (node) => node.props.id === 'dap-deepseek-flash-name').length, 0, '收起时不该有编辑器');

    await openRow(mini, 'deepseek-flash');
    assert.equal(toggleOf(rowOf(mini, 'deepseek-flash')).props['aria-expanded'], 'true');
  });

  it('状态点说清这一行写没写进路由，点旁边那句话是它的说法', async () => {
    const { mini, element, t } = driveClient();
    mini.mount(element);
    await mini.flush();

    // 点自己不说话（官方 `StateDot` 是 aria-hidden 的），说给谁听得看外面那层的 aria-label。
    const dots = (instance: MiniReact): Array<[string, string]> => findAll(
      instance.tree(),
      (node) => node.props.role === 'img',
    ).map((node) => [String(node.props['aria-label']), String(findAll(node, (child) => typeof child.props.state === 'string')[0]?.props.state)]);

    assert.deepEqual(dots(mini), [
      [t('statusPublished'), 'done'],
      [t('statusUnserved'), 'warning'],
    ]);

    // 同步没跑起来（关着）时不能说成「没写进去」：报告里根本没有这一项。
    const unknown = driveClient({ report: report({ refresh: { ...report().refresh!, sync: undefined } }) });
    unknown.mini.mount(unknown.element);
    await unknown.mini.flush();
    assert.deepEqual(dots(unknown.mini).map(([label]) => label), [
      unknown.t('statusUnknown'),
      unknown.t('statusUnserved'),
    ]);

    // 跑过同步但这一行没写进去（比如路由本轮没被写）时，才说「还没写进路由」。
    const skipped = driveClient({ report: report({ models: [deepseek({ route: 'aperture-extra' }), gemini()] }) });
    skipped.mini.mount(skipped.element);
    await skipped.mini.flush();
    assert.deepEqual(dots(skipped.mini), [
      [skipped.t('statusNotPublished'), 'idle'],
      [skipped.t('statusUnserved'), 'warning'],
    ]);
  });

  it('展开一行：输入框预填的是此刻的生效值', async () => {
    const { mini, element, t } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openRow(mini, 'deepseek-flash');

    const tree = mini.tree();
    assert.equal(findById(tree, 'dap-deepseek-flash-name').props.value, 'DeepSeek Flash');
    assert.equal(findById(tree, 'dap-deepseek-flash-contextWindow').props.value, '1048576');
    assert.equal(findById(tree, 'dap-deepseek-flash-maxTokens').props.value, '384K');
    assert.equal(findById(tree, 'dap-deepseek-flash-alias').props.value, 'deepseek/deepseek-v4-flash');
    // 协议没写在用户层里，输入框留空、由占位符提示发现的协议。
    assert.equal(findById(tree, 'dap-deepseek-flash-api').props.value, '');
    assert.equal(findById(tree, 'dap-deepseek-flash-api').props.placeholder, 'openai-completions');
    assert.deepEqual(
      findAll(rowOf(mini, 'deepseek-flash'), (node) => node.props.role === 'checkbox').map((node) => node.props['aria-checked']),
      ['true', 'true'],
    );
    assert.equal(activeSegment(rowOf(mini, 'deepseek-flash')), t('reasoningOn'));
    assert.equal(findById(tree, 'dap-deepseek-flash-api').props.disabled, false);
    assert.match(text(rowOf(mini, 'deepseek-flash')), /来源：/u, '每一项都要说得出这个值是谁定的');
  });

  it('改一个字段保存：补丁里只有那一个字段', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openRow(mini, 'deepseek-flash');

    change(findById(mini.tree(), 'dap-deepseek-flash-contextWindow'), '32768');
    await mini.flush();
    click(rowSave(mini, 'deepseek-flash'));
    await mini.flush();

    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', { contextWindow: 32_768 }]]);
    assert.equal(harness.panelCalls.filter((call) => call === 'edit').length, 1);
    assert.ok(harness.panelCalls.filter((call) => call === 'status').length >= 2, '写完要重新读一轮报告');
    assert.equal(findAll(rowOf(mini, 'deepseek-flash'), (node) => node.props.id === 'dap-deepseek-flash-contextWindow').length, 0, '写完收起');
    assert.match(text(mini.tree()), /已重新发现并发布/u);
  });

  it('两行各开各的：保存一行不牵连那一行', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openRow(mini, 'deepseek-flash');
    await openRow(mini, 'gemini-2.5-flash');

    change(findById(mini.tree(), 'dap-deepseek-flash-maxTokens'), '8192');
    change(findById(mini.tree(), 'dap-gemini-2.5-flash-name'), 'Gemini');
    await mini.flush();
    click(rowSave(mini, 'deepseek-flash'));
    await mini.flush();

    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', { maxTokens: 8192 }]]);
    assert.equal(findById(mini.tree(), 'dap-gemini-2.5-flash-name').props.value, 'Gemini', '那一行的草稿还在');

    click(rowSave(mini, 'gemini-2.5-flash'));
    await mini.flush();
    assert.deepEqual(plain(harness.editCalls), [
      ['deepseek-flash', { maxTokens: 8192 }],
      ['gemini-2.5-flash', { name: 'Gemini' }],
    ]);
  });

  it('留空表示这一项不覆盖：文本给 null、别名给空串', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openRow(mini, 'deepseek-flash');

    change(findById(mini.tree(), 'dap-deepseek-flash-name'), '');
    change(findById(mini.tree(), 'dap-deepseek-flash-alias'), '');
    await mini.flush();
    click(rowSave(mini, 'deepseek-flash'));
    await mini.flush();

    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', { name: null, alias: '' }]]);
  });

  it('取消：丢掉草稿、收起面板、什么都不写', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openRow(mini, 'deepseek-flash');

    change(findById(mini.tree(), 'dap-deepseek-flash-contextWindow'), '1');
    await mini.flush();
    click(rowButton(mini, 'deepseek-flash', '取消'));
    await mini.flush();

    assert.deepEqual(harness.editCalls, []);
    assert.equal(toggleOf(rowOf(mini, 'deepseek-flash')).props['aria-expanded'], 'false');
    await openRow(mini, 'deepseek-flash');
    assert.equal(findById(mini.tree(), 'dap-deepseek-flash-contextWindow').props.value, '1048576');
  });

  it('收起不动草稿，用标签说还有没保存的改动', async () => {
    const { harness, mini, element, t } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openRow(mini, 'deepseek-flash');

    change(findById(mini.tree(), 'dap-deepseek-flash-contextWindow'), '1');
    await mini.flush();
    click(toggleOf(rowOf(mini, 'deepseek-flash')));
    await mini.flush();

    assert.deepEqual(harness.editCalls, []);
    assert.ok(text(rowOf(mini, 'deepseek-flash')).includes(t('dirtyTag')));
    await openRow(mini, 'deepseek-flash');
    assert.equal(findById(mini.tree(), 'dap-deepseek-flash-contextWindow').props.value, '1', '草稿没被收起来丢掉');
  });

  it('清空覆盖：只碰报告里确实覆盖过的键，逐项置空', async () => {
    const custom = report({ models: [deepseek({ overrideKeys: ['thinking', 'alias'] }), gemini()] });
    const { harness, mini, element } = driveClient({ report: custom });
    mini.mount(element);
    await mini.flush();
    await openRow(mini, 'deepseek-flash');

    click(rowButton(mini, 'deepseek-flash', '清空覆盖'));
    await mini.flush();
    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', { thinking: null, alias: '' }]]);
  });

  it('清空覆盖遇到界面不认识的键：整行撤回才是唯一能回到发现值的做法', async () => {
    const custom = report({ models: [deepseek({ overrideKeys: ['contextWindow', 'reasoningEfforts'] }), gemini()] });
    const { harness, mini, element } = driveClient({ report: custom });
    mini.mount(element);
    await mini.flush();

    await openRow(mini, 'deepseek-flash');
    assert.ok(text(rowOf(mini, 'deepseek-flash')).includes('推理档位'), '不认识的键也要报出来');
    click(rowButton(mini, 'deepseek-flash', '清空覆盖'));
    await mini.flush();
    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', null]]);
  });

  it('没有覆盖过的一行不给「清空覆盖」', async () => {
    const { mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openRow(mini, 'gemini-2.5-flash');

    assert.equal(findAll(rowOf(mini, 'gemini-2.5-flash'), (node) => node.type === 'button' && text(node) === '清空覆盖').length, 0);
  });

  it('容量认 1M / 100K 的写法，非法值在本地挡下来、不打端点', async () => {
    const { harness, mini, element, t } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openRow(mini, 'deepseek-flash');

    for (const [illegal, field] of [['1G', '上下文容量'], ['1.5', '上下文容量'], ['0', '上下文容量']] as const) {
      change(findById(mini.tree(), 'dap-deepseek-flash-contextWindow'), illegal);
      await mini.flush();
      assert.ok(text(rowOf(mini, 'deepseek-flash')).includes(t('invalidField')), `${illegal} 应当在输入框上标出来`);
      click(rowSave(mini, 'deepseek-flash'));
      await mini.flush();
      assert.deepEqual(harness.editCalls, [], `${illegal} 不该发端点`);
      assert.equal(bannerOf(mini).props['data-ok'], 'false');
      assert.match(text(bannerOf(mini)), new RegExp(`${field} 只能填不小于 1 的整数`, 'u'));
    }

    change(findById(mini.tree(), 'dap-deepseek-flash-contextWindow'), '64K');
    await mini.flush();
    click(rowSave(mini, 'deepseek-flash'));
    await mini.flush();
    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', { contextWindow: 64_000 }]]);
  });

  it('换一种写法写同一个数不算改动', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openRow(mini, 'deepseek-flash');

    change(findById(mini.tree(), 'dap-deepseek-flash-contextWindow'), '1M');
    change(findById(mini.tree(), 'dap-deepseek-flash-maxTokens'), '384k');
    await mini.flush();
    click(rowSave(mini, 'deepseek-flash'));
    await mini.flush();

    assert.deepEqual(plain(harness.editCalls), [['deepseek-flash', { contextWindow: 1_000_000 }]], '384k 与 384K 是同一个数');
  });

  it('未服务的模型可以就地填上协议', async () => {
    const { harness, mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();
    await openRow(mini, 'gemini-2.5-flash');

    assert.equal(findById(mini.tree(), 'dap-gemini-2.5-flash-api').props.value, '');
    assert.match(text(rowOf(mini, 'gemini-2.5-flash')), /填上协议它才有路由/u);
    change(findById(mini.tree(), 'dap-gemini-2.5-flash-api'), 'openai-completions');
    await mini.flush();
    click(rowSave(mini, 'gemini-2.5-flash'));
    await mini.flush();

    assert.deepEqual(plain(harness.editCalls), [['gemini-2.5-flash', { api: 'openai-completions' }]]);
  });

  it('这一轮哪里不对就说一句：清单读不到、该写的没写进去', async () => {
    // 报告那一块删掉之后，这两句话本来只写在报告事实表里——现在挂在模型那一段的提示语下面。
    const brokenCatalog = report({
      refresh: {
        ...report().refresh!,
        catalog: { available: false, entries: 0, reason: '网关没回应' },
      },
    });
    const first = driveClient({ report: brokenCatalog });
    first.mini.mount(first.element);
    await first.mini.flush();
    assert.match(text(first.mini.tree()), /清单不可用（网关没回应）/u);

    const skipped = report({
      refresh: {
        ...report().refresh!,
        sync: { applied: false, ops: 0, routes: [], reason: '没有配置变更' },
      },
    });
    const second = driveClient({ report: skipped });
    second.mini.mount(second.element);
    await second.mini.flush();
    assert.match(text(second.mini.tree()), /没写（没有配置变更）/u);
    assert.equal(findAll(second.mini.tree(), (node) => node.props.className === 'dap-warnNote').length, 1);

    // 正常的一轮（写进去了）什么都不说；同步关着（报告里没有这一项）也不说「没写」。
    const quiet = driveClient();
    quiet.mini.mount(quiet.element);
    await quiet.mini.flush();
    assert.equal(findAll(quiet.mini.tree(), (node) => node.props.className === 'dap-warnNote').length, 0);
    const off = driveClient({ report: report({ refresh: { ...report().refresh!, sync: undefined } }) });
    off.mini.mount(off.element);
    await off.mini.flush();
    assert.equal(findAll(off.mini.tree(), (node) => node.props.className === 'dap-warnNote').length, 0);
  });

  it('没有模型时说清楚是「还没发现」还是「还没填地址」', async () => {
    const empty = driveClient({ report: report({ refresh: undefined, routes: [], models: [] }) });
    empty.mini.mount(empty.element);
    await empty.mini.flush();
    assert.match(text(empty.mini.tree()), /还没有发现任何模型/u);

    // 地址空着的时候发现根本不会跑，空状态要说这句，不然「还没发现到模型」等于没说。
    const dormant = driveClient({
      report: report({ refresh: undefined, routes: [], models: [] }),
      section: { value: { baseUrl: '', sync: true } },
    });
    dormant.mini.mount(dormant.element);
    await dormant.mini.flush();
    assert.match(text(dormant.mini.tree()), /还没有实例地址/u);
    assert.doesNotMatch(text(dormant.mini.tree()), /还没有发现任何模型/u);
  });

  it('「立刻刷新」按一下就走一次 refresh，并把结果贴出来', async () => {
    const { harness, mini, element, t } = driveClient();
    mini.mount(element);
    await mini.flush();

    const refresh = findButton(mini.tree(), '立刻刷新');
    assert.equal(refresh.props.title, t('refreshHint'), '按钮的说明是它自己的那一句，不是报告那一句');
    click(refresh);
    await mini.flush();

    assert.equal(harness.panelCalls.filter((call) => call === 'refresh').length, 1);
    assert.ok(harness.panelCalls.filter((call) => call === 'status').length >= 2, '刷新完要重读报告');
    assert.match(text(bannerOf(mini)), /已重新发现并发布/u);
    assert.equal(findButton(mini.tree(), '立刻刷新').props.disabled, false, '刷完按钮要还回来');
  });

  it('端点失败时把原因摆在界面上，不是只写到控制台', async () => {
    const { harness, mini, element } = driveClient({ fails: 'status' });
    mini.mount(element);
    await mini.flush();

    assert.match(text(mini.tree()), /面板暂时连不上后台/u);
    assert.match(text(mini.tree()), /后台还没起来/u);
    assert.deepEqual(harness.consoleErrors, [], '失败要摆在界面上，控制台里不该是唯一一份');
  });

  it('刷新这一轮没成功时，端点的原话摆出来', async () => {
    const { mini, element } = driveClient({ fails: 'refresh' });
    mini.mount(element);
    await mini.flush();

    click(findButton(mini.tree(), '立刻刷新'));
    await mini.flush();

    assert.equal(bannerOf(mini).props['data-ok'], 'false');
    assert.match(text(bannerOf(mini)), /刷新没有成功：网关没回应/u);
  });

  it('写这一行失败：端点的原因贴在界面上', async () => {
    const { harness, mini, element } = driveClient({ fails: 'edit' });
    mini.mount(element);
    await mini.flush();
    await openRow(mini, 'deepseek-flash');

    change(findById(mini.tree(), 'dap-deepseek-flash-maxTokens'), '8192');
    await mini.flush();
    click(rowSave(mini, 'deepseek-flash'));
    await mini.flush();

    assert.equal(harness.editCalls.length, 1);
    const banner = bannerOf(mini);
    assert.equal(banner.props['data-ok'], 'false');
    assert.match(text(banner), /写这一行的时候后台断了/u);

    // 看着像 bug（结论里列了）：写失败之后 `run()` 的收尾照样执行，草稿被丢掉、面板收起，
    // 用户刚打的那几个字就这么没了。这一行钉住的是当下的行为，改掉之后改成断言草稿还在。
    await openRow(mini, 'deepseek-flash');
    assert.equal(findById(mini.tree(), 'dap-deepseek-flash-maxTokens').props.value, '384K', '失败之后草稿没了');
  });

  it('effect 的依赖里只有原始值，一轮交互只渲染少数几次', async () => {
    const { mini, element } = driveClient();
    mini.mount(element);
    await mini.flush();

    const primitive = (value: unknown): boolean => value === null || (typeof value !== 'object' && typeof value !== 'function');
    const withDeps = mini.hookDeps().filter((deps): deps is unknown[] => deps !== undefined);
    assert.ok(withDeps.length >= 2, '选择 store 与重读报告各有一个带依赖的 effect');
    for (const deps of withDeps) {
      for (const dep of deps) {
        assert.ok(primitive(dep), `effect 依赖里出现了每轮都会重建的对象：${String(dep)}`);
      }
    }
    // 组件自己那个重读报告的 effect 挂在 revision 这个数字上；注入面每轮重建，进不得依赖。
    assert.ok(
      withDeps.some((deps) => deps.length === 1 && deps[0] === 0),
      '重读报告应当以挂载时的 revision（0）为依赖',
    );
    assert.ok(mini.renders <= 30, `挂载一轮渲染了 ${mini.renders} 次：effect 依赖里多半放了每轮都变的注入面`);
  });
});
