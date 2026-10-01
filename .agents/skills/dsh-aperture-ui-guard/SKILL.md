---
name: dsh-aperture-ui-guard
description: 改动 dsh-aperture 的 Web Client 端（src/client/** 或 src/client/styles.css）之前与之后走一遍的走查清单：主题 token 白名单与深浅两套主题实测、样式内联与选择器唯一、effect 依赖里不放注入面、槽位注入与字典双语、Remote 端点保留名，以及收尾要跑的命令。当你要加改界面、配色、排版、模型行或设置表单时读它。
---

# Web Client 端改动走查

`src/client/**` 与 `src/client/styles.css` 的每一条约束背后都有一个踩过的坑，而它们
linter、`pnpm run typecheck` 与 `pnpm test` 都抓不到（`test/client.test.ts` 只钉接缝
语义，钉不了观感）。改之前对一遍，改完再对一遍。

## 1. 颜色与圆角

- 只引用**这一页真的定义过**的 token：Theme 检查面列出的 `--dsw-alias-*`，加上官方
  原语自己引用的那几个（`bg-layer-3` / `border-l4` / `interactive-bg-hover` 等）与
  圆角 `--dsw-radius-*`。
- 名单外的名字要登记进 `test/client.test.ts` 的那份 `allowed` 名单并写明理由。
- 每条 `var()` 都带中立回落值。
- **别引用只在别的页面定义过的 token。** 反例是 `--dsw-alias-settings-card-*`：它只
  活在官方「模型」页自己那份组件 CSS 里，引用它等于引用空值，亮色主题下卡片连边都
  看不见（暗色主题反而正常）。
- **量，不要推算**：在真实 dev GUI 里读 `getComputedStyle` 的实测值，深浅两套主题
  各量一遍再下结论。

## 2. 样式源码

- 样式是真 `.css`，由 `tsdown.config.ts` 的 `cssInline()` 内联进产物——客户端模块
  系统只服务 `<包名>/client.js` 这一条经典脚本，没有旁挂 `.css` 的路由。
- 选择器全收在 `[data-dsh-aperture]` 之下，类名一律 `dap-` 前缀。
- **同一个选择器不许定义两次**（用例会核）。
- 样式随 effect 注入，卸载时由 disposer 移除。

## 3. React 与 effect

- 运行时只 `require` 平台基线里的模块：`react`、`react/jsx-runtime`，以及官方原语包
  `@deepseek-ai/dsh-client-ui-primitives`。其余服务（`slots` / `locale` / `remote` /
  `configForms`）一律从 `ctx` 上取。
- **effect 的依赖里不放注入面**：注入面每轮渲染都重新组装，依赖它的身份会让 effect
  每轮重跑、再触发渲染，界面于是一直转圈。刷新信号用自增计数器。
- 控件、图标与设置表单全用官方原语，**不抄进本仓库**；代价由 `peerDependencies` 里
  的 `@deepseek-ai/dsh*` 范围兜底。

## 4. 槽位与字典

- 注册配置页必须走 `ctx.slots.inject('plugins.bundle.config', …)`：这个槽位由插件页
  自己声明，那个声明完全可能晚于本插件的 `apply`。
- 字典用 `ctx.locale.register(NS, { zh, en })` 一次交齐两种语言，键集必须一致。
- 页头那条标题与描述来自 `locale/*.json` 的 `meta.*` 与 `package.json` 的 `icon`，
  字典里不再写 `tab`。

## 5. Remote 端点

- 新端点起名先对一遍 `RemoteNamespaceService` 的保留成员名单（`test/client.test.ts`
  里抄了一份）：撞名会拒绝**整份**贡献，浏览器里只留一行 `console.error`，界面安静地
  什么都不出现。
- 参数名与顺序必须与 Host 端的形参表一致，两端由同一份用例核。
- 描述符在 Web Client 端只需要一个直通的 strict 编解码器，别加逐字段校验。

## 6. 收尾

```sh
pnpm test && pnpm run typecheck && pnpm run build
```

`test/client.test.ts` 测的是**打包产物** `lib/client.js`（`pretest` 会先重打一次，
别绕过它），因此客户端只改源码不构建时，那一条测的还是旧的产物。

界面与样式的改动还要在真实 dev GUI 里走一遍——另建一个 `web-dev` profile，与日常
那个实例互不影响，见 [docs/development.md](../../../docs/development.md)。
