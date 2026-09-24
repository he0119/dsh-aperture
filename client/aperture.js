/**
 * `dsh-aperture` 浏览器半边：**「插件」页里本插件那个包页上的配置页**。
 *
 * 写法照官方插件：页面只交内容，控件用官方原语，**没有卡片**。
 *
 * - 注册在包级配置槽位 `plugins.bundle.config` 上，键是包名 `dsh-aperture`：点开插件列表里的本
 *   插件就直接是这一页，标题、图标与面包屑由页主画；
 * - 地址与同步开关交给官方那套设置表单（`SettingsForm` / `SettingsValueField` /
 *   `SettingsFormModel`）：草稿与生效值的差分、`revision` 围栏写入、保存失败保留草稿、只读与
 *   「命名空间没在服务」的说明都归它管，本模块只声明每个字段怎么在「存下来的值」与「输入框里的
 *   文本」之间换算；
 * - 模型清单是一列 `DisclosureRow`（展开就是这一行的覆盖编辑），路由与刷新事实是扁平的
 *   `dl` 配 `Tag` / `StateDot`；分组只靠小标题、字号与间距，不画边框与底色；
 * - 客户端模块系统把 `dsh.client.inject` 里列出的包注册成可 `require` 的模块，因此这里可以
 *   `require('@deepseek-ai/dsh-client-ui-primitives')`——官方客户端包就是这么用它的，本仓库
 *   不必为此引入打包器。
 *
 * 注入面是 `slots` / `locale` / `remote` / `configForms` 四个服务。报告与「立刻刷新」经自己的
 * `aperturePanel` Remote 往返；设置的读写面向 `configForms` 要——**包级**配置页页主只递
 * `view: 'page'`、不递 `form`（递 `form` 的是行级与条目级），所以这一份得按设置命名空间自己取。
 * 组件读宿主来的状态走官方的槽位钩子（注入面里的 `hooks`，渲染器把它变成 `useApertureCard`
 * 选择器钩子），动作走注入面里的普通函数。
 *
 * **这个文件就是构建产物。** DSH 的客户端模块系统只要求一个经典脚本，用
 * `window.__ModuleLoader__.load({ id, factory })` 的握手把自己报上去；它不要求这份脚本
 * 经过打包器，也不检查它是否被压缩过。因此这里直接写 CJS 工厂体，用 `createElement`
 * 而不是 JSX。
 *
 * @module dsh-aperture/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-aperture',
  factory: (require) => {
    const React = require('react');
    const {
      SettingsForm,
      SettingsValueField,
      SettingsFormModel,
      settingsTextField,
      Button,
      Checkbox,
      DisclosureRow,
      SegmentedControl,
      StateDot,
      Switch,
      Tag,
    } = require('@deepseek-ai/dsh-client-ui-primitives');

    const h = React.createElement;

    /** 字典命名空间（本插件拥有）。配置页的 `locale` 声明与 `ctx.locale.bind` 都用它。 */
    const NS = 'settings.aperturePanel';
    /** 宿主半边的 Remote 命名空间（`src/remote.ts`）。 */
    const PANEL = 'aperturePanel';
    /** 包名，取自 package.json。它同时是包级配置页的键。 */
    const PACKAGE = 'dsh-aperture';
    /** 样式表的归属标记；卸载与热替换时按它回收。 */
    const STYLE_OWNER = 'aperture/client.js';
    /**
     * 设置命名空间（宿主半边 `src/config.ts` 里的 `APERTURE_NAMESPACE`，也是
     * `cordis.patch.yml` 里那一行的 id）。
     *
     * 包级配置页页主不递 `form`，这一份表单就是按它向 `configForms` 服务要来的。
     */
    const SETTINGS_NS = 'aperture';
    /** 这一页自己编辑的两个字段；其余配置键（`models` 除外）留给配置文件。 */
    const FIELDS = Object.freeze(['baseUrl', 'sync']);

    // ---------------------------------------------------------------- 端点契约

    /**
     * 浏览器半边与宿主半边之间的那层线格式。
     *
     * 这里只有一个直通编解码器，因为浏览器侧从不解析这些值：注册表
     * （`@deepseek-ai/dsh-typert-registry`）只检查 `mode` 是 `strict`、`typeSymbol` 非空、
     * `create` 是个函数；网关客户端只读参数上的 `mode` 与结果上可选的 `decode`/`encode`，
     * **没有一处调用 `create()`**。逐字段手写一套 wire 校验因此永远不会执行——曾经那 300 行
     * 文法还顺手埋了个雷：注册表要的是 `create` 工厂，`schema` 字段不被承认，于是 `$mount`
     * 抛 `strict codec has no create() factory`，整份贡献被拒，界面安静地什么都不出现。
     *
     * 端点名不能与命名空间服务自己的成员重名：api-gateway 为每个命名空间建一个
     * `RemoteNamespaceService`，端点会成为它的属性，撞上 `remove` / `has` / `install` /
     * `name` / `ctx` 这类预置名字时校验会拒绝**整份**贡献，新端点起名时先对一遍名单。
     */
    const SCHEMA = Object.freeze({ parse: (value) => value });
    /** 每个参数与结果共用的直通编解码器。 */
    const CODEC = Object.freeze({
      mode: 'strict',
      typeSymbol: `${PACKAGE}/types#any`,
      create: () => SCHEMA,
    });

    /**
     * 一个端点的浏览器侧描述符。
     *
     * 参数按宿主方法的形参顺序给出；调用点按位置传参，网关按 `wire` 映射，并且**自动省掉
     * `undefined` 实参**（`if (value !== void 0) args[parameter.wire] = value`），所以「没提到
     * 的参数」天然就是「不碰」，不需要描述符额外声明什么。
     *
     * @param {string} method - 端点方法名（也是宿主服务上的方法名）。
     * @param {Array<string>} parameters - 参数名，顺序与宿主方法一致。
     * @returns {object} 描述符。
     */
    function descriptor(method, parameters = []) {
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

    /** 与宿主半边 `PANEL_INVOCATIONS` 一一对应的贡献。 */
    const REMOTE = Object.freeze({
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
     * 把 `RemoteResult` 拆成值，失败则抛人话。
     *
     * @param {{ok: boolean}} result - 端点应答。
     * @returns {object} 端点值。
     */
    function unwrap(result) {
      if (result.ok) return result.value;
      const detail = result.error && result.error.message ? result.error.message : '未知原因';
      throw new Error(`面板暂时连不上后台（${detail}）；若反复出现请重启 dsh web。`);
    }

    // -------------------------------------------------------------------- 样式

    /**
     * 配置页样式。
     *
     * 页面在独立 bundle 里，用不了仓库的 CSS module 管线，因此样式随包分发、按 effect 生命周期
     * 注入，卸载时移除；元素按 `data-plugin-css` 认领，与自己重名的那份先删掉（热替换）。
     *
     * 选择器全部收在根节点的 `[data-dsh-aperture]` 之下，颜色只引用 dsh web 的主题 token
     * （`--dsw-alias-*`，各带回落值），深浅色自动跟随。布局照官方设置页的口径：分组之间 20px、
     * 组内 12px，字段排成 `minmax(200px, 1fr)` 的栅格，说明文字 12px，正文字号 13px。**没有
     * 卡片**：分组靠小标题与间距分开，只有模型清单那种「一列可展开的行」才用一条细边框收着。
     *
     * @returns {Function} 卸载时移除样式表的 disposer。
     */
    function installStyles() {
      const stale = document.querySelector(`style[data-plugin-css="${STYLE_OWNER}"]`);
      if (stale !== null && stale.parentNode !== null) stale.parentNode.removeChild(stale);

      const element = document.createElement('style');
      element.dataset.plugin = PACKAGE;
      element.dataset.pluginCss = STYLE_OWNER;
      element.textContent = `
[data-dsh-aperture] {
  display: flex;
  flex-direction: column;
  gap: 20px;
  font-size: 13px;
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
[data-dsh-aperture] .dap-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
[data-dsh-aperture] .dap-groupHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
[data-dsh-aperture] .dap-groupTitle {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}
[data-dsh-aperture] .dap-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary, #8b8b8b);
}
[data-dsh-aperture] .dap-banner {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #c9c9c9);
}
[data-dsh-aperture] .dap-banner[data-ok='false'] {
  color: var(--dsw-alias-state-error-primary, #e06c75);
}
[data-dsh-aperture] .dap-toggleRow {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
}
[data-dsh-aperture] .dap-toggleText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
[data-dsh-aperture] .dap-badges {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
  vertical-align: middle;
}
[data-dsh-aperture] .dap-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0 12px;
  list-style: none;
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  max-height: 420px;
  overflow: auto;
}
[data-dsh-aperture] .dap-rowFacts {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary, #8b8b8b);
}
[data-dsh-aperture] .dap-editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 0 14px;
}
[data-dsh-aperture] .dap-editorGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px 16px;
}
[data-dsh-aperture] .dap-inline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
}
[data-dsh-aperture] .dap-control {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
}
[data-dsh-aperture] .dap-controlLabel {
  color: var(--dsw-alias-label-secondary, #c9c9c9);
}
[data-dsh-aperture] .dap-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-dsh-aperture] .dap-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary, #8b8b8b);
  white-space: pre-wrap;
  word-break: break-all;
}
[data-dsh-aperture] .dap-routes {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-dsh-aperture] .dap-routeHead {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
[data-dsh-aperture] .dap-facts {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}
[data-dsh-aperture] .dap-fact {
  display: flex;
  gap: 8px;
}
[data-dsh-aperture] .dap-fact dt {
  flex: none;
  min-width: 72px;
  color: var(--dsw-alias-label-tertiary, #8b8b8b);
}
[data-dsh-aperture] .dap-fact dd {
  margin: 0;
  color: var(--dsw-alias-label-secondary, #c9c9c9);
  word-break: break-all;
}
`;
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
      overriddenKeys: '覆盖了 {keys}',
      resetField: '恢复默认',
      invalidField: '要填不小于 1 的整数，或留空',

      refresh: '立刻刷新',
      refreshHint: '立刻重新发现并发布，然后把这一轮的报告摆出来。',
      refreshing: '刷新中…',
      loading: '读取中…',

      configRefused: '设置已被别处改过，这次改动没有写入：刷新页面后再改一遍。',
      savedResult: '已保存：{result}',
      noChanges: '没有改动，因此没有写入。',
      invalidNumber: '{field} 只能填不小于 1 的整数。',

      reportTitle: '发现报告',
      reportHint: '报告说的是最近一次刷新算出的事实；改设置或按「立刻刷新」都会重跑一轮。',
      dormantHint: '还没有实例地址：填上并保存之后才会去发现模型。',
      routesTitle: '路由',
      noRoutes: '还没有发布任何路由。',
      routeModels: '{count} 个模型',
      routePublished: '已写入',
      routeNotPublished: '未写入',
      routeNoBaseUrl: '（这一条路由没有 baseURL）',
      neverRefreshed: '这一轮还没跑过。',

      modelsTitle: '模型',
      modelsHint: '一行一个模型；展开改这一行的覆盖，「保存这一行」只写这一行。顺序来自发现顺序，没有路由可服务的排在最后。',
      noModels: '还没有发现任何模型。',
      unservedTag: '未服务',
      dirtyTag: '有未保存的改动',

      factTrigger: '触发',
      factTime: '时间',
      factDuration: '耗时',
      factResult: '结果',
      factCatalog: '清单',
      factEndpoint: '端点',
      factSync: '写入',
      factContextWindow: '上下文 {count}',
      factMaxTokens: '最大输出 {count}',
      factAlias: '别名 {alias}',
      factEndpoints: '网关通告的端点：',
      factSource: '来源：{source}',

      refreshOk: '成功',
      refreshFailed: '失败',
      catalogEntries: '清单 {count} 条',
      catalogUnavailable: '清单不可用（{reason}）',
      endpointListed: '{url} 列出 {count} 行',
      syncApplied: '写入 {count} 项（{routes}）',
      syncSkipped: '没写（{reason}）',
      syncOnlyRemoval: '只做了删除',

      modalityText: '文本',
      modalityImage: '图片',
      modalityNone: '不接收任何模态',
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
      saveRow: '保存这一行',
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
      overriddenKeys: 'overrides {keys}',
      resetField: 'Reset to default',
      invalidField: 'Enter an integer of at least 1, or leave it empty',

      refresh: 'Refresh now',
      refreshHint: 'Discover and republish now, then show this round’s report.',
      refreshing: 'Refreshing…',
      loading: 'Loading…',

      configRefused: 'These settings changed elsewhere, so this edit was not written. Reload the page and try again.',
      savedResult: 'Saved: {result}',
      noChanges: 'Nothing changed, so nothing was written.',
      invalidNumber: '{field} takes an integer of at least 1.',

      reportTitle: 'Discovery report',
      reportHint: 'The report states what the last discovery round worked out; saving settings or pressing Refresh now runs another.',
      dormantHint: 'No instance address yet: models are discovered once you set and save one.',
      routesTitle: 'Routes',
      noRoutes: 'No routes published yet.',
      routeModels: '{count} models',
      routePublished: 'written',
      routeNotPublished: 'not written',
      routeNoBaseUrl: '(this route has no baseURL)',
      neverRefreshed: 'No round has run yet.',

      modelsTitle: 'Models',
      modelsHint: 'One model per row; expand a row to edit its overrides, and Save row writes only that row. The order comes from discovery, with anything no route can serve last.',
      noModels: 'No models discovered yet.',
      unservedTag: 'unserved',
      dirtyTag: 'unsaved edits',

      factTrigger: 'Trigger',
      factTime: 'Time',
      factDuration: 'Duration',
      factResult: 'Result',
      factCatalog: 'Catalog',
      factEndpoint: 'Endpoint',
      factSync: 'Sync',
      factContextWindow: '{count} context',
      factMaxTokens: '{count} output',
      factAlias: 'alias {alias}',
      factEndpoints: 'Endpoints the gateway advertises:',
      factSource: 'Source: {source}',

      refreshOk: 'ok',
      refreshFailed: 'failed',
      catalogEntries: 'catalog has {count} entries',
      catalogUnavailable: 'catalog unavailable ({reason})',
      endpointListed: '{url} listed {count} rows',
      syncApplied: 'wrote {count} entries ({routes})',
      syncSkipped: 'skipped ({reason})',
      syncOnlyRemoval: 'removals only',

      modalityText: 'text',
      modalityImage: 'image',
      modalityNone: 'accepts nothing',
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
      saveRow: 'Save row',
      clearOverrides: 'Clear overrides',
      cancelRow: 'Cancel',
      keyReasoningEfforts: 'reasoning efforts',
      listSeparator: ', ',
    };

    // ------------------------------------------------------------------ 小工具

    /** 一个错误的人话形式。 */
    function textOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /** token 计数的千位分隔符；跟随浏览器语言。 */
    function formatCount(value) {
      return value.toLocaleString();
    }

    /** 容量能写成的样子：十进制数加一个可选的 K/M 后缀。 */
    const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
    /** 后缀是十进制的：`1M` 就是 1000K，跟容量平时的说法一致。 */
    const CAPACITY_SCALE = { k: 1e3, m: 1e6 };

    /**
     * 读输入框里的容量，好让人写 `1M`、`100K` 而不必去数零。
     *
     * 与官方「模型」页同一套写法（它的 `parseCapacity`）：空串是「这一项不覆盖」，读不出来的
     * 返回 `NaN`——由调用方在本地挡下来，不让它写进设置文档。
     *
     * @param {string} text - 输入框里的原文。
     * @returns {number|undefined} token 数；空串给 `undefined`，读不出来给 `NaN`。
     */
    function parseCapacity(text) {
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
     * 把存下来的 token 数写回输入框，取能原样读回来的最短写法。
     *
     * `1000000` 写成 `1M`、`384000` 写成 `384K`；`1048576` 不是整千，就照原样写出来——官方
     * `formatCapacity` 同此，两边读写的是一套 K/M 词汇。
     *
     * @param {number|undefined} value - 存下来的容量。
     * @returns {string} 输入框里的文本；没有值时是空串。
     */
    function formatCapacity(value) {
      if (value === undefined) return '';
      if (!Number.isInteger(value) || value <= 0) return String(value);
      if (value % CAPACITY_SCALE.m === 0) return `${String(value / CAPACITY_SCALE.m)}M`;
      if (value % CAPACITY_SCALE.k === 0) return `${String(value / CAPACITY_SCALE.k)}K`;
      return String(value);
    }

    /** ISO 时间戳 → 本地时间；宿主只报 ISO，时区是浏览器的事。 */
    function formatTime(iso) {
      const at = new Date(iso);
      return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
    }

    /** 事实来源 → 字典键；未知来源原样显示。 */
    const SOURCE_KEYS = {
      aperture: 'sourceAperture',
      'models.dev': 'sourceModelsDev',
      config: 'sourceConfig',
      default: 'sourceDefault',
    };

    /**
     * 一个键在不在用户层里。
     *
     * 这就是「有没有被覆盖」的判据：写了一个与默认值相同的值也是覆盖，因此只有键在不在算数。
     *
     * @param {unknown} layer - 用户层片段。
     * @param {string} key - 字段名。
     * @returns {boolean} 写过没有。
     */
    function hasKey(layer, key) {
      return typeof layer === 'object' && layer !== null && Object.prototype.hasOwnProperty.call(layer, key);
    }

    /**
     * 把 `{name}` 占位符换成实参。
     *
     * locale 服务自己做这件事；这里只是为了在没有注入 `t` 时（测试、以及渲染器还没绑定字典时）
     * 用同一套规则兜底——否则字典里的模板会原样漏到界面上。
     *
     * @param {string} template - 字典里的模板。
     * @param {Record<string, *>} params - 实参。
     * @returns {string} 填好的字符串。
     */
    function interpolate(template, params) {
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/gu, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ));
    }

    // ------------------------------------------------------------ 设置表单模型

    /**
     * 布尔字段的换算规格。
     *
     * 官方的设置表单按「草稿文本」组织，`SettingsFieldSpec` 只要求给出两个方向：存下来的值怎么
     * 写成文本，文本怎么变成一次写入。开关因此用 `'true'` / `'false'` 两个词当草稿，空串是
     * 「这一项不写」（用户层里没这个键，值回落到组合层与 schema 默认）。
     *
     * @param {string} field - 命名空间段里的字段名。
     * @returns {object} 字段规格。
     */
    function booleanField(field) {
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
     * 这份设置没有服务时用的替身。
     *
     * `configForms` 缺席时（注入表保证不会，但这一页不该因此整页消失）照样要有一个可用的表单：
     * 让 `SettingsFormModel` 读到一个 `unavailable` 的快照，官方表单自己会画那句「读不到」，
     * 报告那半块照旧。写入一律回绝——没有服务时没有任何东西可以接受它。
     */
    const UNSERVED = Object.freeze({
      getSnapshot: () => ({
        status: 'unavailable',
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

    /**
     * 一个模型此刻在表单里长什么样。
     *
     * 取的都是**生效值**，这样输入框里显示的永远是此刻真正在用的东西；提交时逐字段与这份
     * 快照比较，只有改动过的字段才会被发出去（没提到的字段保持原样，因此界面不编辑的
     * `reasoningEfforts` 之类不会被顺手抹掉）。
     *
     * @param {object} model - 报告里的一个模型。
     * @returns {object} 各字段的初值（都是草稿文本或布尔）。
     */
    function initialOf(model) {
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
     * 报告里的 `overrideKeys` 直接来自用户层，因此不必拿生效值和默认值比：比出来的答案既会漏
     * （写了与默认相同的值），也会多（schema 补出来的空值）。
     *
     * @param {object} model - 报告里的一个模型。
     * @param {string} key - 字段名。
     * @returns {boolean} 写过没有。
     */
    function declaredIn(model, key) {
      return (model.overrideKeys ?? []).includes(key);
    }

    /** 覆盖键在界面上的名字；界面不编辑的键（`reasoningEfforts`）另给一个词条。 */
    const OVERRIDE_NAMES = {
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
     * 配置页：实例（地址、同步开关）与模型清单、发现报告。
     *
     * 表单状态读注入面里的 `useApertureCard`（官方 SettingsFormModel 的投影），报告、提示语与
     * 每行的草稿是本组件的局部状态——它们是这一页的视图状态，不是设置文档的一部分。
     *
     * **effect 的依赖里刻意不放注入面**：`inject` 面由渲染器每次渲染重新组装，把它的身份放进
     * 依赖会让 effect 每渲染一次就重跑一次。因此报告用一个自增计数器当重读信号（依赖里只有
     * 那个数），注入面里的函数在事件处理里调用，拿到的永远是当轮的那份。
     *
     * @param {object} props - 注入面：`useApertureCard`、`panel`（报告端点）、`save` / `edit` /
     *   `resetField` / `discard` / `failed`（设置表单）与 `t`（字典，注册时声明了 `locale`）。
     * @returns {object} 页面元素。
     */
    function AperturePanel(props) {
      const t = typeof props.t === 'function' ? props.t : (key, params) => interpolate(zh[key] ?? key, params);
      const state = props.useApertureCard((snapshot) => snapshot);

      const [report, setReport] = React.useState(null);
      const [banner, setBanner] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [drafts, setDrafts] = React.useState({});
      const [opened, setOpened] = React.useState({});
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
      const run = (key, action, after) => {
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
       * 写入走官方表单模型的 `save()`：它自己带 `revision` 围栏（期间别处改过就拒绝，而不是覆盖
       * 别人的改动）、自己从宿主接受的那份重新播种，因此这里写完不重读设置——投影会自己变新。
       * 报告里的路由与模型事实来自最近一次刷新，写完必须等一轮：不等它，界面就会「保存了却没变」
       * （地址换了，模型清单还是旧的那份）。设置变更自己也会唤起同一轮刷新，运行时的单飞判定按
       * 配置版本合并，因此这里通常是并进那一轮，而不是另跑一轮。
       */
      const saveSettings = () => run('save', async () => {
        await props.save();
        if (props.failed()) return { ok: false, summary: t('configRefused') };
        const round = await props.panel.refresh();
        // 写入成功了，但重新发现可能失败——两件事不能混成一句话说，因此后半句照抄那一轮的说法。
        return { ok: round.ok, summary: t('savedResult', { result: round.summary }) };
      }, () => setRevision((value) => value + 1));

      /** 一个模型此刻的草稿；没改过就是生效值本身。 */
      const draftOf = (model) => drafts[model.id] ?? initialOf(model);

      /** 改这一行的几个字段；用函数式更新，同一个 tick 里连着改几项也不会互相覆盖。 */
      const stage = (model, changes) => {
        setDrafts((current) => ({
          ...current,
          [model.id]: { ...(current[model.id] ?? initialOf(model)), ...changes },
        }));
      };

      /**
       * 改动的字段 → 补丁；没变的不进补丁，非法值只报字段名。
       *
       * 补丁里的空值就是「这一项不覆盖」：文本字段用空串或 `null`（别名用空串），模态用 `null`，
       * 推理用 `null` 表示回落到发现。
       */
      const patchOf = (draft, initial) => {
        const patch = {};
        const bad = [];

        // 前后空白不算改动：只把 `  名字  ` 的空格去掉不算换过值，否则会凭空写下一笔覆盖。
        const name = draft.name.trim();
        if (name !== initial.name) patch.name = name === '' ? null : name;

        const alias = draft.alias.trim();
        if (alias !== initial.alias) patch.alias = alias;

        for (const [field, label] of [['contextWindow', 'editContextWindow'], ['maxTokens', 'editMaxTokens']]) {
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

        const wanted = [draft.text ? 'text' : undefined, draft.image ? 'image' : undefined].filter(Boolean);
        const before = [initial.text ? 'text' : undefined, initial.image ? 'image' : undefined].filter(Boolean);
        if (wanted.join('+') !== before.join('+')) patch.input = wanted.length === 0 ? null : wanted;

        return { patch, bad };
      };

      /**
       * 容量那一项的本地判定，输入框与保存走同一条规矩。
       *
       * 空串不是非法，是「这一项不覆盖」；其余必须是不小于 1 的整数——面板那一层只收这种值，
       * 放过去只会换来一次没必要的往返与一句后端的话。`1G`、`1.5`、`0` 都在这里被挡下。
       */
      const capacityBad = (text) => {
        const value = parseCapacity(text);
        return value !== undefined && (!Number.isInteger(value) || value < 1);
      };

      /** 这一行有没有还没写下去的改动。 */
      const dirtyOf = (model) => Object.keys(patchOf(draftOf(model), initialOf(model)).patch).length > 0;

      /** 丢掉一行的草稿：输入框回到生效值。 */
      const dropDraft = (id) => {
        setDrafts((current) => {
          const { [id]: _dropped, ...kept } = current;
          return kept;
        });
      };

      /** 展开或收起一行；收起不动草稿——收起来不等于放弃，标签会写着还有未保存的改动。 */
      const toggleRow = (model) => setOpened((current) => ({ ...current, [model.id]: current[model.id] !== true }));

      /**
       * 保存这一行的改动。
       *
       * 一行一个保存按钮，写下去的就只有这一行：多行同时开着也不会互相牵连，宿主那边的版本校验
       * 也只管这一次写入。成功后收起面板——这一行的覆盖标签与事实都会跟着变，收起才看得见。
       *
       * @param {object} model - 报告里的一个模型。
       */
      const submitRow = (model) => {
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
      const cancelRow = (model) => {
        dropDraft(model.id);
        setOpened((current) => ({ ...current, [model.id]: false }));
        setBanner(null);
      };

      /**
       * 撤销这一行的覆盖：只把**报告里写着确实被覆盖过**的字段清掉。
       *
       * 不是整条删掉：`aperture.models` 里那条可能还有界面根本不编辑的键（例如
       * `reasoningEfforts`），整条删掉等于把用户手写的东西一起扔掉。因此这里只把已知被覆盖的
       * 字段逐个置空——与保存走同一个端点，只是补丁全是「不覆盖」。万一报告的覆盖里出现了界面
       * 不认识的键（宿主以后加了字段），整条删掉是唯一能让这一行真的回落到发现值的做法。
       *
       * @param {object} model - 报告里的一个模型。
       */
      const clearOverrides = (model) => {
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
      const sourceOf = (fact) => t('factSource', {
        source: SOURCE_KEYS[fact] === undefined ? fact : t(SOURCE_KEYS[fact]),
      });

      /** 「标签 + 值」的一行；没有标签时就是一个整行的值（错误什么的）。 */
      const fact = (key, label, value) => h(
        'div',
        { className: 'dap-fact', key },
        label === null ? null : h('dt', null, label),
        h('dd', null, value),
      );

      /** 一个模型那几项生效的事实，摊成一行。 */
      const modelFacts = (model) => {
        const facts = [model.route === undefined ? t('unservedTag') : model.route];
        if (model.protocol !== undefined) facts.push(model.protocol);
        if (model.contextWindow !== undefined) {
          facts.push(t('factContextWindow', { count: formatCount(model.contextWindow) }));
        }
        if (model.maxTokens !== undefined) facts.push(t('factMaxTokens', { count: formatCount(model.maxTokens) }));
        facts.push(model.input.length === 0
          ? t('modalityNone')
          : model.input.map((item) => t(item === 'image' ? 'modalityImage' : 'modalityText')).join('+'));
        facts.push(model.reasoning ? t('reasoningOn') : t('reasoningOff'));
        if (model.alias !== undefined && model.alias !== '') facts.push(t('factAlias', { alias: model.alias }));
        return facts.join(' · ');
      };

      /** 把覆盖键翻成给人看的一句话：只挂一句「已覆盖」，用户得自己猜是哪一项。 */
      const overrideKeyNames = (model) => (model.overrideKeys ?? [])
        .map((key) => (OVERRIDE_NAMES[key] === undefined ? key : t(OVERRIDE_NAMES[key])))
        .join(t('listSeparator'));

      /**
       * 一个文本类覆盖字段。
       *
       * 官方 `SettingsValueField` 的语义与这里正好对得上：「已覆盖」= 用户层里有这个键（报告给的
       * `overrideKeys`），「恢复默认」= 把草稿改回「不覆盖」的那个值，非法草稿只标出来、由保存
       * 拦住。`hint` 里挂的是这一项事实的来源，所以输入框下面那句总是说得出「现在这个值是谁定的」。
       */
      const textField = (model, key, copy) => h(SettingsValueField, {
        id: `dap-${model.id}-${key}`,
        label: t(copy.label),
        hint: `${t(copy.hint)} ${sourceOf(copy.source(model))}`,
        ...(copy.placeholder === undefined ? {} : { placeholder: copy.placeholder(model) }),
        ...(copy.numeric === true ? { numeric: true } : {}),
        text: draftOf(model)[key],
        overridden: declaredIn(model, key),
        // 只有容量那两项用 `1M`/`384K` 的词汇，因此也只有它们会「读不出来」；文本字段写什么都算数。
        invalid: copy.numeric === true && capacityBad(draftOf(model)[key]),
        overriddenLabel: t('overridden'),
        resetLabel: t('resetField'),
        invalidLabel: t('invalidField'),
        disabled: busy !== '',
        onEdit: (text) => stage(model, { [key]: text }),
        onReset: () => stage(model, { [key]: copy.cleared }),
      });

      /** 一行模型的覆盖编辑器。 */
      const editor = (model) => {
        const draft = draftOf(model);
        const overriddenKeys = model.overrideKeys ?? [];
        return h(
          'div',
          { className: 'dap-editor' },
          h(
            'div',
            { className: 'dap-editorGrid' },
            textField(model, 'name', {
              label: 'editName',
              hint: 'editNameHint',
              source: (item) => item.provenance.name,
              cleared: '',
            }),
            textField(model, 'api', {
              label: 'editApi',
              hint: 'editApiHint',
              // 协议没有单独一项来源：写过就是配置，没写过就是从通告的端点推导出来的。
              source: (item) => (declaredIn(item, 'api') ? 'config' : 'aperture'),
              cleared: '',
              placeholder: (item) => item.protocol ?? '',
            }),
            textField(model, 'contextWindow', {
              label: 'editContextWindow',
              hint: 'editCapacityHint',
              source: (item) => item.provenance.limits,
              cleared: '',
              numeric: true,
            }),
            textField(model, 'maxTokens', {
              label: 'editMaxTokens',
              hint: 'editCapacityHint',
              source: (item) => item.provenance.limits,
              cleared: '',
              numeric: true,
            }),
            textField(model, 'alias', {
              label: 'editAlias',
              hint: 'editAliasHint',
              source: () => 'config',
              cleared: '',
            }),
          ),
          h(
            'div',
            { className: 'dap-inline' },
            h(
              'div',
              { className: 'dap-control' },
              h('span', { className: 'dap-controlLabel' }, t('editInput')),
              h(Checkbox, {
                checked: draft.text,
                onChange: (next) => stage(model, { text: next }),
                label: t('modalityText'),
                disabled: busy !== '',
              }),
              h(Checkbox, {
                checked: draft.image,
                onChange: (next) => stage(model, { image: next }),
                label: t('modalityImage'),
                disabled: busy !== '',
              }),
              overriddenKeys.includes('input')
                ? h('span', { className: 'dap-badges' }, h(Tag, { tone: 'info' }, t('overridden')))
                : null,
              h('span', { className: 'dap-hint' }, `${t('editInputHint')} ${sourceOf(model.provenance.input)}`),
            ),
            h(
              'div',
              { className: 'dap-control' },
              h('span', { className: 'dap-controlLabel' }, t('editReasoning')),
              h(SegmentedControl, {
                id: `dap-${model.id}-reasoning`,
                label: t('editReasoning'),
                value: draft.reasoning,
                options: [
                  { value: 'auto', label: t('reasoningFollow') },
                  { value: 'on', label: t('reasoningOn') },
                  { value: 'off', label: t('reasoningOff') },
                ],
                onChange: (next) => stage(model, { reasoning: next }),
                disabled: busy !== '',
              }),
              h(
                'span',
                { className: 'dap-hint' },
                `${t('editReasoningHint')} ${sourceOf(model.provenance.reasoning)}`,
              ),
            ),
          ),
          model.endpoints.length === 0
            ? null
            : h(
                'p',
                { className: 'dap-mono' },
                `${t('factEndpoints')}\n${model.endpoints.join('\n')}`,
              ),
          h(
            'div',
            { className: 'dap-actions' },
            h(Button, {
              variant: 'primary',
              size: 'sm',
              onClick: () => submitRow(model),
              disabled: busy !== '',
            }, busy === 'edit' ? t('saving') : t('saveRow')),
            overriddenKeys.length === 0
              ? null
              : h(Button, {
                  variant: 'outline',
                  size: 'sm',
                  onClick: () => clearOverrides(model),
                  disabled: busy !== '',
                }, t('clearOverrides')),
            h(Button, {
              variant: 'ghost',
              size: 'sm',
              onClick: () => cancelRow(model),
              disabled: busy !== '',
            }, t('cancelRow')),
          ),
        );
      };

      /** 一行模型：折起来是事实，展开是覆盖编辑器。 */
      const modelRow = (model) => h(
        'li',
        { key: model.id, className: 'dap-row' },
        h(
          DisclosureRow,
          {
            icon: h(StateDot, { state: model.route === undefined ? 'warning' : 'idle', size: 16 }),
            title: model.name,
            open: opened[model.id] === true,
            expandable: true,
            expandOnRowClick: true,
            onToggle: () => toggleRow(model),
            collapsedContent: h(
              'div',
              { className: 'dap-rowFacts' },
              h('span', null, modelFacts(model)),
              (model.overrideKeys ?? []).length === 0
                ? null
                : h(Tag, { tone: 'info' }, t('overriddenKeys', { keys: overrideKeyNames(model) })),
              dirtyOf(model) ? h(Tag, { tone: 'warning' }, t('dirtyTag')) : null,
            ),
          },
          opened[model.id] === true ? editor(model) : null,
        ),
      );

      /** 已发布路由：写入与否来自最近一次刷新的写入结果。 */
      const writtenRoutes = report === null || report.refresh === undefined || report.refresh.sync === undefined
        ? undefined
        : report.refresh.sync.routes;

      const routeRow = (route) => h(
        'li',
        { key: route.provider, className: 'dap-route' },
        h(
          'div',
          { className: 'dap-routeHead' },
          h('span', null, route.provider),
          route.api === undefined ? null : h(Tag, { tone: 'outline' }, route.api),
          h(Tag, { tone: 'quiet' }, t('routeModels', { count: route.models })),
          writtenRoutes === undefined
            ? null
            : h(Tag, { tone: writtenRoutes.includes(route.provider) ? 'success' : 'neutral' }, t(
              writtenRoutes.includes(route.provider) ? 'routePublished' : 'routeNotPublished',
            )),
        ),
        h('p', { className: 'dap-mono' }, route.baseURL ?? t('routeNoBaseUrl')),
      );

      /** 最近一次刷新决定了什么。 */
      const reportFacts = (current) => {
        const refresh = current.refresh;
        if (refresh === undefined) return h('p', { className: 'dap-hint' }, t('neverRefreshed'));
        return h(
          'dl',
          { className: 'dap-facts' },
          fact('trigger', t('factTrigger'), refresh.trigger),
          fact('time', t('factTime'), formatTime(refresh.at)),
          fact('duration', t('factDuration'), `${refresh.durationMs}ms`),
          fact('result', t('factResult'), refresh.ok ? t('refreshOk') : t('refreshFailed')),
          refresh.error === undefined ? null : fact('error', null, refresh.error),
          fact(
            'catalog',
            t('factCatalog'),
            refresh.catalog.available
              ? t('catalogEntries', { count: formatCount(refresh.catalog.entries) })
              : t('catalogUnavailable', { reason: refresh.catalog.reason ?? '—' }),
          ),
          refresh.endpoint === undefined
            ? null
            : fact('endpoint', t('factEndpoint'), t('endpointListed', {
              url: refresh.endpoint.url,
              count: refresh.endpoint.listed,
            })),
          refresh.sync === undefined
            ? null
            : fact('sync', t('factSync'), refresh.sync.applied
              ? t('syncApplied', {
                count: refresh.sync.ops,
                routes: refresh.sync.routes.join(t('listSeparator')) || t('syncOnlyRemoval'),
              })
              : t('syncSkipped', { reason: refresh.sync.reason ?? '—' })),
        );
      };

      const controlsDisabled = !state.available || !state.writable;

      return h(
        'div',
        { 'data-dsh-aperture': '' },
        h(
          SettingsForm,
          {
            labels: {
              unavailable: t('unavailable'),
              readOnly: t('readOnly'),
              saveFailed: t('saveFailed'),
              save: t('save'),
              saving: t('saving'),
            },
            state,
            onSave: saveSettings,
            onDiscard: props.discard,
          },
          h(SettingsValueField, {
            id: 'dap-base-url',
            label: t('addressLabel'),
            hint: t('addressHint'),
            placeholder: t('addressPlaceholder'),
            text: state.baseUrl.text,
            overridden: state.baseUrl.overridden,
            invalid: state.baseUrl.invalid,
            overriddenLabel: t('overridden'),
            resetLabel: t('resetField'),
            invalidLabel: t('invalidField'),
            disabled: controlsDisabled || state.saving,
            onEdit: (text) => props.edit('baseUrl', text),
            onReset: () => props.resetField('baseUrl'),
          }),
          h(
            'div',
            { className: 'dap-toggleRow' },
            h(
              'div',
              { className: 'dap-toggleText' },
              h('span', null, t('syncLabel')),
              h('span', { className: 'dap-hint' }, t('syncHint')),
            ),
            h(
              'div',
              { className: 'dap-inline' },
              state.sync.overridden
                ? h(Tag, { tone: 'info' }, t('overridden'))
                : null,
              state.sync.overridden
                ? h(Button, {
                    variant: 'ghost',
                    size: 'sm',
                    onClick: () => props.resetField('sync'),
                    disabled: controlsDisabled || state.saving,
                  }, t('resetField'))
                : null,
              h(Switch, {
                checked: state.sync.text === 'true',
                onChange: (next) => props.edit('sync', next ? 'true' : 'false'),
                label: t('syncLabel'),
                disabled: controlsDisabled || state.saving,
              }),
            ),
          ),
        ),
        banner === null
          ? null
          : h('p', {
              className: 'dap-banner',
              'data-ok': banner.ok ? 'true' : 'false',
              role: 'status',
              'aria-live': 'polite',
            }, banner.text),
        h(
          'section',
          { className: 'dap-group' },
          h(
            'div',
            { className: 'dap-groupHead' },
            h('h3', { className: 'dap-groupTitle' }, t('modelsTitle')),
            h(Button, {
              variant: 'ghost',
              size: 'sm',
              onClick: refreshReport,
              disabled: busy !== '',
              title: t('refreshHint'),
            }, busy === 'refresh' ? t('refreshing') : t('refresh')),
          ),
          h('p', { className: 'dap-hint' }, t('modelsHint')),
          report === null
            ? h('p', { className: 'dap-hint' }, t('loading'))
            : report.models.length === 0
              ? h('p', { className: 'dap-hint' }, t('noModels'))
              : h('ul', { className: 'dap-rows' }, report.models.map(modelRow)),
        ),
        h(
          'section',
          { className: 'dap-group' },
          h('h3', { className: 'dap-groupTitle' }, t('reportTitle')),
          report !== null && report.place.length === 0
            ? h('p', { className: 'dap-hint' }, t('dormantHint'))
            : null,
          report === null
            ? h('p', { className: 'dap-hint' }, t('loading'))
            : h(
                'div',
                { className: 'dap-group' },
                h('h4', { className: 'dap-groupTitle' }, t('routesTitle')),
                report.routes.length === 0
                  ? h('p', { className: 'dap-hint' }, t('noRoutes'))
                  : h('ul', { className: 'dap-routes' }, report.routes.map(routeRow)),
              ),
          report === null ? null : reportFacts(report),
          h('p', { className: 'dap-hint' }, t('reportHint')),
        ),
      );
    }

    // ---------------------------------------------------------------- 插件本体

    /**
     * 把 `aperturePanel` 贡献挂到客户端的 Remote 服务上。
     *
     * `apply` 必须保持同步：宿主 Cordis 会卸载 async apply 里 `await` 之后注册的
     * `ctx.effect`。因此异步的 `$mount` 在一个**同步注册**的 effect 工厂内部完成，失败
     * 落 console.error。
     *
     * @param {object} ctx - 客户端根上下文。
     */
    function mountRemote(ctx) {
      ctx.effect(() => {
        let mounted = null;
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
     * `ctx.slots.inject` 是必需的，不是可选的：`plugins.bundle.config` 由插件管理页自己声明，
     * 那个声明完全可能在本插件 `apply` 之后才发生，直接 register 会撞上「槽位尚未声明」。
     *
     * 注册的键是**包名**：键控槽位按它找贡献，点开插件列表里的本插件就是这一页。设置那一份表单
     * 也在这里取——页主只递 `view`，`configForms.get(命名空间)` 才是这一页的配置读写面；服务
     * 按命名空间缓存控制器，因此它与插件页自己取到的是同一份。
     *
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-aperture: dictionaries');
      ctx.effect(() => installStyles(), 'dsh-aperture: stylesheet');
      mountRemote(ctx);

      ctx.inject(['remote.aperturePanel'], (scope) => {
        const t = scope.locale.bind(NS);
        const namespace = () => scope.remote.aperturePanel;
        const panel = {
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

    const module = { exports: {} };
    module.exports.name = PACKAGE;
    /** 本插件依赖的客户端服务：槽位、字典、Remote 调用面，以及设置接缝的配置表单。 */
    module.exports.inject = ['slots', 'locale', 'remote', 'configForms'];
    module.exports.apply = apply;
    /** 字典命名空间（测试与排查用）。 */
    module.exports.NS = NS;
    /** 设置命名空间，也是包级配置页这一份表单的键（测试与排查用）。 */
    module.exports.SETTINGS_NS = SETTINGS_NS;
    /** 这一页自己编辑的字段（测试与排查用）。 */
    module.exports.FIELDS = FIELDS;
    /** 上报给 Remote 注册表的贡献（测试与排查用）。 */
    module.exports.REMOTE = REMOTE;
    return module.exports;
  },
});
