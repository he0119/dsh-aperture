/**
 * `dsh-aperture` Web Client 端（插件本体）：挂载 Remote 贡献、注册字典与样式，并把界面注册到
 * 三个槽位上——包级配置槽位 `plugins.bundle.config`（键是包名 `dsh-aperture`）上是设置页，官方
 * 「模型」页的两个扩展位上各挂一份模型清单：[`settings.models.provider-card`]（键是设置命名空间
 * `aperture`，页主按它把贡献派给本插件注册的每一行路由卡）与 `settings.models.footer`（列表条目）。
 * 前者管那一条路由的模型，后者接卡片接不住的那些（没有路由可服务的、以及一条路由都没注册时的全部）。
 *
 * 两个组件在 [AperturePanel.tsx](./AperturePanel.tsx)（地址与开关）与
 * [ApertureModels.tsx](./ApertureModels.tsx)（模型，两个座位共用），字典在
 * [locales.ts](./locales.ts)，描述符在 [remote.ts](./remote.ts)，样式在
 * [styles.ts](./styles.ts)——这里只做组装，是唯一的跨域装配点。
 *
 * 注入面是 `slots` / `locale` / `remote` / `configForms`：报告与「立刻刷新」经自己的
 * `aperturePanel` Remote 往返；设置的读写面向 `configForms` 要——**包级**配置页页主只递
 * `view: 'page'`、不递 `form`（递 `form` 的是行级与条目级），所以得按设置命名空间自己取。
 *
 * 运行时只 require 平台基线里的模块（`react` / `react/jsx-runtime` 与
 * `@deepseek-ai/dsh-client-ui-primitives`）；四个服务都从 `ctx` 上取，因此
 * `dsh.client.external` 是空的。产物是 `pnpm run build:client`（tsdown）打出来的
 * `lib/client.js`：一个用 `window.__ModuleLoader__.load({ id, factory })` 报名的经典脚本。
 *
 * @module dsh-aperture/client
 */

// 只取服务声明（cordis 的 Context 增强），不产生运行时 require：这些包是服务提供方，
// 它们的 Web Client 模块由 Host 模块图按行装，不由本模块 require。服务声明长在各包的 `/client` 入口
// （`ctx.slots` 是渲染器声明的、`SlotMap` 里那个 `plugins.bundle.config` 是插件管理页声明的、
// `settings.models.provider-card` / `settings.models.footer` 是官方「模型」页声明的），根入口只有
// Host 模块，指错了就一个服务都拿不到。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import { SettingsFormModel, settingsTextField } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SettingsFieldSpec, SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult, TypertDisposer } from '@deepseek-ai/dsh-typert-protocol';
import { ApertureModels } from './ApertureModels.tsx';
import { AperturePanel } from './AperturePanel.tsx';
import type { PanelFace } from './shared.ts';
import { en, NS, zh } from './locales.ts';
import { PACKAGE, REMOTE } from './remote.ts';
import { installStyles } from './styles.ts';

/**
 * 设置命名空间（宿主 `src/config.ts` 的 `APERTURE_NAMESPACE`，也是 `cordis.patch.yml` 里那一行
 * 的 id）。包级配置页页主不递 `form`，这一份表单就是按它向 `configForms` 要来的。
 */
const SETTINGS_NS = 'aperture';
/** 这一页自己编辑的两个字段；其余配置键（`models` 除外）留给配置文件。 */
const FIELDS = Object.freeze(['baseUrl', 'sync']);

// ------------------------------------------------------------ 设置接缝

/**
 * 布尔字段的换算规格。
 *
 * 官方设置表单按「草稿文本」组织，规格只要求两个方向：值怎么写进文本、文本怎么变成一次写入。
 * 开关用 `'true'` / `'false'` 当草稿，空串是「这一项不写」，值回落到组合层与 schema 默认。
 *
 * @returns {object} 字段规格。
 */
function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (value === true ? 'true' : value === false ? 'false' : ''),
    parse: (text) => {
      if (text === '') return { kind: 'clear' };
      if (text === 'true') return { kind: 'set', value: true };
      if (text === 'false') return { kind: 'set', value: false };
      return undefined;
    },
  };
}

/**
 * 这份设置没有服务时用的替身：`configForms` 缺席时（注入表保证不会，但这一页不该因此整页消失）
 * 让 `SettingsFormModel` 读到 `unavailable` 快照，官方表单自己会画那句「读不到」，模型那一段
 * 照旧。写入一律回绝——没有服务时没有任何东西能接受它。
 */
const UNSERVED: SettingsFormScope<Record<string, unknown>> = Object.freeze({
  getSnapshot: () => ({
    // `as const` 是必需的：`Object.freeze` 会把字面量摊成 `string`，而官方要的是那个三选一的联合。
    status: 'unavailable' as const,
    value: undefined,
    base: undefined,
    user: undefined,
    writable: false,
    revision: undefined,
  }),
  subscribe: () => () => {},
  mutate: async () => false,
});

/** 把 `RemoteResult` 拆成值，失败则抛人话。 */
function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value;
  const detail = result.error && result.error.message ? result.error.message : '未知原因';
  throw new Error(`面板暂时连不上后台（${detail}）；若反复出现请重启 dsh web。`);
}

// ---------------------------------------------------------------- 插件本体

/**
 * 把 `aperturePanel` 贡献挂到客户端的 Remote 服务上。
 *
 * `apply` 必须保持同步：宿主 Cordis 会卸载 async apply 里 `await` 之后注册的 `ctx.effect`。
 * 因此异步的 `$mount` 在一个**同步注册**的 effect 工厂内部完成，失败落 console.error。
 *
 * @param {object} ctx - 客户端根上下文。
 */
function mountRemote(ctx: Context): void {
  ctx.effect(() => {
    let mounted: TypertDisposer | null = null;
    let pending = true;
    let unloaded = false;
    void (async () => {
      try {
        mounted = await ctx.remote.$mount(REMOTE);
      } catch (error) {
        console.error('dsh-aperture: aperturePanel 贡献挂载失败', error);
      }
      pending = false;
      if (unloaded) void mounted?.();
    })();
    return () => {
      unloaded = true;
      if (!pending) void mounted?.();
    };
  }, 'dsh-aperture: remote contribution');
}

/**
 * 浏览器插件主体：字典、样式、Remote 贡献，以及三个槽位上的注册——「插件」页里本插件那个包页上的
 * 设置页，与官方「模型」页上模型清单的两个座位（卡片座位、页脚座位）。
 *
 * `ctx.slots.inject` 是必需的，不是可选的：这三个槽位都由别的页声明，那些声明完全可能在本插件
 * `apply` 之后才发生，直接 register 会撞上「槽位尚未声明」。
 *
 * 注册的键分两种：配置槽位按**包名**找贡献，点开插件列表里的本插件就是这一页；「模型」页那个卡片
 * 座位按**设置命名空间**（`aperture`）派发，于是本插件的每一行路由都会得到同一份贡献，组件再从递
 * 进来的目录行认出自己管哪一条路由；页脚座位是列表槽位，包名是这一块在那一页上的条目 id。设置那
 * 一份表单也在这里取——页主只递 `view`，`configForms.get(命名空间)` 才是配置读写面；服务按命名空间
 * 缓存控制器，因此三个组件拿到的是同一份。
 *
 * @param {object} ctx - 客户端根上下文。
 */
function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-aperture: dictionaries');
  ctx.effect(() => installStyles(), 'dsh-aperture: stylesheet');
  mountRemote(ctx);

  ctx.inject(['remote.aperturePanel'], (scope) => {
    const t = scope.locale.bind(NS);
    const namespace = () => scope.remote.aperturePanel;
    const panel: PanelFace = {
      status: async () => unwrap(await namespace().status()),
      refresh: async () => unwrap(await namespace().refresh()),
      writeModel: async (id, patch) => unwrap(await namespace().edit(id, patch)),
    };

    // 官方设置表单那一套：这一份模型负责草稿、`revision` 围栏与「哪些字段已覆盖」，页面只读
    // 它的投影。表单自己订阅控制器，因此设置一变，投影就会变新。
    const controller = ctx.configForms === undefined ? UNSERVED : ctx.configForms.get(SETTINGS_NS);
    const form = new SettingsFormModel(controller, [settingsTextField('baseUrl'), booleanField('sync')]);
    const actions = form.actions();
    const card = form.bind(() => ({
      ...form.shell(),
      baseUrl: form.field('baseUrl'),
      sync: form.field('sync'),
    }));
    scope.effect(() => () => form.dispose(), 'dsh-aperture: settings form');

    scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
      name: 'plugins.bundle.config',
      key: PACKAGE,
      locale: NS,
      inject: () => ({
        hooks: { apertureCard: card },
        panel,
        edit: actions.edit,
        resetField: actions.resetField,
        discard: actions.discard,
        save: () => form.save(),
        failed: () => form.shell().failed,
      }),
    }, AperturePanel));

    // 模型清单的主入口在官方「模型」页**本插件那几行路由卡里**：键是设置命名空间，页主按它把这份
    // 贡献派给本插件注册的每一行（`settingsNs: 'aperture'`），组件再从那一行认出自己管哪一条路由。
    scope.slots.inject('settings.models.provider-card', () => scope.slots.register({
      name: 'settings.models.provider-card',
      key: SETTINGS_NS,
      locale: NS,
      inject: () => ({
        hooks: { apertureCard: card },
        panel,
      }),
    }, ApertureModels));

    // 卡片接不住的那些（没有路由可服务的模型、以及一条路由都没注册时的全部）挂在同一页的页脚座位
    // 上：那里没有目录行可认，于是组件按自己拿到的那一份报告判断该画什么，没东西可说时整块不画。
    scope.slots.inject('settings.models.footer', () => scope.slots.register({
      name: 'settings.models.footer',
      id: PACKAGE,
      locale: NS,
      inject: () => ({
        hooks: { apertureCard: card },
        panel,
      }),
    }, ApertureModels));
  });
}

export const name = PACKAGE;
/** 本插件依赖的客户端服务：槽位、字典、Remote 调用面，以及设置接缝的配置表单。 */
export const inject = ['slots', 'locale', 'remote', 'configForms'];
export {
  apply,
  /** 字典命名空间（测试与排查用）。 */
  NS,
  /** 设置命名空间，也是包级配置页这一份表单的键（测试与排查用）。 */
  SETTINGS_NS,
  /** 这一页自己编辑的字段（测试与排查用）。 */
  FIELDS,
  /** 上报给 Remote 注册表的贡献（测试与排查用）。 */
  REMOTE,
};
