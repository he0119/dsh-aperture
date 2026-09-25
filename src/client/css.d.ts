/**
 * `x.css?inline` 的类型：默认导出编译好的样式文本。
 *
 * 真正把它变成文本的是 `tsdown.config.ts` 里的 `cssInline()` 加载器（对应官方
 * `packages/client/tsdown.client.ts` 的 `dsh-css-text-inline`）。CSS 仍然内联进产物，
 * 只是源码留在了 `.css` 文件里。
 */
declare module '*.css?inline' {
  const text: string;
  export default text;
}
