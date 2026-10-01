# Agent Note: 两端统一由 tsdown 构建

Status: implemented

## Problem

DSH 的客户端模块系统只要求一个**经典脚本**：用
`window.__ModuleLoader__.load({ id, factory })` 把自己上报，交给工厂一个同步的
`require`。它不要求这份脚本经过打包器，也不检查它是否被压缩过——手写一份 CJS 工厂体
在契约上完全成立，代价全在源码侧。Host 端则要输出官方式样的 ESM 与按模块的声明。

## Decision

两端都由同一份 `tsdown.config.ts` 构建：源码留在 `src/client/`（`index.ts` 装配 +
`AperturePanel.tsx` 页面 + `ModelRow.tsx` / `ModelEditor.tsx` + `draft.ts` /
`locales.ts` / `remote.ts` / `format.ts` / `styles.ts` + 真 `.css`），产物落
`lib/client.js`（+ `.map`）；Host 端 `src/*.ts` 合成单一 ESM `lib/index.js`，包依赖
全部保持外部 import，声明按模块输出到 `lib/types/`。三份配置共用 `lib/`，完整构建先
统一清理再按顺序输出，单独重建一端不会删掉另一端。

包法照抄官方 `packages/client/tsdown.client.ts` 的三行——那套 preset 只随 monorepo
发布、外部插件 import 不到，所以在 `tsdown.config.ts` 里自己写一份最小的：

```ts
banner: `window.__ModuleLoader__.load({ id: "dsh-aperture", factory: (require) => {`,
intro: 'var module = { exports: {} }; var exports = module.exports;',
footer: 'return module.exports; } });',
```

运行时契约不变：只 `require('react')` / `react/jsx-runtime` 与
`@deepseek-ai/dsh-client-ui-primitives`，槽位、字典与 Remote 都从 `ctx` 上取服务，
因此 `dsh.client.external` 是空的。**CSS 仍然内联**（`cssInline()` 编译成文本）：
客户端模块系统只服务 `<包名>/client.js` 这一个经典脚本，没有旁挂 `.css` 的路由，
也没有加载 `<link>` 的机制。

## Alternatives considered

**手写 CJS 工厂体并入库。** 官方原语与 `ctx` 上那四个服务的形状只能靠记忆——官方
改一个 prop 名字，编译期不会有任何声音；`lib/` 不入库而那份手写产物入库，同一个
仓库里两端命运不同；那时 1566 行 `createElement` 没有 JSX，也没有 sourcemap。

**给客户端另配一套打包（比如 Vite）。** 客户端产物要的正是那三行 banner/intro/footer
包法，官方 preset 只用 tsdown；多一套构建就多一份要跟官方对齐的东西。

## Consequences

- `tsdown` 只打包不做完整类型检查：宿主类型交给 `tsconfig.test.json`，浏览器类型
  交给独立的 `tsconfig.client.json`（`lib: es2023 + dom`、`jsx: react-jsx`、
  `strict`），`pnpm run typecheck` 会跑完两份。
- 官方客户端包按**真实版本**装在 devDependencies 里，但只为类型与打包：运行时由宿主
  模块表提供，本包不解析它们（`test/client.test.ts` 里那个「不许 require 基线之外的
  模块」的替身就是这道保证）。
- 报告与模型的形状不在 Web Client 端另立一套，直接 `import type` Host 端的
  `src/report.ts`——那是两端共享的线格式。
- 两端都要构建，但**生效方式不同**：Web Client 产物重建之后刷新页面即可，Host 端
  必须重启。
