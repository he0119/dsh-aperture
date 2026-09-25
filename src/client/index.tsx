/**
 * `dsh-aperture` 浏览器半边（源码）：**「插件」页里本插件那个包页上的配置页**。
 *
 * 注册在包级配置槽位 `plugins.bundle.config` 上，键是包名 `dsh-aperture`：点开插件列表里的本
 * 插件就是这一页。页面只交内容，控件用官方原语，**没有卡片**，标题与面包屑由页主画。
 *
 * 地址与同步开关交给官方设置表单（`SettingsForm` / `SettingsValueField` / `SettingsFormModel`）：
 * 草稿与生效值的差分、`revision` 围栏写入、保存失败保留草稿、只读与「命名空间没在服务」都归它
 * 管，本模块只声明每个字段怎么在「存下来的值」与「输入框文本」之间换算。
 *
 * 注入面是 `slots` / `locale` / `remote` / `configForms`：报告与「立刻刷新」经自己的
 * `aperturePanel` Remote 往返；设置的读写面向 `configForms` 要——**包级**配置页页主只递
 * `view: 'page'`、不递 `form`（递 `form` 的是行级与条目级），所以得按设置命名空间自己取。状态走
 * 注入面里的 `hooks`（渲染器把它变成 `useApertureCard` 选择器钩子），动作走普通函数。
 *
 * 运行时只 require 平台基线里的模块（`react` 与 `@deepseek-ai/dsh-client-ui-primitives`）；
 * `slots` / `locale` / `remote` / `configForms` 都从 `ctx` 上取服务，因此 `dsh.client.external`
 * 是空的。`dsh.client.inject` 是给宿主客户端模块系统的声明：它按那份清单把那些包的工厂注册成可
 * `require` 的模块。
 *
 * 这个文件是**源码**：`npm run build:client`（tsdown）把它打成 `lib/client.js`——一个用
 * `window.__ModuleLoader__.load({ id, factory })` 报名的经典脚本，`exports["./client"]` 指向它。
 * 包法（banner / intro / footer 三行把 CJS 工厂包出去）与官方
 * `packages/client/tsdown.client.ts` 一致，见仓库内 `tsdown.config.ts`。
 *
 * @module dsh-aperture/client
 */

import * as React from 'react';
import {
  Button,
  Checkbox,
  IconChevronRightOutlineRegular,
  IconRefreshOutlineRegular,
  SegmentedControl,
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  StateDot,
  Switch,
  Tag,
  settingsTextField,
} from '@deepseek-ai/dsh-client-ui-primitives';

// 只取服务声明（cordis 的 Context 增强），不产生运行时 require：这些包是服务提供方，
// 它们的客户端半边由宿主模块图按行装，不由本模块 require。服务声明长在各包的 `/client` 入口
// （`ctx.slots` 是渲染器声明的、`SlotMap` 里那个 `plugins.bundle.config` 是插件管理页声明的），
// 根入口只有宿主半边那一套，指错了就一个服务都拿不到。
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
// 下面这一条是给文件末尾那两处 `declare module` 用的：本模块把字典命名空间并进它的
// `LocaleNamespaceMap`。
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type { Context } from '@deepseek-ai/cordis';
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
  TypertDisposer,
  TypertRemoteContribution,
  TypertSchema,
} from '@deepseek-ai/dsh-typert-protocol';
import type {
  SettingsFieldSpec,
  SettingsFieldState,
  SettingsFormActions,
  SettingsFormScope,
  SettingsFormShell,
  StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { PanelAction, PanelModelPatch } from '../panel.ts';
import type { PanelModel, PanelReport } from '../report.ts';
import type { FactSource, Modality } from '../types.ts';
// 样式表是真正的 .css 文件，由 tsdown 的 `cssInline()` 编译成文本内联进产物（见 tsdown.config.ts）。
import styles from './styles.css?inline';

/** 字典命名空间（本插件拥有）；配置页的 `locale` 声明与 `ctx.locale.bind` 都用它。 */
const NS = 'settings.aperturePanel';
/** 宿主半边的 Remote 命名空间（`src/remote.ts`）。 */
const PANEL = 'aperturePanel';
/** 包名，取自 package.json；它同时是包级配置页的键。 */
const PACKAGE = 'dsh-aperture';
/** 样式表的归属标记（官方那套 `data-plugin-css` 的写法：包名/文件名）；卸载与热替换时按它回收。 */
const STYLE_OWNER = 'dsh-aperture/styles.css';
/**
 * 设置命名空间（宿主 `src/config.ts` 的 `APERTURE_NAMESPACE`，也是 `cordis.patch.yml` 里那一行
 * 的 id）。包级配置页页主不递 `form`，这一份表单就是按它向 `configForms` 要来的。
 */
const SETTINGS_NS = 'aperture';
/** 这一页自己编辑的两个字段；其余配置键（`models` 除外）留给配置文件。 */
const FIELDS = Object.freeze(['baseUrl', 'sync']);

// ---------------------------------------------------------------- 端点契约

/**
 * 浏览器半边与宿主半边之间的线格式。
 *
 * 只有一个直通编解码器，因为浏览器侧从不解析这些值：注册表（`@deepseek-ai/dsh-typert-registry`）
 * 只检查 `mode` 是 `strict`、`typeSymbol` 非空、`create` 是个函数，网关客户端只读参数上的
 * `mode` 与结果上可选的 `decode`/`encode`，**没有一处调用 `create()`**，逐字段手写的 wire 校验
 * 因此永远不会执行。曾经那 300 行文法还埋了个雷：注册表要的是 `create` 工厂，`schema` 字段不被
 * 承认，于是 `$mount` 抛 `strict codec has no create() factory`，整份贡献被拒，界面安静地什么
 * 都不出现。
 *
 * 端点名不能与命名空间服务自己的成员重名：api-gateway 为每个命名空间建的
 * `RemoteNamespaceService` 会把端点收成自己的属性，撞上 `remove` / `has` / `install` / `name` /
 * `ctx` 这类预置名字时校验会拒绝**整份**贡献。
 */
const SCHEMA: TypertSchema = Object.freeze({ parse: (value: unknown) => value });
const CODEC: TypertCodec = Object.freeze({
  mode: 'strict',
  typeSymbol: `${PACKAGE}/types#any`,
  create: () => SCHEMA,
});

/**
 * 一个端点的浏览器侧描述符。
 *
 * 参数按宿主方法的形参顺序给出；调用点按位置传参，网关按 `wire` 映射，并且**自动省掉
 * `undefined` 实参**（`if (value !== void 0) args[parameter.wire] = value`），所以「没提到的
 * 参数」天然就是「不碰」。
 *
 * @param {Array<string>} parameters - 参数名，顺序与宿主方法一致。
 */
function descriptor(method: string, parameters: readonly string[] = []): InvocationDescriptor {
  return Object.freeze({
    id: `${PACKAGE}#${PANEL}/${method}`,
    service: PANEL,
    namespace: PANEL,
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze(parameters.map((name) => Object.freeze({
      name,
      wire: name,
      source: 'json',
      codec: CODEC,
    }))),
    result: CODEC,
  });
}

/** 与宿主半边 `PANEL_INVOCATIONS` 一一对应的贡献（按官方的 `TypertRemoteContribution` 校验）。 */
const REMOTE: TypertRemoteContribution = Object.freeze({
  package: PACKAGE,
  descriptors: Object.freeze([
    descriptor('status'),
    descriptor('refresh'),
    descriptor('edit', ['id', 'patch']),
  ]),
});

/**
 * 界面能编辑的覆盖键。
 *
 * 列表以外的键（例如 `reasoningEfforts`）一旦出现在用户层里，这一行就只能整条撤：只清认得
 * 的那几项，它在报告里仍然是「已覆盖」，那颗标签会按不下去。
 */
const EDITABLE_KEYS = Object.freeze(['name', 'api', 'contextWindow', 'maxTokens', 'input', 'thinking', 'alias']);

/**
 * `aperturePanel` 这个命名空间在**客户端**的形状。
 *
 * 官方这块是 Typert 生成器从宿主 FaceModel 生成的（`*.typert.remote-client.d.ts`），而生成器不随
 * DSH 发布，描述符因此两边都手写（见 docs/internals.md）。这一段就是把生成器本该产出的东西手写
 * 一份：`TypertRemoteMap` 是拍平的 `<命名空间>/<方法>` 键，`TypertRemoteNamespaceMap` 是命名空间
 * 到方法表的映射，客户端 `ctx.remote.<命名空间>` 与 `ctx.inject(['remote.<命名空间>'])` 都读它。
 * 接口名沿用生成器那套十六进制后缀（`aperturePanel` 的 ASCII），将来真引入生成器时，删掉这一段
 * 换成它生成的文件即可。
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$617065727475726550616e656c {
    status: () => Promise<RemoteResult<PanelReport>>;
    refresh: () => Promise<RemoteResult<PanelAction>>;
    edit: (id: string, patch: PanelModelPatch | null) => Promise<RemoteResult<PanelAction>>;
  }
  interface TypertRemoteMap {
    'aperturePanel/status': () => Promise<RemoteResult<PanelReport>>;
    'aperturePanel/refresh': () => Promise<RemoteResult<PanelAction>>;
    'aperturePanel/edit': (id: string, patch: PanelModelPatch | null) => Promise<RemoteResult<PanelAction>>;
  }
  interface TypertRemoteNamespaceMap {
    'aperturePanel': TypertRemoteNamespace$617065727475726550616e656c;
  }
}

/** 把 `RemoteResult` 拆成值，失败则抛人话。 */
function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value;
  const detail = result.error && result.error.message ? result.error.message : '未知原因';
  throw new Error(`面板暂时连不上后台（${detail}）；若反复出现请重启 dsh web。`);
}

// -------------------------------------------------------------------- 样式

/**
 * 配置页样式。
 *
 * 页面在独立 bundle 里，用不了仓库的 CSS module 管线，因此样式随包分发、按 effect 生命周期注入，
 * 卸载时移除；元素按 `data-plugin-css` 认领，与自己重名的那份先删掉（热替换）。
 *
 * 选择器全部收在根节点的 `[data-dsh-aperture]` 之下，颜色只引用 dsh web 的主题 token
 * （`--dsw-alias-*`，各带回落值），深浅色自动跟随。
 *
 * 排版照官方「模型」页：一个模型一张卡片（发丝描边 + 大圆角），展开的编辑器是卡片里一块内嵌面，
 * 字段用官方 `SettingsValueField`，因此徽章、重置、提示这些细活与官方设置页逐像素一致。官方那些
 * 类名是打包器哈希出来的私有产物，抄不到，能抄的只有配方（描边、圆角、内边距、字号）。
 *
 * 颜色只许用「这一页真的定义过」的 token：官方原语自己用的那几个（`bg-layer-3`、`border-l4`、
 * `interactive-bg-hover`）与 Theme 检查面列出的那十几个。像 `--dsw-alias-settings-card-stroke`
 * 这种只活在官方「模型」页自己那份组件 CSS 里的名字，在插件页上根本没定义——引用它等于引用一个
 * 空值，回落值又是白色，于是亮色主题下卡片连边都看不见（暗色主题反而正常，因为回落值是白 16%）。
 * 亮色主题下 `bg-layer-*` 全是白色（层与层靠阴影分开），所以卡片只能靠描边立住，底色只是给暗色
 * 主题加一点抬起感。
 *
 * @returns {Function} 卸载时移除样式表的 disposer。
 */
function installStyles() {
  const stale = document.querySelector(`style[data-plugin-css="${STYLE_OWNER}"]`);
  if (stale !== null && stale.parentNode !== null) stale.parentNode.removeChild(stale);

  const element = document.createElement('style');
  element.dataset.plugin = PACKAGE;
  element.dataset.pluginCss = STYLE_OWNER;
  element.textContent = styles;
  document.head.appendChild(element);
  return () => {
    if (element.parentNode !== null) element.parentNode.removeChild(element);
  };
}

// -------------------------------------------------------------------- 字典

const zh = {
  save: '保存',
  saving: '保存中…',
  saveFailed: '没被接受：文档可能只读，或刚被别处改过',
  readOnly: '这份设置是只读的，改不动。',
  unavailable: '这一份设置现在读不到：宿主没有把 aperture 段服务给这个页面。',

  addressLabel: '实例地址',
  addressHint: '填 Aperture 的地址；留空即休眠，不再发现模型。',
  addressPlaceholder: 'http://127.0.0.1:54117',
  syncLabel: '自动同步',
  syncHint: '每轮发现之后，把模型与参数写进 dsh 的 llm-pi-ai 路由。',

  overridden: '已覆盖',
  overriddenCount: '已覆盖 {count} 项',
  resetField: '恢复默认',
  invalidField: '要填不小于 1 的整数，或留空',

  refresh: '立刻刷新',
  refreshHint: '立刻重新发现并发布一次，清单与每一行的状态都按这一轮刷新。',
  refreshing: '刷新中…',
  loading: '读取中…',

  configRefused: '设置已被别处改过，这次改动没有写入：刷新页面后再改一遍。',
  savedResult: '已保存：{result}',
  noChanges: '没有改动，因此没有写入。',
  invalidNumber: '{field} 只能填不小于 1 的整数。',

  // 「发现报告」那一块删掉之后留下的三句：没有地址时的空状态，以及这一轮两处可能出问题的地方。
  dormantHint: '还没有实例地址：填上并保存之后才会去发现模型。',
  catalogUnavailable: '清单不可用（{reason}）',
  syncSkipped: '没写（{reason}）',

  modelsTitle: '模型',
  modelsHint: '一行一个模型；展开改这一行的覆盖，「保存」只写这一行。顺序来自发现顺序，没有路由可服务的排在最后。',
  modelsCount: '{count} 个',
  noModels: '还没有发现任何模型。',
  unservedTag: '未服务',
  dirtyTag: '有未保存的改动',
  statusUnserved: '没有路由能服务这个模型',
  statusUnknown: '这一轮没有同步，写没写进去看不出来',
  statusPublished: '已写入 dsh 的路由',
  statusNotPublished: '还没写进 dsh 的路由',

  factContextWindow: '上下文 {count}',
  factMaxTokens: '输出 {count}',
  factRoute: '路由 {route}',
  factProtocol: '协议 {protocol}',
  factInput: '模态 {value}',
  factReasoning: '推理 {value}',
  factAlias: '别名 {alias}',
  factEndpoints: '网关通告的端点：',
  factSource: '来源：{source}',

  modalityText: '文本',
  modalityImage: '图片',
  modalityNone: '无',
  reasoningFollow: '跟随发现',
  reasoningOn: '开',
  reasoningOff: '关',

  sourceAperture: 'Aperture',
  sourceModelsDev: 'models.dev',
  sourceConfig: '配置',
  sourceDefault: '默认值',

  editName: '显示名',
  editApi: '协议',
  editContextWindow: '上下文容量',
  editMaxTokens: '最大输出',
  editInput: '请求模态',
  editReasoning: '推理',
  editAlias: '清单别名',
  editNameHint: '留空即用发现到的名字。',
  editApiHint: '未服务的模型只有这里能救：填上协议它才有路由；留空即用网关通告的协议。',
  editCapacityHint: '可以写 1M、384K；留空即用发现到的容量。',
  editAliasHint: '写进 llm-pi-ai 清单的别名。',
  editInputHint: '这里能覆盖报告说它接收的模态。',
  editReasoningHint: '「跟随发现」就是这一项不写。',
  fieldHelp: '{field}的说明',
  editGroupIdentity: '名称与协议',
  editGroupCapacity: '容量',
  editUnknownOverrides: '这一行还有界面改不动的覆盖（{keys}）：清空覆盖会整条删掉。',
  pendingChanges: '有 {count} 项改动还没写下去',
  noPendingChanges: '和已保存的值相同',
  saveRow: '保存',
  clearOverrides: '清空覆盖',
  cancelRow: '取消',
  keyReasoningEfforts: '推理档位',
  listSeparator: '、',
};

const en = {
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'not accepted: the document may be read-only, or just changed elsewhere',
  readOnly: 'These settings are read-only, so nothing can be changed here.',
  unavailable: 'These settings cannot be read right now: the Host does not serve the aperture section to this page.',

  addressLabel: 'Instance address',
  addressHint: 'Where Aperture listens; leave it empty to go dormant and stop discovering models.',
  addressPlaceholder: 'http://127.0.0.1:54117',
  syncLabel: 'Sync automatically',
  syncHint: 'After each discovery round, write the models and their parameters into dsh\u2019s llm-pi-ai routes.',

  overridden: 'overridden',
  overriddenCount: '{count} overridden',
  resetField: 'Reset to default',
  invalidField: 'Enter an integer of at least 1, or leave it empty',

  refresh: 'Refresh now',
  refreshHint: 'Discover and republish once; the list and every row’s status follow this round.',
  refreshing: 'Refreshing…',
  loading: 'Loading…',

  configRefused: 'These settings changed elsewhere, so this edit was not written. Reload the page and try again.',
  savedResult: 'Saved: {result}',
  noChanges: 'Nothing changed, so nothing was written.',
  invalidNumber: '{field} takes an integer of at least 1.',

  // What is left of the deleted discovery report: the empty state without an address, plus the two
  // things that can go wrong in a round.
  dormantHint: 'No instance address yet: models are discovered once you set and save one.',
  catalogUnavailable: 'catalog unavailable ({reason})',
  syncSkipped: 'skipped ({reason})',

  modelsTitle: 'Models',
  modelsHint: 'One model per row; expand a row to edit its overrides, and Save writes only that row. The order comes from discovery, with anything no route can serve last.',
  modelsCount: '{count} models',
  noModels: 'No models discovered yet.',
  unservedTag: 'unserved',
  dirtyTag: 'unsaved edits',
  statusUnserved: 'No route can serve this model',
  statusUnknown: 'This round synced nothing, so whether it was written is unknown',
  statusPublished: 'Written into the dsh routes',
  statusNotPublished: 'Not written into the dsh routes yet',

  factContextWindow: '{count} context',
  factMaxTokens: 'output {count}',
  factRoute: 'route {route}',
  factProtocol: 'protocol {protocol}',
  factInput: 'modalities {value}',
  factReasoning: 'reasoning {value}',
  factAlias: 'alias {alias}',
  factEndpoints: 'Endpoints the gateway advertises:',
  factSource: 'Source: {source}',

  modalityText: 'text',
  modalityImage: 'image',
  modalityNone: 'none',
  reasoningFollow: 'Follow discovery',
  reasoningOn: 'On',
  reasoningOff: 'Off',

  sourceAperture: 'Aperture',
  sourceModelsDev: 'models.dev',
  sourceConfig: 'config',
  sourceDefault: 'default',

  editName: 'Display name',
  editApi: 'Protocol',
  editContextWindow: 'Context window',
  editMaxTokens: 'Max output',
  editInput: 'Request modalities',
  editReasoning: 'Reasoning',
  editAlias: 'Catalog alias',
  editNameHint: 'Leave it empty to use the discovered name.',
  editApiHint: 'The only way an unserved model gets a route is a protocol here; leave it empty to use the advertised one.',
  editCapacityHint: 'Write 1M or 384K; leave it empty to use the discovered capacity.',
  editAliasHint: 'The alias written into the llm-pi-ai catalog.',
  editInputHint: 'This overrides the modalities the report says it accepts.',
  editReasoningHint: '\u201cFollow discovery\u201d leaves this key unwritten.',
  fieldHelp: 'About {field}',
  editGroupIdentity: 'Name and protocol',
  editGroupCapacity: 'Capacity',
  editUnknownOverrides: 'This row also carries overrides this page cannot edit ({keys}); clearing overrides removes the whole entry.',
  pendingChanges: '{count} edits not written yet',
  noPendingChanges: 'Matches the saved values',
  saveRow: 'Save',
  clearOverrides: 'Clear overrides',
  cancelRow: 'Cancel',
  keyReasoningEfforts: 'reasoning efforts',
  listSeparator: ', ',
};

/** 内置中文兜底按普通字典读（`t` 缺席时用它，键集由下面的 `LocaleNamespaceMap` 声明）。 */
const zhDict: Record<string, string> = zh;

/**
 * 本插件的字典命名空间：声明之后 `ctx.locale.register(NS, …)` 会按 `zh` 的键集校验两份字典
 * （少一个键、多一个键都是编译错误，双语必须一次交齐），配置页注册时的 `locale: NS` 也才认得它。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.aperturePanel': LocaleKey;
  }
}

// ------------------------------------------------------------------ 小工具

/** 一个错误的人话形式。 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** token 计数的千位分隔符；跟随浏览器语言。 */
function formatCount(value: number): string {
  return value.toLocaleString();
}

/** 容量能写成的样子：十进制数加一个可选的 K/M 后缀。 */
const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
/** 后缀是十进制的：`1M` 就是 1000K，跟容量平时的说法一致。 */
const CAPACITY_SCALE = { k: 1e3, m: 1e6 };

/**
 * 读输入框里的容量，好让人写 `1M`、`100K` 而不必去数零。与官方「模型」页同一套写法（它的
 * `parseCapacity`）：空串是「这一项不覆盖」，读不出来的返回 `NaN`，由调用方在本地挡下来。
 *
 * @returns {number|undefined} token 数；空串给 `undefined`，读不出来给 `NaN`。
 */
function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const match = CAPACITY_PATTERN.exec(trimmed);
  if (match === null) return NaN;
  const suffix = match[2] === undefined ? '' : match[2].toLowerCase();
  const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1;
  const scaled = Number(match[1]) * scale;
  const rounded = Math.round(scaled);
  // 浮点误差落在整数边上的（`1.0000001M`）吃掉；真不是整数的（`0.5`）原样返回，交给
  // 调用方按「必须是不小于 1 的整数」拒绝。
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
}

/**
 * 把存下来的 token 数写回输入框，取能原样读回来的最短写法：`1000000` 写成 `1M`、`384000`
 * 写成 `384K`，`1048576` 不是整千就照原样写——官方 `formatCapacity` 同此，两边是一套词汇。
 *
 * @returns {string} 输入框文本；没有值时是空串。
 */
function formatCapacity(value: number | undefined): string {
  if (value === undefined) return '';
  if (!Number.isInteger(value) || value <= 0) return String(value);
  if (value % CAPACITY_SCALE.m === 0) return `${String(value / CAPACITY_SCALE.m)}M`;
  if (value % CAPACITY_SCALE.k === 0) return `${String(value / CAPACITY_SCALE.k)}K`;
  return String(value);
}

/** 事实来源 → 字典键；未知来源原样显示。 */
const SOURCE_KEYS: Readonly<Record<string, LocaleKey>> = {
  aperture: 'sourceAperture',
  'models.dev': 'sourceModelsDev',
  config: 'sourceConfig',
  default: 'sourceDefault',
};

/** 一个键在不在用户层里——这就是「有没有被覆盖」的判据：写了与默认值相同的值也算覆盖。 */
function hasKey(layer: unknown, key: string): boolean {
  return typeof layer === 'object' && layer !== null && Object.prototype.hasOwnProperty.call(layer, key);
}

/**
 * 把 `{name}` 占位符换成实参。locale 服务自己做这件事，这里只是没有注入 `t` 时（测试、以及
 * 渲染器还没绑定字典时）用同一套规则兜底——否则字典里的模板会原样漏到界面上。
 *
 * @returns {string} 填好的字符串。
 */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

// ------------------------------------------------------------ 设置表单模型

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

// ------------------------------------------------------------------ 配置页

/** 本插件字典的键（内置中文那一份的键集就是权威，`LocaleNamespaceMap` 按它声明）。 */
type LocaleKey = keyof typeof zh;

/**
 * 一个模型这一行的草稿：输入框里的文本与开关。
 *
 * 文本字段一律是**文本形态**（容量是 `1M` / `384K` 或空串），与设置文档里的数值不是一回事；
 * 两个方向的换算由 `parseCapacity` / `formatCapacity` 负责。
 */
interface RowDraft {
  name: string;
  alias: string;
  contextWindow: string;
  maxTokens: string;
  text: boolean;
  image: boolean;
  reasoning: 'auto' | 'on' | 'off';
  api: string;
}

/** 文本类覆盖字段能取的那几个键（`textField` 只服务它们）。 */
type TextFieldKey = 'name' | 'alias' | 'api' | 'contextWindow' | 'maxTokens';

/** `PanelModelPatch` 的可写形态：这一页是逐字段攒出一份稀疏补丁的。 */
type RowPatch = { -readonly [K in keyof PanelModelPatch]: PanelModelPatch[K] };

/** `patchOf` 的结果：要发出去的补丁，与读不出数值的字段名（给人看）。 */
interface RowPatchResult {
  patch: RowPatch;
  bad: string[];
}

/** 一行草稿表（模型 id → 草稿）。 */
type RowDrafts = Record<string, RowDraft>;

/** 一行的展开状态（模型 id → 是否展开）。 */
type RowOpened = Record<string, boolean>;

/** 顶栏那条提示。 */
interface Notice {
  ok: boolean;
  text: string;
}

/** 一个文本类覆盖字段的读写词汇与说明。 */
interface TextFieldCopy {
  /** 字段名的字典键。 */
  label: LocaleKey;
  /** 长解释的字典键（官方那个「i」按钮）。 */
  hint: LocaleKey;
  /** 这一项的事实来源怎么取。 */
  source: (model: PanelModel) => FactSource;
  /** 「恢复默认」落到草稿里的值。 */
  cleared: string;
  /** 容量那两项：认 `1M` / `384K`，读不出来的挡住保存。 */
  numeric?: boolean;
  /** 这一项不覆盖时回落到的值，摆在占位符里。 */
  placeholder?: (model: PanelModel) => string;
}

/** 报告与两个写端点（走 `aperturePanel` Remote）。 */
interface PanelFace {
  status(): Promise<PanelReport>;
  refresh(): Promise<PanelAction>;
  writeModel(id: string, patch: PanelModelPatch | null): Promise<PanelAction>;
}

/** 注入面里 `useApertureCard` 交给组件的快照：官方表单外壳加上这一页那两个字段。 */
type ApertureCardSnapshot = SettingsFormShell & {
  baseUrl: SettingsFieldState;
  sync: SettingsFieldState;
};

/**
 * 配置页组件拿到的注入面：注册时 `inject` 返回什么，这里就要求什么；渲染器另外把
 * `locale: NS` 绑成 `t`、把 `hooks.apertureCard` 变成 `useApertureCard` 选择器钩子。
 */
interface AperturePanelProps {
  /** 字典（注册时声明了 `locale: NS`）；没有时用内置中文兜底（测试与首次渲染）。 */
  t?: TranslateNS<typeof NS>;
  /** 表单投影的选择器钩子。 */
  useApertureCard: <T>(select: (snapshot: ApertureCardSnapshot) => T) => T;
  /** 报告与两个写端点。 */
  panel: PanelFace;
  /** 官方表单模型的动作（`save` 用的是可等待的那一个，见下）。 */
  edit: SettingsFormActions['edit'];
  resetField: SettingsFormActions['resetField'];
  discard: SettingsFormActions['discard'];
  /** 保存所有草稿，等它落盘。 */
  save: () => Promise<void>;
  /** 这一轮的保存是否被拒。 */
  failed: () => boolean;
}

/**
 * 一个模型此刻在表单里长什么样。
 *
 * 取的都是**生效值**，输入框里显示的永远是此刻真正在用的东西；提交时逐字段与这份快照比较，
 * 只有改动过的字段才会发出去，因此界面不编辑的 `reasoningEfforts` 之类不会被顺手抹掉。
 */
function initialOf(model: PanelModel): RowDraft {
  return {
    name: model.name,
    alias: model.alias ?? '',
    // 容量回写成能原样读回来的最短写法（`1M`、`384K`），与官方「模型」页同一套词汇。
    contextWindow: formatCapacity(model.contextWindow),
    maxTokens: formatCapacity(model.maxTokens),
    text: model.input.includes('text'),
    image: model.input.includes('image'),
    // 「跟随发现」= 用户层里没写过这个键。写过了，生效值就是用户写的那个值。
    reasoning: declaredIn(model, 'thinking') ? (model.reasoning ? 'on' : 'off') : 'auto',
    api: declaredIn(model, 'api') ? (model.protocol ?? '') : '',
  };
}

/**
 * 用户层里写没写过这个键——这就是「覆盖」的判据。
 *
 * 报告里的 `overrideKeys` 直接来自用户层，不必拿生效值和默认值比：比出来的答案既会漏（写了与
 * 默认相同的值），也会多（schema 补出来的空值）。
 */
function declaredIn(model: PanelModel, key: string): boolean {
  return (model.overrideKeys ?? []).includes(key);
}

/** 覆盖键在界面上的名字；界面不编辑的键（`reasoningEfforts`）另给一个词条。 */
const OVERRIDE_NAMES: Readonly<Record<string, LocaleKey>> = {
  name: 'editName',
  api: 'editApi',
  contextWindow: 'editContextWindow',
  maxTokens: 'editMaxTokens',
  input: 'editInput',
  thinking: 'editReasoning',
  alias: 'editAlias',
  reasoningEfforts: 'keyReasoningEfforts',
};

/**
 * 配置页：实例（地址、同步开关）与模型清单。
 *
 * 表单状态读注入面里的 `useApertureCard`（官方 SettingsFormModel 的投影），报告、提示语与每行
 * 草稿是局部状态——它们是这一页的视图状态，不是设置文档的一部分。报告本身（`panel.status` 那一份
 * 结构化数据）仍然要读：每一行的事实、覆盖与状态点都长在它上面，只是不再整块摊开给用户看。
 *
 * **effect 的依赖里刻意不放注入面**：`inject` 面由渲染器每次渲染重新组装，把它的身份放进依赖会
 * 让 effect 每渲染一次就重跑一次。因此报告用一个自增计数器当重读信号（依赖里只有那个数），注入
 * 面里的函数只在事件处理里调用，拿到的永远是当轮的那份。
 *
 * @param {object} props - 注入面：`useApertureCard`、`panel`（报告端点）、`save` / `edit` /
 *   `resetField` / `discard` / `failed`（设置表单）与 `t`（字典，注册时声明了 `locale`）。
 * @returns {object} 页面元素。
 */
function AperturePanel(props: AperturePanelProps) {
  const t: TranslateNS<typeof NS> = typeof props.t === 'function'
    ? props.t
    : (key, params) => interpolate(zhDict[key] ?? key, params);
  const state = props.useApertureCard((snapshot) => snapshot);

  const [report, setReport] = React.useState<PanelReport | null>(null);
  const [banner, setBanner] = React.useState<Notice | null>(null);
  const [busy, setBusy] = React.useState('');
  const [drafts, setDrafts] = React.useState<RowDrafts>({});
  const [opened, setOpened] = React.useState<RowOpened>({});
  const [revision, setRevision] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    props.panel.status().then(
      (next) => {
        if (!cancelled) setReport(next);
      },
      (error) => {
        if (!cancelled) setBanner({ ok: false, text: textOf(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [revision]);

  /** 跑一个动作：期间禁用控件，结束后把结果贴出来并按需重读报告。 */
  const run = (key: string, action: () => Promise<PanelAction>, after?: () => void): void => {
    setBusy(key);
    setBanner(null);
    void (async () => {
      try {
        const result = await action();
        setBanner({ ok: result.ok, text: result.summary });
      } catch (error) {
        setBanner({ ok: false, text: textOf(error) });
      } finally {
        setBusy('');
        if (after !== undefined) after();
      }
    })();
  };

  /**
   * 保存设置里那两个字段，然后等一轮重新发现落地再说话。
   *
   * 写入走官方表单模型的 `save()`：它自带 `revision` 围栏（期间别处改过就拒绝，而不是覆盖别人的
   * 改动）并从宿主接受的那份重新播种，因此写完不重读设置——投影会自己变新。报告里的模型事实
   * 与状态点来自最近一次刷新，写完必须等一轮，否则就是「保存了却没变」。设置变更自己也会唤起同一轮
   * 刷新（单飞判定按配置版本合并），因此这里通常并进那一轮。
   */
  const saveSettings = () => run('save', async () => {
    await props.save();
    if (props.failed()) return { ok: false, summary: t('configRefused') };
    const round = await props.panel.refresh();
    // 写入成功了，但重新发现可能失败——两件事不能混成一句话说，因此后半句照抄那一轮的说法。
    return { ok: round.ok, summary: t('savedResult', { result: round.summary }) };
  }, () => setRevision((value) => value + 1));

  /** 一个模型此刻的草稿；没改过就是生效值本身。 */
  const draftOf = (model: PanelModel): RowDraft => drafts[model.id] ?? initialOf(model);

  /** 改这一行的几个字段；用函数式更新，同一个 tick 里连着改几项也不会互相覆盖。 */
  const stage = (model: PanelModel, changes: Partial<RowDraft>): void => {
    setDrafts((current) => ({
      ...current,
      [model.id]: { ...(current[model.id] ?? initialOf(model)), ...changes },
    }));
  };

  /**
   * 改动的字段 → 补丁；没变的不进补丁，非法值只报字段名。补丁里的空值就是「这一项不覆盖」：
   * 文本字段用空串或 `null`（别名用空串），模态用 `null`，推理用 `null` 表示回落到发现。
   */
  const patchOf = (draft: RowDraft, initial: RowDraft): RowPatchResult => {
    const patch: RowPatch = {};
    const bad: string[] = [];

    // 前后空白不算改动：只把 `  名字  ` 的空格去掉不算换过值，否则会凭空写下一笔覆盖。
    const name = draft.name.trim();
    if (name !== initial.name) patch.name = name === '' ? null : name;

    const alias = draft.alias.trim();
    if (alias !== initial.alias) patch.alias = alias;

    for (const [field, label] of [['contextWindow', 'editContextWindow'], ['maxTokens', 'editMaxTokens']] as const) {
      if (draft[field] === initial[field]) continue;
      // 容量认 `1M`、`100K` 这种写法（官方「模型」页同一套）；空串是「这一项不覆盖」。
      const value = parseCapacity(draft[field]);
      if (capacityBad(draft[field])) bad.push(t(label));
      else if (value === undefined) patch[field] = null;
      // 换一种写法写同一个数（`100k` 对 `100K`）不是改动：写下去只会多一笔没人改过的覆盖。
      else if (value !== parseCapacity(initial[field])) patch[field] = value;
    }

    if (draft.api !== initial.api) patch.api = draft.api === '' ? null : draft.api;
    if (draft.reasoning !== initial.reasoning) {
      patch.thinking = draft.reasoning === 'auto' ? null : draft.reasoning === 'on';
    }

    const wanted = [draft.text ? 'text' : undefined, draft.image ? 'image' : undefined]
      .filter((item): item is Modality => item !== undefined);
    const before = [initial.text ? 'text' : undefined, initial.image ? 'image' : undefined]
      .filter((item): item is Modality => item !== undefined);
    if (wanted.join('+') !== before.join('+')) patch.input = wanted.length === 0 ? null : wanted;

    return { patch, bad };
  };

  /**
   * 容量那一项的本地判定，输入框与保存走同一条规矩：空串不是非法，是「这一项不覆盖」；其余必须
   * 是不小于 1 的整数——面板只收这种值，放过去只会换来一次没必要的往返。`1G`、`1.5`、`0` 都在
   * 这里被挡下。
   */
  const capacityBad = (text: string): boolean => {
    const value = parseCapacity(text);
    return value !== undefined && (!Number.isInteger(value) || value < 1);
  };

  /** 这一行有没有还没写下去的改动。 */
  const dirtyOf = (model: PanelModel): boolean =>
    Object.keys(patchOf(draftOf(model), initialOf(model)).patch).length > 0;

  /** 丢掉一行的草稿：输入框回到生效值。 */
  const dropDraft = (id: string): void => {
    setDrafts((current) => {
      const { [id]: _dropped, ...kept } = current;
      return kept;
    });
  };

  /** 展开或收起一行；收起不动草稿——收起来不等于放弃，标签会写着还有未保存的改动。 */
  const toggleRow = (model: PanelModel): void =>
    setOpened((current) => ({ ...current, [model.id]: current[model.id] !== true }));

  /**
   * 写下这一行（一个模型）的改动。
   *
   * 一行一个保存按钮，写下去的就只有这一行，宿主那边的版本校验也只管这一次写入。成功后收起面板
   * ——这一行的覆盖标签与事实都会跟着变，收起才看得见。
   *
   * @param {object} model - 报告里的一个模型。
   */
  const submitRow = (model: PanelModel): void => {
    const { patch, bad } = patchOf(draftOf(model), initialOf(model));
    if (bad.length > 0) {
      setBanner({ ok: false, text: t('invalidNumber', { field: bad.join(t('listSeparator')) }) });
      return;
    }
    if (Object.keys(patch).length === 0) {
      setBanner({ ok: true, text: t('noChanges') });
      return;
    }
    run('edit', () => props.panel.writeModel(model.id, patch), () => {
      dropDraft(model.id);
      setOpened((current) => ({ ...current, [model.id]: false }));
      setRevision((value) => value + 1);
    });
  };

  /** 取消这一行的编辑：草稿丢掉、面板收起，什么都不写。 */
  const cancelRow = (model: PanelModel): void => {
    dropDraft(model.id);
    setOpened((current) => ({ ...current, [model.id]: false }));
    setBanner(null);
  };

  /**
   * 撤销这一行的覆盖：只把**报告里写着确实被覆盖过**的字段清掉。
   *
   * 不是整条删掉：`aperture.models` 里那条可能还有界面根本不编辑的键（例如 `reasoningEfforts`），
   * 整条删掉等于把用户手写的东西一起扔掉，因此只把已知被覆盖的字段逐个置空。万一报告里出现了
   * 界面不认识的键（宿主以后加了字段），整条删掉是唯一能让这一行真的回落到发现值的做法。
   *
   * @param {object} model - 报告里的一个模型。
   */
  const clearOverrides = (model: PanelModel): void => {
    const keys = model.overrideKeys ?? [];
    const known = keys.filter((key) => EDITABLE_KEYS.includes(key));
    const unknown = keys.filter((key) => !EDITABLE_KEYS.includes(key));
    // 别名用空串表示「不要再覆盖」；其余字段 `null` 就是「不覆盖这一项」。
    const patch = Object.fromEntries(known.map((key) => [key, key === 'alias' ? '' : null]));
    const payload = unknown.length > 0 || known.length === 0 ? null : patch;
    run('revert', () => props.panel.writeModel(model.id, payload), () => {
      dropDraft(model.id);
      setOpened((current) => ({ ...current, [model.id]: false }));
      setRevision((value) => value + 1);
    });
  };

  const refreshReport = () => run('refresh', () => props.panel.refresh(), () => setRevision((value) => value + 1));

  /** 来源那句：报告里的事实都有出处，界面按语言渲染它。 */
  const sourceOf = (fact: FactSource): string => t('factSource', {
    source: SOURCE_KEYS[fact] === undefined ? fact : t(SOURCE_KEYS[fact]),
  });

  /** 最近一轮写入过的路由名；`undefined` 是「这一轮没同步」，不是「没写」——同步关着的时候报告里
   * 根本没有这一项，界面不能把「不知道」说成「没写」。
   */
  const writtenRoutes = report === null || report.refresh === undefined || report.refresh.sync === undefined
    ? undefined
    : report.refresh.sync.routes;

  /** 一行模型那几项生效的事实，一项一句；缺哪项就不提哪项。 */
  const factItems = (model: PanelModel): string[] => {
    const facts: string[] = [];
    if (model.route !== undefined) facts.push(t('factRoute', { route: model.route }));
    if (model.protocol !== undefined) facts.push(t('factProtocol', { protocol: model.protocol }));
    if (model.contextWindow !== undefined) {
      facts.push(t('factContextWindow', { count: formatCount(model.contextWindow) }));
    }
    if (model.maxTokens !== undefined) facts.push(t('factMaxTokens', { count: formatCount(model.maxTokens) }));
    facts.push(t('factInput', {
      value: model.input.length === 0
        ? t('modalityNone')
        : model.input.map((item) => t(item === 'image' ? 'modalityImage' : 'modalityText')).join('+'),
    }));
    facts.push(t('factReasoning', { value: model.reasoning ? t('reasoningOn') : t('reasoningOff') }));
    if (model.alias !== undefined && model.alias !== '') facts.push(t('factAlias', { alias: model.alias }));
    return facts;
  };

  /**
   * 这一行的状态点：绿是写进去了、灰是没写进去、黄是根本没有路由能服务它。
   *
   * 点旁边那句 `title` 就是它的说法——官方 `StateDot` 自己是 `aria-hidden`，说给谁听得由这里给。
   */
  const publishState = (model: PanelModel): { state: StateDotState; title: string } => {
    if (model.route === undefined) return { state: 'warning', title: t('statusUnserved') };
    if (writtenRoutes === undefined) return { state: 'idle', title: t('statusUnknown') };
    return writtenRoutes.includes(model.route)
      ? { state: 'done', title: t('statusPublished') }
      : { state: 'idle', title: t('statusNotPublished') };
  };

  /** 把覆盖键翻成给人看的一句话：界面认得的键都有字段，认不得的只有这里说得出名字。 */
  const overrideKeyNames = (keys: readonly string[]): string => keys
    .map((key) => (OVERRIDE_NAMES[key] === undefined ? key : t(OVERRIDE_NAMES[key])))
    .join(t('listSeparator'));

  /**
   * 一个文本类覆盖字段。
   *
   * 官方 `SettingsValueField` 的语义正好对得上：「已覆盖」= 用户层里有这个键（报告给的
   * `overrideKeys`），「恢复默认」= 把草稿改回「不覆盖」，非法草稿只标出来、由保存拦住。
   *
   * 长解释进 `help`（官方那个「i」按钮），输入框下面只留一句来源；外面再套一层格子，官方字段行
   * 那条「相邻就加上边框」在网格里会错开半格，隔开一层壳就不碰它了。
   */
  const textField = (model: PanelModel, key: TextFieldKey, copy: TextFieldCopy) => (
    <div className="dap-fieldCell">
      <SettingsValueField
        id={`dap-${model.id}-${key}`}
        label={t(copy.label)}
        help={{ label: t('fieldHelp', { field: t(copy.label) }), content: t(copy.hint) }}
        hint={sourceOf(copy.source(model))}
        {...(copy.placeholder === undefined ? {} : { placeholder: copy.placeholder(model) })}
        {...(copy.numeric === true ? { numeric: true } : {})}
        text={draftOf(model)[key]}
        overridden={declaredIn(model, key)}
        // 只有容量那两项用 `1M`/`384K` 的词汇，因此也只有它们会「读不出来」；文本字段写什么都算数。
        invalid={copy.numeric === true && capacityBad(draftOf(model)[key])}
        overriddenLabel={t('overridden')}
        resetLabel={t('resetField')}
        invalidLabel={t('invalidField')}
        disabled={busy !== ''}
        onEdit={(text) => stage(model, { [key]: text })}
        onReset={() => stage(model, { [key]: copy.cleared })}
      />
    </div>
  );

  /** 一行模型的覆盖编辑器：只写这一行。 */
  const editor = (model: PanelModel) => {
    const draft = draftOf(model);
    const overrides = model.overrideKeys ?? [];
    const changed = Object.keys(patchOf(draft, initialOf(model)).patch).length;
    // 界面认不得的键（`reasoningEfforts` 之类）只有「清空覆盖」撤得掉，而那是整条删，得先说清楚。
    const unknown = overrides.filter((key) => !EDITABLE_KEYS.includes(key));
    return (
      <div className="dap-editor">
        <div className="dap-editorHead">
          <span className="dap-editorId" title={model.id}>{model.id}</span>
          {unknown.length === 0
            ? null
            : (
              <span className="dap-warnNote">
                {t('editUnknownOverrides', { keys: overrideKeyNames(unknown) })}
              </span>
            )}
          {dirtyOf(model)
            ? <Tag tone="warning" className="dap-editorDirty">{t('dirtyTag')}</Tag>
            : null}
        </div>
        <div className="dap-editGroup">
          <span className="dap-editGroupTitle">{t('editGroupIdentity')}</span>
          <div className="dap-fields">
            {textField(model, 'name', {
              label: 'editName',
              hint: 'editNameHint',
              source: (item) => item.provenance.name,
              cleared: '',
            })}
            {textField(model, 'alias', {
              label: 'editAlias',
              hint: 'editAliasHint',
              source: () => 'config',
              cleared: '',
            })}
            {textField(model, 'api', {
              label: 'editApi',
              hint: 'editApiHint',
              // 协议没有单独一项来源：写过就是配置，没写过就是从通告的端点推导出来的。
              source: (item) => (declaredIn(item, 'api') ? 'config' : 'aperture'),
              cleared: '',
              placeholder: (item) => item.protocol ?? '',
            })}
          </div>
        </div>
        <div className="dap-editGroup">
          <span className="dap-editGroupTitle">{t('editGroupCapacity')}</span>
          <div className="dap-fields">
            {textField(model, 'contextWindow', {
              label: 'editContextWindow',
              hint: 'editCapacityHint',
              source: (item) => item.provenance.limits,
              cleared: '',
              numeric: true,
              // 清空之后回落到的就是发现到的那个数，摆在占位符里最省事。
              placeholder: (item) => formatCapacity(item.contextWindow),
            })}
            {textField(model, 'maxTokens', {
              label: 'editMaxTokens',
              hint: 'editCapacityHint',
              source: (item) => item.provenance.limits,
              cleared: '',
              numeric: true,
              placeholder: (item) => formatCapacity(item.maxTokens),
            })}
          </div>
        </div>
        {/* 模态与推理并排：它们都是「一个开关加一句话」，横着放比竖着叠省一半高度。 */}
        <div className="dap-grid2">
          <div className="dap-editGroup">
            <span className="dap-editGroupTitle">{t('editInput')}</span>
            <div className="dap-control">
              <Checkbox
                checked={draft.text}
                onChange={(next) => stage(model, { text: next })}
                label={t('modalityText')}
                disabled={busy !== ''}
              />
              <Checkbox
                checked={draft.image}
                onChange={(next) => stage(model, { image: next })}
                label={t('modalityImage')}
                disabled={busy !== ''}
              />
              {overrides.includes('input') ? <Tag tone="neutral">{t('overridden')}</Tag> : null}
            </div>
            <span className="dap-hint">{sourceOf(model.provenance.input)}</span>
          </div>
          <div className="dap-editGroup">
            <span className="dap-editGroupTitle">{t('editReasoning')}</span>
            {/* 显式给出 `Value`：`options` 里的字面量会被拓宽成 `string`，不给的话 `onChange`
                拿到的就是 `string`，与草稿上的字面量联合对不上。 */}
            <SegmentedControl<RowDraft['reasoning']>
              id={`dap-${model.id}-reasoning`}
              label={t('editReasoning')}
              value={draft.reasoning}
              options={[
                { value: 'auto', label: t('reasoningFollow') },
                { value: 'on', label: t('reasoningOn') },
                { value: 'off', label: t('reasoningOff') },
              ]}
              onChange={(next) => stage(model, { reasoning: next })}
              disabled={busy !== ''}
            />
            <span className="dap-hint">{sourceOf(model.provenance.reasoning)}</span>
          </div>
        </div>
        {model.endpoints.length === 0
          ? null
          : (
            <div className="dap-endpoints">
              <span className="dap-editGroupTitle">{t('factEndpoints')}</span>
              <ul className="dap-endpointList">
                {model.endpoints.map((endpoint) => (
                  <li className="dap-endpoint" key={endpoint}>{endpoint}</li>
                ))}
              </ul>
            </div>
          )}
        <div className="dap-actions">
          <span className="dap-actionsNote">
            {changed === 0 ? t('noPendingChanges') : t('pendingChanges', { count: changed })}
          </span>
          <Button variant="ghost" size="sm" onClick={() => cancelRow(model)} disabled={busy !== ''}>
            {t('cancelRow')}
          </Button>
          {overrides.length === 0
            ? null
            : (
              <Button variant="outline" size="sm" onClick={() => clearOverrides(model)} disabled={busy !== ''}>
                {t('clearOverrides')}
              </Button>
            )}
          <Button variant="primary" size="sm" onClick={() => submitRow(model)} disabled={busy !== ''}>
            {busy === 'edit' ? t('saving') : t('saveRow')}
          </Button>
        </div>
      </div>
    );
  };

  /**
   * 一行模型：折起来是身份与状态，展开是这一行的覆盖编辑器。
   *
   * 行首那条按钮盖满整行（官方 `DisclosureRow` 是一根 24px 高、`overflow:hidden` 的横条，标题又
   * 不许收缩，名字一长就把右边的事实和标签挤没了）。这里名字自己一行、过长省略，事实另起一行随
   * 宽度换行，标签跟在名字后面。
   */
  const modelRow = (model: PanelModel) => {
    const open = opened[model.id] === true;
    const overrides = model.overrideKeys ?? [];
    const status = publishState(model);
    return (
      <li key={model.id} className="dap-card">
        <button
          type="button"
          className="dap-cardHead"
          aria-expanded={open ? 'true' : 'false'}
          onClick={() => toggleRow(model)}
        >
          <span className="dap-status" role="img" aria-label={status.title} title={status.title}>
            <StateDot state={status.state} size={10} />
          </span>
          <span className="dap-identity">
            <span className="dap-identityTop">
              <span className="dap-name" title={model.name}>{model.name}</span>
              {model.route === undefined ? <Tag tone="warning">{t('unservedTag')}</Tag> : null}
              {overrides.length === 0
                ? null
                : (
                  // 这一层只为挂 `title`：官方 `Tag` 除了 tone/className/children 什么都不透传，
                  // 想让人 hover 看出「覆盖的是哪几项」就得自己在外面套一层。
                  <span className="dap-tagWrap" title={overrideKeyNames(overrides)}>
                    <Tag tone="neutral">{t('overriddenCount', { count: overrides.length })}</Tag>
                  </span>
                )}
              {dirtyOf(model) ? <Tag tone="warning">{t('dirtyTag')}</Tag> : null}
            </span>
            <span className="dap-factRow">
              {factItems(model).map((item, index) => (
                <span className="dap-factItem" key={`${model.id}-fact-${String(index)}`}>{item}</span>
              ))}
            </span>
          </span>
          <span className="dap-chevron" data-open={open ? 'true' : 'false'}>
            <IconChevronRightOutlineRegular size={14} />
          </span>
        </button>
        {open ? editor(model) : null}
      </li>
    );
  };

  /**
   * 这一轮哪里不对：清单读不到、或者该写的东西没写进去。
   *
   * 「发现报告」那一块删掉之后，这些原本只写在报告事实表里的话得有地方落脚——否则清单挂了的时候，
   * 用户看到的就只是「还没有发现任何模型」，没有任何理由。刷新整个失败（`ok: false`）不在这里说：
   * 那句话由 `run()` 贴到提示语上，比这里更显眼。正常的一轮（同步关着 / 同步成功）什么都不说。
   */
  const roundProblem = (current: PanelReport | null): string | null => {
    const refresh = current === null ? undefined : current.refresh;
    if (refresh === undefined) return null;
    if (!refresh.catalog.available) {
      return t('catalogUnavailable', { reason: refresh.catalog.reason ?? '—' });
    }
    if (refresh.sync !== undefined && !refresh.sync.applied) {
      return t('syncSkipped', { reason: refresh.sync.reason ?? '—' });
    }
    return null;
  };

  const controlsDisabled = !state.available || !state.writable;
  const problem = roundProblem(report);

  return (
    <div data-dsh-aperture="">
      <SettingsForm
        labels={{
          unavailable: t('unavailable'),
          readOnly: t('readOnly'),
          saveFailed: t('saveFailed'),
          save: t('save'),
          saving: t('saving'),
        }}
        state={state}
        onSave={saveSettings}
        onDiscard={props.discard}
      >
        <SettingsValueField
          id="dap-base-url"
          label={t('addressLabel')}
          hint={t('addressHint')}
          placeholder={t('addressPlaceholder')}
          text={state.baseUrl.text}
          overridden={state.baseUrl.overridden}
          invalid={state.baseUrl.invalid}
          overriddenLabel={t('overridden')}
          resetLabel={t('resetField')}
          invalidLabel={t('invalidField')}
          disabled={controlsDisabled || state.saving}
          onEdit={(text) => props.edit('baseUrl', text)}
          onReset={() => props.resetField('baseUrl')}
        />
        <div className="dap-toggleRow">
          <div className="dap-toggleText">
            <span>{t('syncLabel')}</span>
            <span className="dap-hint">{t('syncHint')}</span>
          </div>
          <div className="dap-inline">
            {state.sync.overridden ? <Tag tone="info">{t('overridden')}</Tag> : null}
            {state.sync.overridden
              ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => props.resetField('sync')}
                  disabled={controlsDisabled || state.saving}
                >
                  {t('resetField')}
                </Button>
              )
              : null}
            <Switch
              checked={state.sync.text === 'true'}
              onChange={(next) => props.edit('sync', next ? 'true' : 'false')}
              label={t('syncLabel')}
              disabled={controlsDisabled || state.saving}
            />
          </div>
        </div>
      </SettingsForm>
      {banner === null
        ? null
        : (
          <p
            className="dap-banner"
            data-ok={banner.ok ? 'true' : 'false'}
            role="status"
            aria-live="polite"
          >
            {banner.text}
          </p>
        )}
      <section className="dap-group">
        <div className="dap-groupHead">
          <span className="dap-titleWrap">
            <h3 className="dap-groupTitle">{t('modelsTitle')}</h3>
            {report === null
              ? null
              : <span className="dap-count">{t('modelsCount', { count: report.models.length })}</span>}
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRefreshOutlineRegular size={14} />}
            onClick={refreshReport}
            disabled={busy !== ''}
            title={t('refreshHint')}
          >
            {busy === 'refresh' ? t('refreshing') : t('refresh')}
          </Button>
        </div>
        <p className="dap-hint">{t('modelsHint')}</p>
        {problem === null ? null : <p className="dap-warnNote">{problem}</p>}
        {report === null
          ? <p className="dap-hint">{t('loading')}</p>
          : report.models.length === 0
            // 没有实例地址时发现根本不会跑，这时说「还没发现到模型」等于没说——那句话要说清为什么。
            // 只在设置读得到的时候这么说：读不到时地址存不存在都不知道，那是另一件事（表单自己会说）。
            ? <p className="dap-empty">{state.available && state.baseUrl.text === '' ? t('dormantHint') : t('noModels')}</p>
            : (
              <ul className="dap-rows">
                {report.models.map(modelRow)}
              </ul>
            )}
      </section>
    </div>
  );
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
 * 浏览器插件主体：字典、样式、Remote 贡献，以及「插件」页里本插件那个包页的配置页。
 *
 * `ctx.slots.inject` 是必需的，不是可选的：`plugins.bundle.config` 由插件管理页自己声明，那个
 * 声明完全可能在本插件 `apply` 之后才发生，直接 register 会撞上「槽位尚未声明」。
 *
 * 注册的键是**包名**：键控槽位按它找贡献，点开插件列表里的本插件就是这一页。设置那一份表单也
 * 在这里取——页主只递 `view`，`configForms.get(命名空间)` 才是这一页的配置读写面；服务按命名
 * 空间缓存控制器，因此它与插件页自己取到的是同一份。
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
