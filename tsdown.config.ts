/**
 * 浏览器半边的打包配置（宿主半边仍走 `tsc -p tsconfig.json`）。
 *
 * DSH 的客户端模块系统只认一个**经典脚本**：它用 `window.__ModuleLoader__.load({ id, factory })`
 * 报名，交给工厂一个同步的 `require`（解析平台模块表里的模块）。产物是 `format: 'cjs'`，外面套三行
 * —— banner 开 `factory`、intro 备好 `module` / `exports`、footer 把 `module.exports` 交回去——
 * 与官方 `packages/client/tsdown.client.ts` 的包法一致（那套 preset 只随 monorepo 发布，
 * 外部插件 import 不到，因此这里自重写一份最小的）。
 *
 * 产物落在 `lib/client.js`（+ `.map`），`package.json` 的 `exports["./client"]` 指向它，
 * 宿主按 `/plugins/<包名>/client.js` 这个名字服务（文件名由包名决定，与产物路径无关），
 * 源映射从 `lib/client.js.map` 读。
 */
import { readFileSync } from 'node:fs'

import { defineConfig } from 'tsdown'

const { name: PACKAGE } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string }

/**
 * 模块表里由宿主提供、本插件直接 `require` 的模块：平台基线（官方
 * `PLATFORM_MODULES`）里的 `react` 与 `react/jsx-runtime`，加上官方 UI 原语包。
 * 它们必须保持外部依赖——同一份实例由模块表提供；其余（本插件自己的代码、将来引入的普通
 * 第三方库）一律内联。
 */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

export default defineConfig({
  name: `${PACKAGE}/client`,
  entry: { client: 'src/client/index.ts' },
  // 宿主那份 tsconfig.json 把 src/client 排除在外（它没有 DOM 也没有 JSX），
  // 因此这里必须显式指到浏览器半边自己的那份，否则 JSX / lib 都会按宿主的算。
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  fixedExtension: false,
  // 宿主半边的 lib/*.js 也在同一个目录里，默认的 clean 会把它们一起删掉。
  clean: false,
  deps: {
    neverBundle: [...EXTERNALS],
    alwaysBundle: specifier => !(EXTERNALS as readonly string[]).includes(specifier),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
