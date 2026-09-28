/**
 * Host 端与 Web Client 端的统一打包配置。
 *
 * 宿主沿用官方包的产物形状：源码打成一个 ESM `lib/index.js`，所有包依赖保持外部，
 * 声明按源码模块输出到 `lib/types/`。Web Client 端则仍遵守 DSH 客户端模块系统的经典脚本契约。
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
import { dirname, relative, resolve, sep } from 'node:path'

import { defineConfig, type TsdownPlugin, type UserConfig } from 'tsdown'

const { name: PACKAGE } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string }

/** tsdown 以包根为 cwd 求值配置；虚拟模块 id 用包根相对路径，免得产物里留下构建机的绝对路径。 */
const ROOT = process.cwd()

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

/** `?inline` 的虚拟模块前缀；结尾不能是 `.css`，否则会撞上 tsdown 自己的 CSS 管线。 */
const CSS_INLINE_VIRTUAL = '\0dsh-aperture-css-inline:'
const CSS_INLINE_SUFFIX = '.mjs'

/**
 * 把 `x.css?inline` 编译成 `export default "<文本>"`。
 *
 * 官方 `packages/client/tsdown.client.ts` 里那三个 `dsh-css-*` 加载器做的是同一件事，外加
 * lightningcss 编译与 CSS Modules 的类名映射。本插件只有一份手写、没有类名变换的样式表，因此这里
 * 只保留「读文件 → 导出文本」：CSS 仍然内联进产物（客户端模块系统只服务 `<包名>/client.js` 这个
 * 经典脚本，没有旁挂 `.css` 的路由），但源码是真正的 `.css` 文件——编辑器认它，也不必再挤在 TS 里。
 * @returns 处理 `?inline` 导入的 rolldown 插件。
 */
function cssInline(): TsdownPlugin {
  return {
    name: 'dsh-aperture-css-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.css?inline')) return null
      const specifier = source.slice(0, -'?inline'.length)
      const file = importer === undefined ? resolve(specifier) : resolve(dirname(importer), specifier)
      const name = relative(ROOT, file).split(sep).join('/')
      return CSS_INLINE_VIRTUAL + name + CSS_INLINE_SUFFIX
    },
    load(id) {
      if (!id.startsWith(CSS_INLINE_VIRTUAL)) return null
      const name = id.slice(CSS_INLINE_VIRTUAL.length, -CSS_INLINE_SUFFIX.length)
      const file = resolve(ROOT, name)
      // 注册成 watch 依赖：`--watch` 下改 CSS 也要重打。
      this.addWatchFile(file)
      return `export default ${JSON.stringify(readFileSync(file, 'utf8'))}`
    },
  }
}

const host: UserConfig = {
  name: `${PACKAGE}/host`,
  entry: { index: 'src/index.ts' },
  tsconfig: 'tsconfig.json',
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  dts: false,
  sourcemap: false,
  fixedExtension: false,
  // 三份配置共用 lib/；完整构建由 package.json 的 prebuild 一次性清理，单独重建一端不删另一端。
  clean: false,
  // 官方 Host 包只合并自己的源码；Cordis、DSH 与普通 npm 依赖都由安装环境解析。
  deps: { neverBundle: true },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}

const types: UserConfig = {
  name: `${PACKAGE}/types`,
  entry: ['src/**/*.ts', '!src/client/**'],
  tsconfig: 'tsconfig.json',
  outDir: 'lib/types',
  root: 'src',
  unbundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  dts: {
    emitDtsOnly: true,
    sourcemap: false,
  },
  sourcemap: false,
  fixedExtension: false,
  clean: false,
  deps: {
    neverBundle: true,
    dts: { neverBundle: true },
  },
}

const client: UserConfig = {
  name: `${PACKAGE}/client`,
  entry: { client: 'src/client/index.ts' },
  // Host 端的 tsconfig.json 把 src/client 排除在外（它没有 DOM 也没有 JSX），
  // 因此这里必须显式指到 Web Client 端自己的那份，否则 JSX / lib 都会按 Host 端的算。
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  fixedExtension: false,
  // Host 端的 lib/index.js 也在同一个目录里，默认的 clean 会把它一起删掉。
  clean: false,
  deps: {
    neverBundle: [...EXTERNALS],
    alwaysBundle: specifier => !(EXTERNALS as readonly string[]).includes(specifier),
  },
  plugins: [cssInline()],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default defineConfig([host, types, client])
