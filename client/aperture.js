/**
 * `dsh-aperture` 浏览器半边：**设置 → 插件 → Aperture** 标签页。
 *
 * 扩展点与接线方式对齐参考实现 `@xiaoyuyu6420/dsh-backup`（`backupPanel` + 插件标签页）：
 *
 * - 用 `settings.plugins.tab` 注册一个**列表槽位**标签页，而不是往「插件配置」里塞卡片；
 * - 注入面只有 `slots` / `locale` / `remote` 三个服务，**不注入设置传输**——配置读写与
 *   发现结果一样，都经自己的 `aperturePanel` Remote 命名空间往返，标签页因此不关心设置
 *   文档长什么样；
 * - 标签页只拿两个 prop：`panel`（端点集合）与 `t`（字典，因为注册时声明了 `locale`）。
 *
 * **这个文件就是构建产物。** DSH 的客户端模块系统只要求一个经典脚本，用
 * `window.__ModuleLoader__.load({ id, factory })` 的握手把自己报上去；它不要求这份脚本
 * 经过打包器，也不检查它是否被压缩过。因此这里直接写 CJS 工厂体，用 `createElement`
 * 而不是 JSX：仓库不必为此引入打包器，也不必把一个编译产物提交进版本库。
 *
 * 运行时只 `require('react')`（DSH 平台基线模块），不需要 `dsh.client.external`。
 *
 * @module dsh-aperture/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-aperture',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    /** 字典命名空间（本插件拥有）。标签页的 `locale` 声明与 `ctx.locale.bind` 都用它。 */
    const NS = 'settings.aperturePanel';
    /** 宿主半边的 Remote 命名空间（`src/remote.ts`）。 */
    const PANEL = 'aperturePanel';
    /** 包名，取自 package.json，同时是端点 id 的前缀。 */
    const PACKAGE = 'dsh-aperture';
    /** 样式表归属标记；卸载与热替换时按它回收。 */
    const STYLE_MARK = 'data-dsh-aperture';

    // ---------------------------------------------------------------- 端点契约

    /**
     * 一个 strict 结果编解码器。
     *
     * 浏览器半边挂载贡献时强制要求每个参数与结果的编解码器都是 `strict`、带非空类型符号
     * 与可用的 `parse`。生成器会塞进 zod schema；本插件的形状很小，手写校验就够了——手写
     * 反而能在宿主与界面漂移时报出具体字段名（`…status.models[3].contextWindow：期望 number`）。
     *
     * 字段类型是一行小文法：
     * - `'string'` / `'number'` / `'boolean'`：基本类型；
     * - 末尾 `?`：可省略（宿主没给这个字段）；
     * - 末尾 `|null`：允许 `null`（参数里表示「撤销这一条覆盖」）；
     * - 末尾 `[]`：数组；
     * - 直接给另一个 codec：嵌套对象；`opt(...)` 表示它可省略；`list(...)` 表示对象数组。
     *
     * @param {string} typeSymbol - 类型符号，注册表要求非空。
     * @param {Record<string, string|object>} fields - 字段与类型。
     * @returns {object} 编解码器。
     */
    function codec(typeSymbol, fields) {
      return Object.freeze({
        mode: 'strict',
        typeSymbol,
        schema: {
          parse(value, at) {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) {
              throw new TypeError(`${at ?? typeSymbol}：期望一个对象`);
            }
            const parsed = {};
            for (const [name, kind] of Object.entries(fields)) {
              // 嵌套时报错带完整路径（`…status.models[0].contextWindow`）；顶层就是类型符号。
              const path = at === undefined ? `${typeSymbol}.${name}` : `${at}.${name}`;
              const field = value[name];
              if (field === undefined) {
                if (isOptional(kind)) continue;
                throw new TypeError(`${path}：缺字段`);
              }
              parsed[name] = parseKind(path, kind, field);
            }
            return parsed;
          },
        },
      });
    }

    /** 一个字段是否可省略。 */
    function isOptional(kind) {
      return typeof kind === 'string' ? kind.endsWith('?') : kind.optional === true;
    }

    /** 可省略的嵌套对象字段。 */
    function opt(inner) {
      return Object.freeze({ codec: inner, optional: true });
    }

    /** 由另一个 codec 描述的对象数组字段。 */
    function list(inner) {
      return Object.freeze({ list: inner });
    }

    /** 允许 `null` 的嵌套字段（`null` 与「缺字段」是两件事，因此不能靠 `?`）。 */
    function nullable(inner) {
      return Object.freeze({ nullable: inner });
    }

    /**
     * 按类型说明校验一个值。
     *
     * @param {string} path - 出错信息里的字段路径。
     * @param {string|object} kind - 类型说明。
     * @param {*} value - 待校验的值。
     * @returns {*} 校验过的值。
     */
    function parseKind(path, kind, value) {
      if (typeof kind === 'object' && kind !== null) {
        if (kind.list !== undefined) {
          if (!Array.isArray(value)) throw new TypeError(`${path}：期望数组`);
          return value.map((item, index) => parseKind(`${path}[${index}]`, kind.list, item));
        }
        if (kind.codec !== undefined) return kind.codec.schema.parse(value, path);
        if (kind.nullable !== undefined) {
          return value === null ? null : parseKind(path, kind.nullable, value);
        }
        // 直接给了另一个 codec，就是「这里是它描述的那个嵌套对象」。
        if (typeof kind.schema?.parse === 'function') return kind.schema.parse(value, path);
        throw new TypeError(`${path}：类型说明写错了`);
      }

      let spec = kind;
      if (spec.endsWith('?')) spec = spec.slice(0, -1);
      const nullable = spec.endsWith('|null');
      if (nullable) spec = spec.slice(0, -'|null'.length);
      const items = spec.endsWith('[]');
      const type = items ? spec.slice(0, -2) : spec;

      if (value === null) {
        if (nullable) return null;
        throw new TypeError(`${path}：期望 ${type}，收到 null`);
      }
      if (items) {
        if (!Array.isArray(value)) throw new TypeError(`${path}：期望数组`);
        return value.map((item, index) => {
          if (typeof item !== type) {
            throw new TypeError(`${path}[${index}]：期望 ${type}，收到 ${typeof item}`);
          }
          return item;
        });
      }
      if (typeof value !== type) throw new TypeError(`${path}：期望 ${type}，收到 ${typeof value}`);
      return value;
    }

    /** 一个**可省略**的参数编解码器。
     *
     * `acceptsUndefined` 与「可省略」是一回事：`save` 的调用方常常只想改其中一个字段，没提到的
     * 那个必须原样传过去。类型说明与 {@link param} 共用一套文法，因为这里要同时容下两种「空」：
     * 省略是「不碰」，`null` 是「恢复默认」——两者都过得了校验，而且意思完全不同。
     *
     * @param {string} typeSymbol - 类型符号。
     * @param {string|object} kind - 类型说明。
     * @returns {object} 参数编解码器。
     */
    function optionalParam(typeSymbol, kind) {
      return Object.freeze({
        mode: 'strict',
        typeSymbol,
        acceptsUndefined: true,
        schema: {
          parse(value) {
            if (value === undefined) return undefined;
            return parseKind(typeSymbol, kind, value);
          },
        },
      });
    }

    /**
     * 一个参数编解码器。
     *
     * 类型说明用与字段同一套文法（数组、嵌套对象、`null` 都在其中），因此参数与结果只有一份规则。
     * 可省略表示「这一项不碰」：省略编号会让同一个端点少传一个参数，而不是传一个空值。
     *
     * @param {string} typeSymbol - 类型符号。
     * @param {string|object} kind - 类型说明。
     * @returns {object} 参数编解码器。
     */
    function param(typeSymbol, kind) {
      return Object.freeze({
        mode: 'strict',
        typeSymbol,
        schema: {
          parse(value) {
            if (value === undefined) return undefined;
            return parseKind(typeSymbol, kind, value);
          },
        },
      });
    }

    /** 动作结果。 */
    const ACTION = codec(`${PACKAGE}/types#action`, { ok: 'boolean', summary: 'string' });
    /** 表单要显示的配置。 */
    const CONFIGURATION = codec(`${PACKAGE}/types#configuration`, {
      baseUrl: 'string',
      sync: 'boolean',
      baseUrlOverridden: 'boolean',
      syncOverridden: 'boolean',
      writable: 'boolean',
    });

    /** 一个模型的覆盖（`aperture.models` 里那一条）。 */
    const OVERRIDE = codec(`${PACKAGE}/types#modelOverride`, {
      name: 'string?',
      api: 'string?',
      contextWindow: 'number?',
      maxTokens: 'number?',
      input: 'string[]?',
      thinking: 'boolean?',
    });

    /** 一条事实的来源；未知来源原样显示。 */
    const PROVENANCE = codec(`${PACKAGE}/types#provenance`, {
      limits: 'string',
      reasoning: 'string',
      input: 'string',
      name: 'string',
    });

    /** 报告里的一个模型。 */
    const MODEL = codec(`${PACKAGE}/types#model`, {
      id: 'string',
      name: 'string',
      route: 'string?',
      protocol: 'string?',
      endpoints: 'string[]',
      contextWindow: 'number?',
      maxTokens: 'number?',
      input: 'string[]',
      reasoning: 'boolean',
      provenance: PROVENANCE,
      override: opt(OVERRIDE),
      alias: 'string?',
    });

    /** 报告里的一条路由。 */
    const ROUTE = codec(`${PACKAGE}/types#route`, {
      provider: 'string',
      api: 'string?',
      baseURL: 'string?',
      models: 'number',
    });

    /** 最近一次刷新的状态。 */
    const REFRESH = codec(`${PACKAGE}/types#refresh`, {
      trigger: 'string',
      at: 'string',
      durationMs: 'number',
      ok: 'boolean',
      error: 'string?',
      catalog: codec(`${PACKAGE}/types#catalog`, {
        available: 'boolean',
        entries: 'number',
        reason: 'string?',
      }),
      endpoint: opt(codec(`${PACKAGE}/types#endpoint`, { url: 'string', listed: 'number' })),
      sync: opt(codec(`${PACKAGE}/types#sync`, {
        applied: 'boolean',
        ops: 'number',
        routes: 'string[]',
        reason: 'string?',
      })),
    });

    /** 标签页要显示的整份报告。 */
    const STATUS = codec(`${PACKAGE}/types#status`, {
      place: 'string',
      refresh: opt(REFRESH),
      routes: list(ROUTE),
      models: list(MODEL),
    });

    /**
     * `edit` 的补丁：只带界面改动过的字段，缺字段表示不碰，`null` 表示这一条覆盖不要了。
     */
    const PATCH = codec(`${PACKAGE}/types#modelPatch`, {
      name: 'string|null?',
      api: 'string|null?',
      contextWindow: 'number|null?',
      maxTokens: 'number|null?',
      input: 'string[]|null?',
      thinking: 'boolean|null?',
      alias: 'string|null?',
    });

    /**
     * 一个端点的浏览器侧调用描述符。
     *
     * `acceptsUndefined` 由参数自己的编解码器决定，而不是一律为真：只有「可省略」的参数
     * （`save` 的地址与开关，没提到就原样不碰）才接受 `undefined`。`edit` 的补丁必须显式给出，
     * 因为 `null` 是有含义的（撤销覆盖），缺省不能顺便也当成撤销。
     *
     * @param {string} method - 端点方法名（也是宿主服务上的方法名）。
     * @param {Array} parameters - `[参数名, 编解码器]` 对，顺序与宿主方法一致。
     * @param {object} result - 结果编解码器。
     * @returns {object} 描述符。
     */
    function descriptor(method, parameters, result) {
      return Object.freeze({
        id: `${PACKAGE}#${PANEL}/${method}`,
        service: PANEL,
        namespace: PANEL,
        method,
        invocation: Object.freeze({ kind: 'direct' }),
        parameters: Object.freeze(parameters.map(([name, param]) => Object.freeze({
          name,
          wire: name,
          source: 'json',
          codec: param,
          acceptsUndefined: param.acceptsUndefined === true,
        }))),
        result,
      });
    }

    /**
     * 与宿主半边 `PANEL_INVOCATIONS` 一一对应的贡献。
     *
     * 端点名不能与命名空间服务自己的成员重名：api-gateway 为每个命名空间建一个
     * `RemoteNamespaceService`，端点会成为它的属性，撞上 `remove` / `has` / `install` /
     * `name` / `ctx` 这类预置名字时 `validateContribution` 会拒绝**整份**贡献，界面因此
     * 安静地什么都不出现。「撤下路由」叫 `withdraw` 就是这个原因。
     */
    const REMOTE = Object.freeze({
      package: PACKAGE,
      descriptors: Object.freeze([
        descriptor('status', [], STATUS),
        descriptor('refresh', [], ACTION),
        descriptor('withdraw', [], ACTION),
        descriptor('configuration', [], CONFIGURATION),
        descriptor('save', [
          ['baseUrl', optionalParam(`${PACKAGE}/types#baseUrl`, 'string|null')],
          ['sync', optionalParam(`${PACKAGE}/types#sync`, 'boolean|null')],
        ], ACTION),
        descriptor('edit', [
          ['id', param(`${PACKAGE}/types#modelId`, 'string')],
          ['patch', param(`${PACKAGE}/types#modelPatch`, nullable(PATCH))],
        ], ACTION),
      ]),
    });

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
     * 注入标签页样式。
     *
     * 标签页在独立 bundle 里，用不了仓库的 CSS module 管线，因此样式随包分发、按 effect
     * 生命周期注入，并在卸载时移除。选择器全部收在 `[data-dsh-aperture]` 之下；颜色只引用
     * dsh web 的主题 token（`--dsw-alias-*`，各带回落值），深浅色自动跟随。
     *
     * 尺寸与形状照抄官方设置页的「模型」卡片（`@deepseek-ai/dsh-client-ui-settings-models`）：
     * 卡片是 16px 圆角、`.5px` 的 l4 边框、`12px 14px` 内边距，卡头左身份右动作（`10px` 间距
     * 加 `margin-left: auto`），身份里的状态点是 8px 的 state token 圆点；编辑区是 12px 圆角的
     * 浅色面（`bg-module-platform`，`14px 16px` 内边距），参数排成 `minmax(160px, 1fr)` 的栅格，
     * 字段标签 12px/500 的 label-secondary，行内动作按钮 28px / 14px 圆角，正文按钮 36px 胶囊，
     * 编辑区底部的「取消 / 保存」右对齐。那份 CSS 是构建产物里的字面量，可以逐条对照，因此界面
     * 不必赌一个没有类型声明的组件 API 也能与官方标签页长得一样。
     *
     * @returns {Function} 卸载时移除样式表的 disposer。
     */
    function installStyles() {
      if (document.querySelector(`style[${STYLE_MARK}]`) !== null) return () => {};
      const element = document.createElement('style');
      element.setAttribute(STYLE_MARK, '');
      element.textContent = `
[${STYLE_MARK}] { display: flex; flex-direction: column; gap: 12px; max-width: 720px; min-width: 0; color: var(--dsw-alias-label-primary, inherit); }
[${STYLE_MARK}] .dap-title { font-size: 16px; font-weight: 500; line-height: 24px; }
[${STYLE_MARK}] .dap-subtitle { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
/* 卡片就是官方「模型」页的一张 rowCard：16px 圆角、.5px 的 l4 边框、12px 14px 内边距、
   12px 的列间距，底下**不铺色**——官方那张卡也是透明的，底来自页面本身。段卡（实例、刷新）
   与路由卡在页面上是同一层，共用这条规则；模型行是路由编辑区**里面**的一层，用官方
   modelEntry 的细框（10px 圆角、10px 12px 内边距），一眼看得出谁在谁里面。 */
[${STYLE_MARK}] .dap-section, [${STYLE_MARK}] .dap-route { display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; border: .5px solid var(--dsw-alias-border-l4, rgba(127,127,127,.3)); border-radius: 16px; }
/* 卡头：左边是身份（名字 + 标签 + 状态点），右边是这一张卡自己的动作——官方 rowHead。 */
[${STYLE_MARK}] .dap-card-head { display: flex; align-items: center; gap: 10px; }
[${STYLE_MARK}] .dap-identity { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
/* 段卡的卡头本身是个折叠开关：箭头 + 身份，形状照官方那个分组头（groupToggle 里放箭头与
   标题，右边的控件留在按钮外面）。动作留在按钮**外面**——按钮里不能再嵌按钮。 */
[${STYLE_MARK}] .dap-card-toggle { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
[${STYLE_MARK}] .dap-card-toggle:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe); outline-offset: 2px; border-radius: 6px; }
[${STYLE_MARK}] .dap-card-toggle .dap-chevron { color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
/* 折起来的那一半：刷新卡的事实与地址，实例卡的编辑区。 */
[${STYLE_MARK}] .dap-body { display: flex; flex-direction: column; gap: 12px; }
[${STYLE_MARK}] .dap-name { font-size: 14px; font-weight: 500; line-height: 22px; }
[${STYLE_MARK}] .dap-row-actions { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
[${STYLE_MARK}] .dap-row-actions .dap-button { height: 28px; padding: 0 10px; border-radius: 14px; font-size: 12px; line-height: 18px; }
/* 状态点：官方拿它说「这个提供方的凭据配好了没有」——8px 的圆、state token 上色。这里
   沿用同一个记号，语义换成「地址填了没有」（实例卡）、「最近一次刷新成不成功」（刷新卡）
   与「有没有路由把它服务出去」（模型卡）。颜色不是唯一的说法：title 与 aria-label 里写着
   同一句话。 */
[${STYLE_MARK}] .dap-dot { box-sizing: border-box; display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; }
[${STYLE_MARK}] .dap-dot[data-state="ok"] { background: var(--dsw-alias-state-success-primary, #2e9e5b); }
[${STYLE_MARK}] .dap-dot[data-state="bad"] { background: var(--dsw-alias-state-error-primary, #d9534f); }
[${STYLE_MARK}] .dap-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
[${STYLE_MARK}] .dap-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }

/* 输入控件照抄官方：32px 高、8px 圆角、.5px 的 l4 边框、bg-layer-1 底、聚焦只换边框色。
   select 的箭头是官方那段内联 SVG（颜色写死，深浅色下都够用）。 */
[${STYLE_MARK}] .dap-input { box-sizing: border-box; width: 100%; min-width: 0; height: 32px; font: inherit; font-size: 14px; line-height: 22px; padding: 0 10px; border: .5px solid var(--dsw-alias-border-l4, rgba(127,127,127,.4)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary, inherit); }
[${STYLE_MARK}] .dap-input:focus { border-color: var(--dsw-alias-brand-primary, rgba(127,127,127,.6)); outline: none; }
[${STYLE_MARK}] .dap-input::placeholder { color: var(--dsw-alias-label-dimmed, rgba(127,127,127,.6)); }
[${STYLE_MARK}] .dap-input:disabled { opacity: .6; cursor: default; }
[${STYLE_MARK}] select.dap-input { max-width: 240px; cursor: pointer; appearance: none; padding-right: 32px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-position: right 12px center; background-repeat: no-repeat; background-size: 12px 12px; }

[${STYLE_MARK}] .dap-tag { flex: none; padding: 1px 6px; border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.4)); border-radius: 4px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary, inherit); }
[${STYLE_MARK}] .dap-check { display: inline-flex; gap: 6px; align-items: center; font-size: 14px; line-height: 22px; }
[${STYLE_MARK}] .dap-check > input { accent-color: var(--dsw-alias-brand-primary, rgba(127,127,127,.6)); }
[${STYLE_MARK}] .dap-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
[${STYLE_MARK}] .dap-actions[data-align="end"] { justify-content: flex-end; }
[${STYLE_MARK}] .dap-button { box-sizing: border-box; display: inline-flex; justify-content: center; align-items: center; gap: 4px; height: 36px; padding: 0 14px; border: none; border-radius: 18px; background: none; color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer; }
[${STYLE_MARK}] .dap-button:not([data-primary="true"]) { border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.4)); }
[${STYLE_MARK}] .dap-button:not([data-primary="true"]):hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))); }
[${STYLE_MARK}] .dap-button[data-danger="true"] { border: none; color: var(--dsw-alias-state-error-primary, #d9534f); }
[${STYLE_MARK}] .dap-button[data-danger="true"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(217,83,79,.12)); }
[${STYLE_MARK}] .dap-button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3, rgba(127,127,127,.4)); }
/* 主按钮的底色与文字是一对 token，不能只换底色。--dsw-alias-brand-primary 在浅色主题里是
   近黑、在深色主题里是近白，而继承来的正文色恰好与它同色——只写 background 就是「深底深字」。
   --dsw-alias-label-primary-foreground 就是为这种底色准备的对比色。禁用态用主题自己的
   dimmed 填充 + label-secondary：官方的整颗 opacity: .4 会把底色与文字一起压向页面底色，
   两个都变浅之后反而谁也看不清（浅色主题下大约 1.4:1）。 */
[${STYLE_MARK}] .dap-button[data-primary="true"] { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, rgba(127,127,127,.5))); color: var(--dsw-alias-label-primary-foreground, #fff); }
[${STYLE_MARK}] .dap-button[data-primary="true"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, rgba(127,127,127,.5))); }
[${STYLE_MARK}] .dap-button[data-primary="true"]:disabled { opacity: 1; background: var(--dsw-alias-button-primary-dimmed, rgba(127,127,127,.18)); color: var(--dsw-alias-label-secondary, rgba(127,127,127,.9)); }
[${STYLE_MARK}] .dap-button:disabled { cursor: default; }
/* 官方每一颗按钮的禁用态都是整颗 opacity: .4；主按钮那一处例外与理由写在上面。 */
[${STYLE_MARK}] .dap-button:not([data-primary="true"]):disabled { opacity: .4; }

[${STYLE_MARK}] .dap-banner { margin: 0; font-size: 12px; line-height: 18px; white-space: pre-wrap; }
[${STYLE_MARK}] .dap-banner[data-ok="false"] { color: var(--dsw-alias-state-error-primary, #d9534f); }
[${STYLE_MARK}] .dap-banner[data-ok="true"] { color: var(--dsw-alias-state-success-primary, inherit); }
/* 状态段是一串「标签 + 值」，不用表格：值本身可能是地址或一列路由名，会很长。 */
[${STYLE_MARK}] .dap-facts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
[${STYLE_MARK}] .dap-fact { display: flex; gap: 12px; padding: 5px 0; border-top: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18)); }
[${STYLE_MARK}] .dap-fact:first-child { border-top: none; padding-top: 0; }
[${STYLE_MARK}] .dap-fact > dt { flex: 0 0 84px; font-size: 12px; line-height: 22px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
[${STYLE_MARK}] .dap-fact > dd { margin: 0; min-width: 0; font-size: 14px; line-height: 22px; word-break: break-word; }

[${STYLE_MARK}] .dap-models { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
[${STYLE_MARK}] .dap-model { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: .5px solid var(--dsw-alias-border-l4, rgba(127,127,127,.3)); border-radius: 10px; }
[${STYLE_MARK}] .dap-model-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
/* 卡头是「id + 显示名」——官方 modelCatalog 那一行也是 id 在前、名字在后。 */
[${STYLE_MARK}] .dap-model-id { font-family: var(--ds-font-family-code, monospace); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
[${STYLE_MARK}] .dap-model-facts { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, inherit); }
[${STYLE_MARK}] .dap-model-meta { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
/* 模型行自己展开的参数面不再另铺一层灰：它已经在编辑区那块浅色面里了，官方 modelAdvanced
   也是在同底色上切一条 l2 细线——再套一层灰，边界根本看不见。 */
[${STYLE_MARK}] .dap-advanced { display: flex; flex-direction: column; gap: 12px; padding-top: 12px; border-top: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18)); }

/* 编辑区与官方一样是卡片里的一块浅色面：12px 圆角、14px 16px 内边距。路由卡展开后，这块面
   里装的正是官方那张 provider 卡的两层：先是「→ 地址」那一行（对应官方编辑区头上的名字与
   provider id），再是模型清单（官方 modelCatalog）。 */
[${STYLE_MARK}] .dap-editor { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px; border-radius: 12px; background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1, transparent)); }
[${STYLE_MARK}] .dap-editor-head { display: flex; gap: 8px; align-items: baseline; }
[${STYLE_MARK}] .dap-editor-title { font-size: 14px; font-weight: 500; line-height: 22px; }
[${STYLE_MARK}] .dap-editor-route { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
[${STYLE_MARK}] .dap-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
[${STYLE_MARK}] .dap-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
[${STYLE_MARK}] .dap-field > label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
/* 「已覆盖」那对记号跟着它描述的那个字段：官方 ValueField 的 head/badges 就是这个位置。
   搁在卡头上时它是一句没有主语的「已覆盖」，离要撤销的那一项越远越像在说别的东西。 */
[${STYLE_MARK}] .dap-field-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
[${STYLE_MARK}] .dap-field-badges { display: inline-flex; align-items: center; gap: 8px; }
/* 「恢复默认」是官方那个纯文字按钮：12px、label-secondary、没有边框也没有底色。 */
[${STYLE_MARK}] .dap-reset { padding: 0; border: 0; background: none; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer; }
[${STYLE_MARK}] .dap-reset:disabled { cursor: default; color: var(--dsw-alias-label-dimmed, rgba(127,127,127,.6)); }
/* 编辑区里的字段是官方 fieldLabel（12px/500 的 label-secondary），模型那一格沿用官方
   modelFieldLabel 的 12px label-tertiary；整行的格子（地址、密钥那种值）横跨整个栅格。 */
[${STYLE_MARK}] .dap-field[data-emphasis="true"] > label, [${STYLE_MARK}] .dap-field[data-emphasis="true"] .dap-field-head > label { display: inline-flex; align-items: center; gap: 10px; font-weight: 500; color: var(--dsw-alias-label-secondary, inherit); }
[${STYLE_MARK}] .dap-field[data-wide="true"] { grid-column: 1 / -1; }
[${STYLE_MARK}] .dap-field-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
[${STYLE_MARK}] .dap-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary, #d9534f); }
[${STYLE_MARK}] .dap-chevron { display: inline-flex; transition: transform 120ms ease; }
[${STYLE_MARK}] .dap-chevron[data-open="true"] { transform: rotate(90deg); }
`;
      document.head.append(element);
      return () => element.remove();
    }

    // -------------------------------------------------------------------- 字典

    /**
     * 中英文字典。
     *
     * 注册时必须一次交齐所有内置语言，缺一个都会在注册处被拒绝；中文是本插件的主语言，
     * 英文只求达意。`{name}` 是插值占位符（由 locale 服务替换）。
     */
    const zh = {
      tab: 'Aperture',
      title: 'Aperture 模型发现',
      subtitle: '把实例通告的模型发布成 llm-pi-ai 的 provider 路由。',
      loading: '正在读取状态…',
      addressLabel: '实例地址',
      addressPlaceholder: 'https://ai.example.ts.net',
      addressDormant: '没有实例地址：发现处于休眠，插件不探测，也不会写入 llm-pi-ai。',
      syncLabel: '同步到 llm-pi-ai',
      syncOn: '写入 provider 字典',
      syncOff: '只探测，不写入',
      overridden: '已覆盖',
      overriddenHint: '这一项写在你的设置文件里；存在就算覆盖，值与默认相同也算。',
      syncOffTag: '不同步',
      reset: '恢复默认',
      resetHint: '从设置文件里删掉这一项，回到组合层与默认值。',
      dotConfigured: '实例地址已配置',
      dotMissing: '没有实例地址',
      dotRefreshOk: '最近一次刷新成功',
      dotRefreshFailed: '最近一次刷新失败',
      dotPublished: '这一轮已写入 llm-pi-ai',
      dotUnpublished: '这一轮没有写入 llm-pi-ai：{reason}',
      dotUnservedModels: '这些模型没有路由可用',
      reasonUnknown: '报告里没有写原因',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      refresh: '立即刷新',
      refreshing: '正在发现…',
      withdraw: '撤掉已发布的路由',
      withdrawing: '正在撤下…',
      readOnly: '当前设置文档不接受写入，表单只读。',

      statusHeading: '最近一次刷新',
      noAddress: '未配置地址',
      neverRefreshed: '尚未完成任何刷新：稍后会自动重试，也可以按「立即刷新」。',
      refreshOk: '成功',
      refreshFailed: '失败',
      factTrigger: '触发',
      factTime: '时间',
      factDuration: '耗时',
      factResult: '结果',
      factCatalog: '清单',
      catalogEntries: '{count} 个条目',
      catalogUnavailable: '不可用（{reason}）',
      factEndpoint: '端点',
      endpointListed: '{url} 列出了 {count} 行',
      factSync: '设置',
      syncApplied: '向 llm-pi-ai 写入 {count} 个操作（{routes}）',
      syncOnlyRemoval: '仅移除',
      syncSkipped: '未写入（{reason}）',

      modelsHeading: '模型与路由',
      modelsCount: '{count} 个模型',
      modelsMetaOverride: '已覆盖 {count} 个模型，其余沿用发现值与清单',
      modelsMetaInherit: '全部沿用发现值与清单',
      routeNoBaseURL: '→ 这条路由没有写地址',
      noModels: '未发现任何模型。',
      modelsError: '未发现任何内容：{error}',
      unservedHeading: '未服务：没有本插件可发布的端点',
      unservedCard: '未服务',
      unservedHint: '填上协议可以让它在对应路由上发布。',
      unservedEndpoints: '通告的端点：{list}',
      noEndpoints: '未通告任何端点',
      pendingTag: '待保存',
      advancedHide: '收起',

      factContextWindow: '{count} 上下文窗口',
      factMaxTokens: '{count} 输出',
      modalityText: '文本',
      modalityImage: '图像',
      modalityNone: '无模态',
      factReasoningOn: '推理',
      factReasoningOff: '无推理',
      factAlias: '清单别名 {alias}',
      sourceAperture: 'aperture',
      sourceNote: '来自 {source}',
      sourceModelsDev: 'models.dev',
      sourceConfig: '配置',
      sourceDefault: '默认',

      edit: '编辑',
      noAlias: '未收录',
      noChanges: '没有要保存的改动。',
      editName: '显示名',
      editAlias: '清单别名',
      editContextWindow: '上下文',
      editMaxTokens: '最大输出',
      editInput: '输入模态',
      editReasoning: '推理',
      editApi: '协议',
      editHint: '显示名、容量与模态留空表示这一项不覆盖，回落到发现值；协议与推理的「跟随发现」同理。',
      effectiveHint: '生效 {value}',
      effectiveSource: '生效 {value} · 来自 {source}',
      optionAuto: '跟随发现',
      optionOn: '开',
      optionOff: '关',
      invalidNumber: '{field} 必须是不小于 1 的整数。',
    };

    const en = {
      tab: 'Aperture',
      title: 'Aperture model discovery',
      subtitle: 'Publish the models your instance advertises as llm-pi-ai provider routes.',
      loading: 'Reading state…',
      addressLabel: 'Instance address',
      addressPlaceholder: 'https://ai.example.ts.net',
      addressDormant: 'No instance address: discovery is dormant, so nothing is probed and nothing is written to llm-pi-ai.',
      syncLabel: 'Sync into llm-pi-ai',
      syncOn: 'writes the provider dictionary',
      syncOff: 'probe only, write nothing',
      overridden: 'Overridden',
      overriddenHint: 'This field is set in your settings file; presence alone marks it overridden, even when the value matches the default.',
      syncOffTag: 'no sync',
      reset: 'Reset to default',
      resetHint: 'Remove this key from your settings file and fall back to the composition layer and defaults.',
      dotConfigured: 'instance address configured',
      dotMissing: 'no instance address',
      dotRefreshOk: 'last refresh succeeded',
      dotRefreshFailed: 'last refresh failed',
      dotPublished: 'written into llm-pi-ai this round',
      dotUnpublished: 'not written into llm-pi-ai this round: {reason}',
      dotUnservedModels: 'no route can serve these models',
      reasonUnknown: 'the report records no reason',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      refresh: 'Refresh now',
      refreshing: 'Discovering…',
      withdraw: 'Withdraw published routes',
      withdrawing: 'Withdrawing…',
      readOnly: 'This deployment does not accept settings writes, so the form is read-only.',

      statusHeading: 'Last refresh',
      noAddress: 'no address configured',
      neverRefreshed: 'No refresh has finished yet: one is retried shortly, or press “Refresh now”.',
      refreshOk: 'succeeded',
      refreshFailed: 'failed',
      factTrigger: 'Trigger',
      factTime: 'Time',
      factDuration: 'Took',
      factResult: 'Result',
      factCatalog: 'Catalog',
      catalogEntries: '{count} entries',
      catalogUnavailable: 'unavailable ({reason})',
      factEndpoint: 'Endpoint',
      endpointListed: '{url} listed {count} rows',
      factSync: 'Settings',
      syncApplied: 'wrote {count} operations to llm-pi-ai ({routes})',
      syncOnlyRemoval: 'removals only',
      syncSkipped: 'not written ({reason})',

      modelsHeading: 'Models and routes',
      modelsCount: '{count} models',
      modelsMetaOverride: '{count} models overridden, the rest inherit discovery and the catalog',
      modelsMetaInherit: 'everything inherits discovery and the catalog',
      routeNoBaseURL: '→ this route writes no address',
      noModels: 'No models discovered.',
      modelsError: 'Nothing discovered: {error}',
      unservedHeading: 'Unserved: no endpoint this plugin can publish',
      unservedCard: 'Unserved',
      unservedHint: 'Filling in a protocol publishes it on the matching route.',
      unservedEndpoints: 'Advertised endpoints: {list}',
      noEndpoints: 'no endpoints advertised',
      pendingTag: 'unsaved',
      advancedHide: 'Collapse',

      factContextWindow: '{count} context window',
      factMaxTokens: '{count} output',
      modalityText: 'text',
      modalityImage: 'image',
      modalityNone: 'no modality',
      factReasoningOn: 'reasoning',
      factReasoningOff: 'no reasoning',
      factAlias: 'catalog alias {alias}',
      sourceAperture: 'aperture',
      sourceNote: '来自 {source}',
      sourceModelsDev: 'models.dev',
      sourceConfig: 'config',
      sourceDefault: 'default',

      edit: 'Edit',
      noAlias: 'not in the catalog',
      noChanges: 'Nothing to save.',
      editName: 'Display name',
      editAlias: 'Catalog alias',
      editContextWindow: 'Context',
      editMaxTokens: 'Max output',
      editInput: 'Input modalities',
      editReasoning: 'Reasoning',
      editApi: 'Protocol',
      editHint: 'An empty display name, capacity or modality drops that override and falls back to discovery; the same goes for “follow discovery” on protocol and reasoning.',
      effectiveHint: 'in effect: {value}',
      effectiveSource: 'in effect: {value} · from {source}',
      optionAuto: 'follow discovery',
      optionOn: 'on',
      optionOff: 'off',
      invalidNumber: '{field} must be an integer of at least 1.',
    };


    // ------------------------------------------------------------------ 标签页

    /** 一个错误的人话形式。 */
    function textOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /** token 计数的千位分隔符；跟随浏览器语言。 */
    function formatCount(value) {
      return value.toLocaleString();
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

    /**
     * 「Aperture」标签页。
     *
     * 只持有视图状态：配置与报告分别由一个 effect 拉取，动作按下后再拉一次。**effect 的
     * 依赖里刻意不放注入面**——`inject` 面由渲染器每次渲染重新组装，把它的身份放进依赖会
     * 让 effect 每渲染一次就重跑一次，进而无限循环。因此这里用自增计数器当刷新信号。
     *
     * @param {object} props - 渲染器交过来的 `panel` 与 `t`。
     * @returns {object} 标签页元素。
     */
    function ApertureTab(props) {
      const panel = props.panel;
      const t = typeof props.t === 'function' ? props.t : (key, params) => interpolate(zh[key] ?? key, params);

      const [configuration, setConfiguration] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [report, setReport] = React.useState(null);
      const [banner, setBanner] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [drafts, setDrafts] = React.useState({});
      const [opened, setOpened] = React.useState({});
      const [collapsed, setCollapsed] = React.useState({});
      const [configRevision, setConfigRevision] = React.useState(0);
      const [reportRevision, setReportRevision] = React.useState(0);

      React.useEffect(() => {
        let cancelled = false;
        panel.configuration().then(
          (next) => {
            if (cancelled) return;
            setConfiguration(next);
            setDraft({ baseUrl: next.baseUrl, sync: next.sync });
          },
          (error) => {
            if (!cancelled) setBanner({ ok: false, text: textOf(error) });
          },
        );
        return () => {
          cancelled = true;
        };
      }, [configRevision]);

      React.useEffect(() => {
        let cancelled = false;
        panel.status().then(
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
      }, [reportRevision]);

      /** 跑一个动作：期间禁用按钮，结束后把结果贴出来并按需重读。 */
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
            after();
          }
        })();
      };

      /**
       * 一个模型此刻在表单里长什么样。
       *
       * 取的都是**生效值**，这样输入框里显示的永远是此刻真正在用的东西；提交时逐字段与这份
       * 快照比较，只有改动过的字段才会被发出去（没提到的字段保持原样，因此界面不编辑的
       * `reasoningEfforts` 之类不会被顺手抹掉）。
       *
       * @param {object} model - 报告里的一个模型。
       * @returns {object} 八个字段的初值。
       */
      const initialOf = (model) => ({
        name: model.name,
        alias: model.alias ?? '',
        contextWindow: model.contextWindow === undefined ? '' : String(model.contextWindow),
        maxTokens: model.maxTokens === undefined ? '' : String(model.maxTokens),
        text: model.input.includes('text'),
        image: model.input.includes('image'),
        reasoning: model.override !== undefined && model.override.thinking !== undefined
          ? (model.override.thinking ? 'on' : 'off')
          : 'auto',
        api: (model.override !== undefined && model.override.api) || '',
      });

      /** 一个模型的当前草稿；没改过就是生效值本身。 */
      const draftOf = (model) => drafts[model.id] ?? initialOf(model);

      /** 改一个字段；用函数式更新，同一个 tick 里连着改几个字段也不会互相覆盖。 */
      const edit = (model, field, value) => {
        setDrafts((current) => ({
          ...current,
          [model.id]: { ...(current[model.id] ?? initialOf(model)), [field]: value },
        }));
      };

      /** 改动的字段 → 补丁；没变的不进补丁，非法值只报字段名。 */
      const patchOf = (draft, initial) => {
        const patch = {};
        const bad = [];

        if (draft.name !== initial.name) patch.name = draft.name.trim() === '' ? null : draft.name.trim();
        if (draft.alias !== initial.alias) patch.alias = draft.alias.trim();

        for (const [field, label] of [['contextWindow', 'editContextWindow'], ['maxTokens', 'editMaxTokens']]) {
          if (draft[field] === initial[field]) continue;
          const raw = draft[field].trim();
          if (raw === '') {
            patch[field] = null;
            continue;
          }
          const value = Number(raw);
          if (!Number.isInteger(value) || value < 1) bad.push(t(label));
          else patch[field] = value;
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
       * 保存这一行的改动。
       *
       * 一行一个保存按钮，写下去的就只有这一行——多行同时开着也不会互相牵连，版本校验也只
       * 管这一次写入。保存成功后收起面板：这一行的覆盖标签与事实都会跟着变，收起才看得见。
       *
       * @param {object} model - 报告里的一个模型。
       */
      const submit = (model) => {
        const { patch, bad } = patchOf(draftOf(model), initialOf(model));
        if (bad.length > 0) {
          setBanner({ ok: false, text: t('invalidNumber', { field: bad.join('、') }) });
          return;
        }
        if (Object.keys(patch).length === 0) {
          setBanner({ ok: true, text: t('noChanges') });
          return;
        }
        run('edit', () => panel.edit(model.id, patch), () => {
          dropDraft(model.id);
          close(model.id);
          setConfigRevision((value) => value + 1);
          setReportRevision((value) => value + 1);
        });
      };

      /** 丢掉一行的草稿：输入框回到生效值。 */
      const dropDraft = (id) => {
        setDrafts((current) => {
          const { [id]: _dropped, ...kept } = current;
          return kept;
        });
      };

      /** 收起一行（草稿已经丢掉或写入成功）。 */
      const close = (id) => setOpened((state) => ({ ...state, [id]: false }));

      /** 取消这一行的编辑：草稿丢掉、面板收起，什么都不写。 */
      const cancel = (model) => {
        dropDraft(model.id);
        close(model.id);
        setBanner(null);
      };

      /**
       * 撤销这一行的覆盖：只把**报告里写着确实被覆盖过**的字段清掉。
       *
       * 不是整条删掉：`aperture.models` 里那条可能还有界面根本不编辑的键（例如
       * `reasoningEfforts`），整条删掉等于把用户手写的东西一起扔掉。因此这里只把已知被覆盖的
       * 字段逐个置空——与保存走同一个端点，只是补丁全是 `null`。万一报告的覆盖里出现了界面
       * 不认识的键（宿主以后加了字段），整条删掉是唯一能让这一行真的回落到发现值的做法。
       *
       * @param {object} model - 报告里的一个模型。
       */
      const clearOverrides = (model) => {
        const overrides = model.override ?? {};
        const patch = {};
        if (overrides.name !== undefined) patch.name = null;
        if (overrides.api !== undefined) patch.api = null;
        if (overrides.contextWindow !== undefined) patch.contextWindow = null;
        if (overrides.maxTokens !== undefined) patch.maxTokens = null;
        if (overrides.input !== undefined) patch.input = null;
        if (overrides.thinking !== undefined) patch.thinking = null;
        // 别名在 `modelAliases` 里，是另一张表；显示的别名可能来自清单，因此这里只是
        // 「不要再覆盖」，宿主看到用户层没有这个键就什么都不写。
        if (model.alias !== undefined) patch.alias = '';

        const payload = Object.keys(patch).length === 0 ? null : patch;
        run('revert', () => panel.edit(model.id, payload), () => {
          dropDraft(model.id);
          close(model.id);
          setConfigRevision((value) => value + 1);
          setReportRevision((value) => value + 1);
        });
      };

      if (configuration === null || draft === null) {
        return h(
          'div',
          { [STYLE_MARK]: '', 'aria-busy': 'true' },
          h('p', { className: 'dap-subtitle' }, banner === null ? t('loading') : banner.text),
        );
      }

      const disabled = busy !== '' || !configuration.writable;
      const dirty = draft.baseUrl !== configuration.baseUrl || draft.sync !== configuration.sync;
      const dormant = draft.baseUrl.trim().length === 0;

      /** 「标签 + 值」的一行；没有标签时就是一个整行的值（错误什么的）。 */
      const fact = (key, label, value) => h(
        'div',
        { className: 'dap-fact', key },
        label === null ? null : h('dt', null, label),
        h('dd', null, value),
      );

      /** 状态段：最近一次刷新决定了什么。 */
      const statusFacts = (current) => {
        const refresh = current.refresh;
        if (refresh === undefined) {
          return h('p', { className: 'dap-hint' }, t('neverRefreshed'));
        }
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
                routes: refresh.sync.routes.join(', ') || t('syncOnlyRemoval'),
              })
              : t('syncSkipped', { reason: refresh.sync.reason ?? '—' })),
        );
      };

      /** 一个模型那几项生效的事实。 */
      const modelFacts = (model) => {
        const facts = [];
        if (model.contextWindow !== undefined) {
          facts.push(t('factContextWindow', { count: formatCount(model.contextWindow) }));
        }
        if (model.maxTokens !== undefined) facts.push(t('factMaxTokens', { count: formatCount(model.maxTokens) }));
        facts.push(model.input.length === 0
          ? t('modalityNone')
          : model.input.map((item) => t(item === 'image' ? 'modalityImage' : 'modalityText')).join('+'));
        facts.push(model.reasoning ? t('factReasoningOn') : t('factReasoningOff'));
        if (model.alias !== undefined && model.alias !== '') facts.push(t('factAlias', { alias: model.alias }));
        return facts.join(' · ');
      };

      /** 披露箭头；展开时转 90 度（官方那份也是自己画的内联 SVG）。 */
      const chevron = (open) => h(
        'span',
        { className: 'dap-chevron', 'data-open': open ? 'true' : 'false' },
        h(
          'svg',
          { width: '12', height: '12', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          h('path', {
            d: 'M6 3.5L10.5 8L6 12.5',
            stroke: 'currentColor',
            strokeWidth: '1.5',
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
      );

      /**
       * 身份里的状态点。
       *
       * 官方拿这个 8px 的圆点说「这个提供方的凭据配好了没有」；这里沿用同一个记号，两种状态
       * 分别说「地址填了没有」（实例卡）与「最近一次刷新成不成功」（刷新卡）。颜色不是唯一的
       * 说法：`title` 与 `aria-label` 里写着同一句话，悬停与读屏都拿得到。
       *
       * @param {'ok'|'bad'} state - 圆点的状态。
       * @param {string} label - 与圆点同义的文案。
       * @returns {object} 一个圆点元素。
       */
      const dot = (state, label) => h('span', {
        className: 'dap-dot',
        'data-state': state,
        role: 'img',
        title: label,
        'aria-label': label,
      });

      /**
       * 两张段卡（实例、最近一次刷新）默认展开，折叠状态按卡记——官方那边也是 `?? true`：只有
       * 用户明确折过才收起，重渲染（每次刷新都会重渲染）不会把它弹回来。
       *
       * @param {string} key - 卡片键。
       * @returns {boolean} 这张卡现在是不是展开的。
       */
      const sectionOpen = (key) => collapsed[key] !== true;

      /**
       * 卡片头：左边是身份（名字 + 标签 + 状态点），右边是这一张卡自己的动作——官方 `rowHead`。
       *
       * 给了 `collapse` 时，身份那一段整体变成一个折叠按钮：箭头 + 身份。官方分组头就是这个形状
       * （`groupToggle` 里放箭头与标题），动作必须留在按钮**外面**，因为按钮里不能再嵌按钮。
       *
       * @param {object[]} identity - 身份那几个元素。
       * @param {object[]} [actions] - 右对齐的动作按钮；没有动作时整块不出现。
       * @param {{key: string, open: boolean}} [collapse] - 折叠开关；不给就是一张折不动的卡。
       * @returns {object} 卡片头。
       */
      const cardHead = (identity, actions, collapse) => h(
        'div',
        { className: 'dap-card-head' },
        collapse === undefined
          ? h('span', { className: 'dap-identity' }, identity)
          : h(
            'button',
            {
              type: 'button',
              id: `dap-card-${collapse.key}-toggle`,
              className: 'dap-card-toggle',
              'aria-expanded': collapse.open ? 'true' : 'false',
              'aria-controls': `dap-body-${collapse.key}`,
              onClick: () => setCollapsed((current) => ({
                ...current,
                [collapse.key]: current[collapse.key] !== true,
              })),
            },
            h('span', { className: 'dap-identity' }, [chevron(collapse.open), ...identity]),
          ),
        actions === undefined ? null : h('span', { className: 'dap-row-actions' }, actions),
      );

      /**
       * 一个参数格子：标签在上、控件在下（官方的 `modelAdvanced` 栅格就是这样）。
       *
       * @param {string} key - React key 与控件 id。
       * @param {string} label - 12px 的小标签。
       * @param {object} control - 控件元素。
       * @param {string} [note] - 生效值一类的补充说明。
       * @param {object} [flags] - `wide`（横跨整行）与 `emphasis`（官方 fieldLabel 的
       *   12px/500 label-secondary，模型那些格子用的是更轻的 modelFieldLabel）。
       * @param {object} [badges] - 跟在标签右边的那对记号（见 {@link overrideBadges}）。
       * @returns {object} 一个栅格单元。
       */
      const field = (key, label, control, note, flags = {}, badges) => h(
        'div',
        {
          className: 'dap-field',
          key,
          'data-wide': flags.wide === true ? 'true' : undefined,
          'data-emphasis': flags.emphasis === true ? 'true' : undefined,
        },
        badges === undefined
          ? h('label', { htmlFor: key }, label)
          : h(
            'div',
            { className: 'dap-field-head' },
            h('label', { htmlFor: key }, label),
            badges,
          ),
        control,
        note === undefined ? null : h('span', { className: 'dap-field-note' }, note),
      );

      /**
       * 「已覆盖」那对记号：一枚标签加一个「恢复默认」，紧挨着它描述的那个字段的标签——官方
       * `ValueField` 的 `badges` 就在这个位置。搁在卡头上时它是一句没有主语的「已覆盖」，而它离
       * 要撤销的那一项越远，越像在说别的东西。
       *
       * @param {Function} onReset - 按下「恢复默认」之后做什么。
       * @returns {object} 标签与按钮。
       */
      const overrideBadges = (onReset) => h('span', { className: 'dap-field-badges' }, [
        h('span', { className: 'dap-tag', title: t('overriddenHint') }, t('overridden')),
        h('button', {
          type: 'button',
          className: 'dap-reset',
          title: t('resetHint'),
          disabled,
          onClick: onReset,
        }, t('reset')),
      ]);

      /** 一个 `<select>` 的选项。 */
      const option = (value, label) => h('option', { value, key: value === '' ? 'auto' : value }, label);

      /**
       * 一个字段旁边的注脚：当前生效的值，以及它从哪里来。
       *
       * 来源跟着**它描述的那个字段**走：「容量 1,048,576 · 来自 aperture」和输入框摆在一起
       * 才读得懂。把四项来源串成一句话挂在行尾，用户得自己把每一项对回去，而一张十一行模型
       * 的清单每行再挂一串，正文就被诊断信息盖住了。
       *
       * @param {string} value - 当前生效的值。
       * @param {string} [source] - 来源代号；没有来源时（例如协议是推导出来的）只说值。
       * @returns {string} 注脚。
       */
      const inEffect = (value, source) => source === undefined
        ? t('effectiveHint', { value })
        : t('effectiveSource', { value, source: t(SOURCE_KEYS[source] ?? source) });

      /** 编辑面板里的一个文本输入框。 */
      const textField = (model, name, label, options = {}) => {
        const id = `dap-model-${model.id}-${name}`;
        return field(
          id,
          label,
          h('input', {
            id,
            className: 'dap-input',
            type: 'text',
            inputMode: options.numeric === true ? 'numeric' : undefined,
            spellCheck: false,
            autoComplete: 'off',
            placeholder: options.placeholder,
            value: draftOf(model)[name],
            disabled: !configuration.writable,
            onChange: (event) => edit(model, name, event.target.value),
          }),
          options.note,
        );
      };

      /**
       * 一个模型的参数面：展开后才出现的全部字段，以及这一行的三个动作。
       *
       * 它落在**路由卡那块浅色编辑区里面**，所以自己不铺底——只切一条 l2 细线跟上方的模型行
       * 分开（官方 `modelAdvanced` 就是这么处理的）。里面仍是官方那套：`minmax(160px, 1fr)` 的
       * 参数栅格、12px 的小标签、右对齐的动作行（危险动作在左、主按钮在右）。
       *
       * @param {object} model - 报告里的一个模型。
       * @returns {object} 参数面。
       */
      const advanced = (model) => {
        const current = draftOf(model);
        const overridden = model.override !== undefined && Object.keys(model.override).length > 0;
        const { patch } = patchOf(current, initialOf(model));
        const count = (value) => (value === undefined ? '—' : formatCount(value));
        const modalities = model.input.length === 0
          ? t('modalityNone')
          : model.input.map((item) => t(item === 'image' ? 'modalityImage' : 'modalityText')).join('+');
        const toggle = (name, id) => h(
          'label',
          { className: 'dap-check', htmlFor: id },
          h('input', {
            id,
            type: 'checkbox',
            checked: current[name],
            disabled: !configuration.writable,
            onChange: (event) => edit(model, name, event.target.checked),
          }),
          t(name === 'text' ? 'modalityText' : 'modalityImage'),
        );

        return h(
          'div',
          { className: 'dap-advanced' },
          h(
            'div',
            { className: 'dap-fields' },
            textField(model, 'name', t('editName'), {
              placeholder: model.name,
              // 输入框里显示的就是这个值，注脚只要说它从哪儿来。
              note: t('sourceNote', { source: t(SOURCE_KEYS[model.provenance.name] ?? model.provenance.name) }),
            }),
            textField(model, 'alias', t('editAlias'), { placeholder: t('noAlias') }),
            textField(model, 'contextWindow', t('editContextWindow'), {
              numeric: true,
              note: inEffect(count(model.contextWindow), model.provenance.limits),
            }),
            textField(model, 'maxTokens', t('editMaxTokens'), {
              numeric: true,
              note: inEffect(count(model.maxTokens), model.provenance.limits),
            }),
            field(
              `dap-model-${model.id}-input`,
              t('editInput'),
              h(
                'div',
                { className: 'dap-row' },
                toggle('text', `dap-model-${model.id}-text`),
                toggle('image', `dap-model-${model.id}-image`),
              ),
              inEffect(modalities, model.provenance.input),
            ),
            field(
              `dap-model-${model.id}-reasoning`,
              t('editReasoning'),
              h(
                'select',
                {
                  id: `dap-model-${model.id}-reasoning`,
                  className: 'dap-input',
                  value: current.reasoning,
                  disabled: !configuration.writable,
                  onChange: (event) => edit(model, 'reasoning', event.target.value),
                },
                option('auto', t('optionAuto')),
                option('on', t('optionOn')),
                option('off', t('optionOff')),
              ),
              inEffect(model.reasoning ? t('optionOn') : t('optionOff'), model.provenance.reasoning),
            ),
            field(
              `dap-model-${model.id}-api`,
              t('editApi'),
              h(
                'select',
                {
                  id: `dap-model-${model.id}-api`,
                  className: 'dap-input',
                  value: current.api,
                  disabled: !configuration.writable,
                  onChange: (event) => edit(model, 'api', event.target.value),
                },
                option('', t('optionAuto')),
                option('openai-completions', 'openai-completions'),
                option('anthropic-messages', 'anthropic-messages'),
              ),
              // 协议是从通告的端点上推导出来的，没有来源可报，只说当前是哪一种。
              inEffect(model.protocol ?? '—'),
            ),
          ),
          h('p', { className: 'dap-field-note' }, t('editHint')),
          model.route === undefined ? h('p', { className: 'dap-field-note' }, t('unservedHint')) : null,
          h(
            'div',
            { className: 'dap-actions', 'data-align': 'end' },
            overridden
              ? h('button', {
                id: `dap-model-${model.id}-revert`,
                type: 'button',
                className: 'dap-button',
                'data-danger': 'true',
                disabled: disabled,
                onClick: () => clearOverrides(model),
              }, busy === 'revert' ? t('saving') : t('reset'))
              : null,
            h('button', {
              id: `dap-model-${model.id}-cancel`,
              type: 'button',
              className: 'dap-button',
              disabled: busy !== '',
              onClick: () => cancel(model),
            }, t('cancel')),
            h('button', {
              id: `dap-model-${model.id}-save`,
              type: 'button',
              className: 'dap-button',
              'data-primary': 'true',
              // 没改动就没什么可保存的（官方那张卡片的「应用」也是这样）。
              disabled: disabled || Object.keys(patch).length === 0,
              onClick: () => submit(model),
            }, busy === 'edit' ? t('saving') : t('save')),
          ),
        );
      };

      /**
       * 一个模型一行（路由编辑区里的一层）：收起时只有 id、标签与生效的事实，点「编辑」才在
       * 这一行自己下面展开参数。
       *
       * 这一行不再自己带状态点：它有没有被服务，外面那张路由卡（或「未服务」那张卡）的卡头
       * 已经说过了——嵌套本身就把这件事讲清楚了，不必每行重复一遍。
       */
      const modelRow = (model) => {
        const { patch } = patchOf(draftOf(model), initialOf(model));
        const overridden = model.override !== undefined && Object.keys(model.override).length > 0;
        const open = opened[model.id] === true;

        return h(
          'li',
          { className: 'dap-model', key: model.id },
          h(
            'div',
            { className: 'dap-model-head' },
            h(
              'span',
              { className: 'dap-identity' },
              h('code', { className: 'dap-model-id' }, model.id),
              model.name === model.id ? null : h('span', { className: 'dap-name' }, model.name),
              // 这一行的标签说的是「这一行整体有覆盖」，因此它撤不掉单个字段：点开这一行，
              // 每个字段的生效值旁边写着它从哪儿来，底下那颗「恢复默认」才是清掉整行的那颗。
              overridden
                ? h('span', { className: 'dap-tag', title: t('overriddenHint') }, t('overridden'))
                : null,
              Object.keys(patch).length > 0 ? h('span', { className: 'dap-tag' }, t('pendingTag')) : null,
            ),
            h(
              'span',
              { className: 'dap-row-actions' },
              h('button', {
                id: `dap-model-${model.id}-toggle`,
                type: 'button',
                className: 'dap-button',
                'aria-label': t('edit'),
                'aria-expanded': open ? 'true' : 'false',
                disabled: busy !== '',
                onClick: () => setOpened((state) => ({ ...state, [model.id]: !open })),
              }, chevron(open), open ? t('advancedHide') : t('edit')),
            ),
          ),
          h('div', { className: 'dap-model-facts' }, modelFacts(model)),
          model.route === undefined
            ? h('p', { className: 'dap-model-meta' }, t('unservedEndpoints', {
              list: model.endpoints.length === 0 ? t('noEndpoints') : model.endpoints.join(', '),
            }))
            : null,
          open ? advanced(model) : null,
        );
      };

      /**
       * 一条路由一张卡：卡头是 `provider · 协议` 加模型数，展开后是浅色面里的模型清单。
       *
       * 这就是官方那张 provider 卡的两层——卡头、以及卡里那块浅色面里的模型目录；区别只在
       * 我们这一层装的是「这条路由解析出来的模型」。卡头上的点说这一轮有没有把它写进
       * `llm-pi-ai`（同步关掉、失败、或者报告里根本没有同步结果时，就没有什么可说：不画点）。
       *
       * @param {string} key - 展开状态的键（路由 id 不会与模型 id 撞车）。
       * @param {string} name - 卡头身份，`provider` 或「未服务」。
       * @param {string|undefined} api - 协议；没有就不写。
       * @param {string} note - 编辑区头上那一行说明。
       * @param {object} models - 这张卡里的模型。
       * @param {{state: string, title: string}|undefined} state - 卡头那枚状态点；不知道就
       *   `undefined`（没有状态可说，不画点）。
       * @returns {object} 路由卡。
       */
      const routeCard = (key, name, api, note, models, state) => {
        const open = opened[key] === true;
        return h(
          'li',
          { className: 'dap-route', key },
          h(
            'div',
            { className: 'dap-card-head' },
            h(
              'span',
              { className: 'dap-identity' },
              h('span', { className: 'dap-name' }, name),
              api === undefined ? null : h('code', { className: 'dap-model-id' }, api),
              h('span', { className: 'dap-tag' }, t('modelsCount', { count: models.length })),
              state === undefined ? null : dot(state.state, state.title),
            ),
            h(
              'span',
              { className: 'dap-row-actions' },
              h('button', {
                id: `dap-route-${key}-toggle`,
                type: 'button',
                className: 'dap-button',
                'aria-label': t('edit'),
                'aria-expanded': open ? 'true' : 'false',
                disabled: busy !== '',
                onClick: () => setOpened((state) => ({ ...state, [key]: !open })),
              }, chevron(open), open ? t('advancedHide') : t('edit')),
            ),
          ),
          open
            ? h(
              'div',
              { className: 'dap-editor' },
              h('div', { className: 'dap-editor-head' }, h('span', { className: 'dap-editor-route' }, note)),
              h('ul', { className: 'dap-models' }, models.map(modelRow)),
            )
            : null,
        );
      };

      /**
       * 模型清单：先按路由分组，最后是没有任何路由能服务的那些。
       *
       * 这一段与官方「模型」页同一副骨架：**页面级的标题 + 一叠可展开的卡片**，模型自己不套
       * 外卡——官方那页也不是「一个大卡里装小卡」，而是标题下面直接排卡片。标题右边只有官方
       * 那句「已覆盖几个，其余沿用发现值与清单」；没有官方的「撤销全部覆盖」，因为这里按行改，
       * 撤销也按行做，一次管一整份清单的动作没有对应场景。
       *
       * 每张卡收起时是卡头加一条事实，点「编辑」在**这张卡里**展开那块浅色面（官方那张
       * DeepSeek 卡也是这个形状）：报告是这张标签页的主要用途，不该被一地输入框淹掉。
       *
       * @param {object} current - 报告。
       * @returns {object} 模型段。
       */
      const modelList = (current) => {
        const overridden = current.models.filter(
          (model) => model.override !== undefined && Object.keys(model.override).length > 0,
        );

        const head = [
          h(
            'div',
            { className: 'dap-row' },
            h('div', { className: 'dap-title' }, t('modelsHeading')),
            h('span', { className: 'dap-tag' }, t('modelsCount', { count: current.models.length })),
          ),
          h('p', { className: 'dap-hint' }, overridden.length === 0
            ? t('modelsMetaInherit')
            : t('modelsMetaOverride', { count: overridden.length })),
        ];

        if (current.models.length === 0) {
          return [
            head,
            h('p', { className: 'dap-hint' }, current.refresh !== undefined && current.refresh.error !== undefined
              ? t('modelsError', { error: current.refresh.error })
              : t('noModels')),
          ];
        }

        // 同步结果只在报告里有时才说得出「写没写进 llm-pi-ai」；没有就交给 routeCard 不画点。
        const sync = current.refresh === undefined ? undefined : current.refresh.sync;
        const written = sync === undefined ? undefined : sync.routes;

        const cards = [];
        for (const route of current.routes) {
          const models = current.models.filter((model) => model.route === route.provider);
          if (models.length === 0) continue;
          const note = route.baseURL === undefined
            ? t('routeNoBaseURL')
            : `→ ${route.baseURL}`;
          const published = written === undefined ? undefined : written.includes(route.provider);
          cards.push(routeCard(
            route.provider,
            route.provider,
            route.api,
            note,
            models,
            // 没写进去时把原因带上：只写「没写进去」等于让人去别处找原因，而这一轮为什么没写成
            // 正是这个点唯一想说的话。
            published === undefined
              ? undefined
              : {
                state: published ? 'ok' : 'bad',
                title: published
                  ? t('dotPublished')
                  : t('dotUnpublished', { reason: sync.reason ?? t('reasonUnknown') }),
              },
          ));
        }
        const unserved = current.models.filter((model) => model.route === undefined);
        if (unserved.length > 0) {
          // 这张卡没有路由，它的点说的是模型自己的状态：一个都没接上。
          cards.push(routeCard('unserved', t('unservedCard'), undefined, t('unservedHeading'), unserved, {
            state: 'bad',
            title: t('dotUnservedModels'),
          }));
        }

        return [head, h('ul', { className: 'dap-models' }, cards)];
      };

      return h(
        'div',
        { [STYLE_MARK]: '', 'aria-busy': busy !== '' ? 'true' : 'false' },
        h(
          'div',
          null,
          h('div', { className: 'dap-title' }, t('title')),
          h('p', { className: 'dap-subtitle' }, dormant ? t('addressDormant') : t('subtitle')),
        ),

        h(
          'div',
          { className: 'dap-section' },
          cardHead(
            [
              h('span', { className: 'dap-name' }, t('tab')),
              draft.sync ? null : h('span', { className: 'dap-tag' }, t('syncOffTag')),
              dot(dormant ? 'bad' : 'ok', dormant ? t('dotMissing') : t('dotConfigured')),
            ],
            // 卡头上不再挂「已覆盖」与「恢复默认」：它们各自跟着自己描述的那个字段走（见下面
            // 两处 overrideBadges），卡头只留身份。
            undefined,
            { key: 'instance', open: sectionOpen('instance') },
          ),
          // 折起来时整块不渲染（官方也是 `open ? body : null`）：DOM 里不留一个藏着的输入框。
          sectionOpen('instance') ? h(
            'div',
            { className: 'dap-editor', id: 'dap-body-instance' },
            h(
              'div',
              { className: 'dap-editor-head' },
              h('span', { className: 'dap-editor-title' }, t('tab')),
              h('span', { className: 'dap-editor-route' }, 'aperture.baseUrl'),
            ),
            h(
              'div',
              { className: 'dap-fields' },
              field(
                'dap-base-url',
                t('addressLabel'),
                h('input', {
                  id: 'dap-base-url',
                  className: 'dap-input',
                  type: 'text',
                  spellCheck: false,
                  autoComplete: 'off',
                  placeholder: t('addressPlaceholder'),
                  value: draft.baseUrl,
                  disabled,
                  onChange: (event) => setDraft({ baseUrl: event.target.value, sync: draft.sync }),
                }),
                undefined,
                { wide: true, emphasis: true },
                configuration.baseUrlOverridden
                  ? overrideBadges(() => run('reset', () => panel.save(null, undefined), () => setConfigRevision((value) => value + 1)))
                  : undefined,
              ),
            ),
            h(
              'div',
              { className: 'dap-row' },
              h(
                'label',
                { className: 'dap-check', htmlFor: 'dap-sync' },
                h('input', {
                  id: 'dap-sync',
                  type: 'checkbox',
                  checked: draft.sync,
                  disabled,
                  onChange: (event) => setDraft({ baseUrl: draft.baseUrl, sync: event.target.checked }),
                }),
                t('syncLabel'),
              ),
              h('span', { className: 'dap-tag' }, draft.sync ? t('syncOn') : t('syncOff')),
              configuration.syncOverridden
                ? overrideBadges(() => run('reset', () => panel.save(undefined, null), () => setConfigRevision((value) => value + 1)))
                : null,
            ),
            configuration.writable ? null : h('p', { className: 'dap-banner', 'data-ok': 'false' }, t('readOnly')),
            h(
              'div',
              { className: 'dap-actions', 'data-align': 'end' },
              h('button', {
                type: 'button',
                className: 'dap-button',
                disabled: busy !== '' || !dirty,
                onClick: () => setDraft({ baseUrl: configuration.baseUrl, sync: configuration.sync }),
              }, t('cancel')),
              h('button', {
                type: 'button',
                className: 'dap-button',
                'data-primary': 'true',
                disabled: disabled || !dirty,
                onClick: () => run('save', () => panel.save(draft.baseUrl, draft.sync), () => {
                  setConfigRevision((value) => value + 1);
                  setReportRevision((value) => value + 1);
                }),
              }, busy === 'save' ? t('saving') : t('save')),
            ),
          ) : null,
        ),

        h(
          'div',
          { className: 'dap-section' },
          cardHead(
            [
              h('span', { className: 'dap-name' }, t('statusHeading')),
              report === null || report.refresh === undefined
                ? null
                : dot(
                  report.refresh.ok ? 'ok' : 'bad',
                  report.refresh.ok ? t('dotRefreshOk') : t('dotRefreshFailed'),
                ),
            ],
            [
              h('button', {
                type: 'button',
                className: 'dap-button',
                disabled,
                onClick: () => run('refresh', () => panel.refresh(), () => setReportRevision((value) => value + 1)),
              }, busy === 'refresh' ? t('refreshing') : t('refresh')),
              h('button', {
                type: 'button',
                className: 'dap-button',
                'data-danger': 'true',
                disabled,
                onClick: () => run('withdraw', () => panel.withdraw(), () => setReportRevision((value) => value + 1)),
              }, busy === 'withdraw' ? t('withdrawing') : t('withdraw')),
            ],
            { key: 'status', open: sectionOpen('status') },
          ),
          // 动作的反馈留在折叠体**外面**：卡折着的时候按了「立即刷新」，也得看得见结果。
          banner === null
            ? null
            : h('p', { className: 'dap-banner', 'data-ok': banner.ok ? 'true' : 'false' }, banner.text),
          sectionOpen('status') ? h(
            'div',
            { className: 'dap-body', id: 'dap-body-status' },
            report === null
              ? h('p', { className: 'dap-hint' }, t('neverRefreshed'))
              : statusFacts(report),
            report === null
              ? null
              : h('p', { className: 'dap-hint' }, `Aperture：${report.place.length === 0 ? t('noAddress') : report.place}`),
          ) : null,
        ),

        // 模型段自己就是「标题 + 一叠卡片」，外面不再套一张卡（官方那页也没有外卡）。
        report === null ? null : modelList(report),
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
     * 浏览器插件主体：字典、样式、Remote 贡献，以及插件标签页。
     *
     * `ctx.slots.inject` 是必需的，不是可选的：`settings.plugins.tab` 由设置区自己声明，
     * 那个声明完全可能在本插件 `apply` 之后才发生，直接 register 会撞上「槽位尚未声明」。
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
          withdraw: async () => unwrap(await namespace().withdraw()),
          configuration: async () => unwrap(await namespace().configuration()),
          save: async (baseUrl, sync) => unwrap(await namespace().save(baseUrl, sync)),
          edit: async (id, patch) => unwrap(await namespace().edit(id, patch)),
        };
        scope.slots.inject('settings.plugins.tab', () => scope.slots.register({
          name: 'settings.plugins.tab',
          id: 'aperture',
          order: 40,
          label: () => t('tab'),
          locale: NS,
          inject: () => ({ panel }),
        }, ApertureTab));
      });
    }

    const module = { exports: {} };
    module.exports.name = PACKAGE;
    /** 本插件依赖的客户端服务：槽位、字典与 Remote 调用面。 */
    module.exports.inject = ['slots', 'locale', 'remote'];
    module.exports.apply = apply;
    /** 字典命名空间（测试与排查用）。 */
    module.exports.NS = NS;
    /** 上报给 Remote 注册表的贡献（测试与排查用）。 */
    module.exports.REMOTE = REMOTE;
    return module.exports;
  },
});
