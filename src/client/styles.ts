/**
 * 配置页的样式表。
 *
 * 源码是真正的 `styles.css`，由 `tsdown.config.ts` 里的 `cssInline()` 编译成文本内联进产物
 * （对应官方 `dsh-css-text-inline`）：客户端模块系统只服务 `<包名>/client.js` 这一条经典脚本，
 * 没有旁挂 `.css` 的路由，所以 CSS 必须进产物。
 *
 * @module dsh-aperture/client/styles
 */

import styles from './styles.css?inline';

/** 样式归属：官方 `data-plugin` 写包名，`data-plugin-css` 写「包名/文件名」。 */
const PLUGIN_ID = 'dsh-aperture';
const STYLE_OWNER = `${PLUGIN_ID}/styles.css`;

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
export function installStyles() {
  const stale = document.querySelector(`style[data-plugin-css="${STYLE_OWNER}"]`);
  if (stale !== null && stale.parentNode !== null) stale.parentNode.removeChild(stale);

  const element = document.createElement('style');
  element.dataset.plugin = PLUGIN_ID;
  element.dataset.pluginCss = STYLE_OWNER;
  element.textContent = styles;
  document.head.appendChild(element);
  return () => {
    if (element.parentNode !== null) element.parentNode.removeChild(element);
  };
}
