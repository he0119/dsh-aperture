/**
 * 单个 Aperture 实例的 URL 归一化。
 *
 * 配置里给的是实例根地址——`https://ai.example.ts.net`——本插件与 pi-ai 适配器
 * 访问的每个端点都由它推导出来。结尾的 `/v1` 会被容忍并剥掉，而不是报错：VS Code
 * 那个参考实现用的是相反的习惯，带着这种习惯过来的用户不该撞上 `/v1/v1`。
 *
 * @module dsh-aperture/url
 */

/** 去掉 URL 字符串结尾的所有正斜杠。 */
function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '');
}

/**
 * 归一化配置里的实例根地址；若没有一个可用，则报告这一点。
 *
 * 只给主机名时按 HTTPS 假定，查询串与片段被丢弃，结尾的 `/v1`（连同任意多个
 * 结尾斜杠）被去掉，这样调用方永远从实例根地址开始拼路径。
 *
 * @param raw - 原样保留的配置值。
 * @returns 去掉结尾斜杠的归一化根地址；当值为空、或不是绝对的 HTTP(S) URL 时
 *   返回 `undefined`。
 */
export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withScheme = /^[a-z][a-z\d+\-.]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  url.hash = '';
  url.search = '';
  const path = stripTrailingSlashes(url.pathname).replace(/\/v1$/u, '');
  url.pathname = path || '/';
  return stripTrailingSlashes(url.toString());
}

/**
 * 列出某个实例所服务模型的端点。
 * @param instanceRoot - 归一化后的实例根地址。
 * @returns 绝对地址的模型清单 URL。
 */
export function buildModelsEndpoint(instanceRoot: string): string {
  return `${stripTrailingSlashes(instanceRoot)}/v1/models`;
}

/**
 * 某种协议下，一条 pi-ai 路由必须携带的 `baseURL`。
 *
 * `openai-completions` 会在路由的 `baseURL` 后面追加 `/chat/completions`，所以它
 * 拿到的是带 `/v1` 的根地址；`anthropic-messages` 走 provider SDK，SDK 自己会追加
 * `/v1/messages`，所以它拿到的是裸的实例根地址。
 * @param instanceRoot - 归一化后的实例根地址。
 * @param protocol - 该路由的协议格式。
 * @returns 该路由的 `baseURL`。
 */
export function buildRouteBaseUrl(instanceRoot: string, protocol: 'openai-completions' | 'anthropic-messages'): string {
  const root = stripTrailingSlashes(instanceRoot);
  return protocol === 'openai-completions' ? `${root}/v1` : root;
}
