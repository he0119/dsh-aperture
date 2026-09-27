/**
 * 配置页的样式表。
 *
 * 两份 `.css` 拼成一张表，由 `tsdown.config.ts` 里的 `cssInline()` 编译成文本内联进产物
 * （对应官方 `dsh-css-text-inline`）：客户端模块系统只服务 `<包名>/client.js` 这一条经典脚本，
 * 没有旁挂 `.css` 的路由，所以 CSS 必须进产物。
 *
 * - [ui.css](./ui.css)：本插件自己那几个控件的配方，从官方原语包逐条抄来（类名换成 `dap-ui-` 前缀）。
 * - [styles.css](./styles.css)：这一页自己的排版——分组间距、字段栅格、模型行那张卡。
 *
 * 顺序是先基础控件、后页面排版；两边的类名各自成段（`dap-ui-*` 与 `dap-*`），没有同名规则。
 *
 * @module dsh-aperture/client/styles
 */

import uiStyles from './ui.css?inline';
import pageStyles from './styles.css?inline';

/** 样式归属：官方 `data-plugin` 写包名，`data-plugin-css` 写「包名/文件名」。 */
const PLUGIN_ID = 'dsh-aperture';
const STYLE_OWNER = `${PLUGIN_ID}/styles.css`;

/** 注入用的那张表：控件在前、页面排版在后。 */
const STYLESHEET = `${uiStyles}\n${pageStyles}`;

/**
 * 配置页样式。
 *
 * 页面在独立 bundle 里，用不了仓库的 CSS module 管线，因此样式随包分发、按 effect 生命周期注入，
 * 卸载时移除；元素按 `data-plugin-css` 认领，与自己重名的那份先删掉（热替换）。
 *
 * 两份表的写法有意不同：
 *
 * - 页面排版（`styles.css`）的颜色 token 各带回落值——它写的是本页自己的配方，token 落空时还有
 *   一个能看的兜底。
 * - 控件那一段（`ui.css`）不留回落值，与上游逐字一致（见该文件开头的说明）：那几条就是宿主自己
 *   的配方，`var()` 落空说明主题里那个 token 没了，那是该看见的故障。
 *
 * 两边共同遵守的一条：只许用**主题里真的定义过**的 token。分界线是「主题定义」而不是「别的页面
 * 用过」——`--dsw-alias-settings-card-stroke` 那种只活在官方「模型」页自己那份组件 CSS 里的名字，
 * 引用它等于引用一个空值，回落值又是白色，于是亮色主题下卡片连边都看不见（暗色主题反而正常，
 * 因为回落值是白 16%）。界定这一页可用范围的那份清单来自主题包自己的定义
 * （`@deepseek-ai/dsh-client-ui-theme`，本机那一版定义了 395 个名字），用例里钉住的也是它。
 *
 * @returns {Function} 卸载时移除样式表的 disposer。
 */
export function installStyles() {
  const stale = document.querySelector(`style[data-plugin-css="${STYLE_OWNER}"]`);
  if (stale !== null && stale.parentNode !== null) stale.parentNode.removeChild(stale);

  const element = document.createElement('style');
  element.dataset.plugin = PLUGIN_ID;
  element.dataset.pluginCss = STYLE_OWNER;
  element.textContent = STYLESHEET;
  document.head.appendChild(element);
  return () => {
    if (element.parentNode !== null) element.parentNode.removeChild(element);
  };
}
