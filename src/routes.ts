/**
 * 三条路由的词汇：唯一一处把「前缀」变成路由键与显示名的地方。
 *
 * 本插件注册给 dsh 的每一条路由只讲一种线缆协议，因此三条路由的名字是同一件事的两种写法：显示名是
 * 前缀的标题写法加协议名（`Aperture (OpenAI Chat Completions)`），路由键是前缀加同一串协议名的小写
 * 连字符写法（`aperture-openai-chat-completions`）。两者都由 {@link RouteVocabulary.label} 推出来，
 * 因此「选择器上看到的」与「报告里写出的路由键」对不上是不可能的。
 *
 * 住在独立模块而不是 `config.ts` 里：配置、发布方案、适配器与报告都要用这份词汇，而它谁都不依赖
 * （只用到 {@link ApertureProtocol}），因此不会绕出环。
 *
 * @module dsh-aperture/routes
 */

import type { ApertureProtocol } from './types.ts';

/** 一条路由的固定词汇：它承载的协议，以及显示名括号里那个协议名。 */
interface RouteVocabulary {
  /** 这条路由的线缆协议，也是 `models[].protocol` 与报告里的取值。 */
  readonly protocol: ApertureProtocol;
  /**
   * 显示名括号里的协议名，也是路由键后缀的来源。
   *
   * 逐字取官方「模型」页给这三个协议的产品名：那一页用产品名显示协议、存 schema 标识符
   * （`protocolOpenAiCompletions` → `openai-completions`），本插件跟着它写，用户在两个页面上看到
   * 的就是同一套词——`OpenAI Chat Completions` 而不是只写 `Chat Completions`，厂牌与协议一起写
   * 出来，这三条路由的名字才成套。
   */
  readonly label: string;
}

/**
 * 三条路由的词汇与顺序。
 *
 * 顺序就是它们在报告、注册与界面上出现的顺序：Chat Completions 最常见，因此排在最前。
 */
const VOCABULARY: readonly RouteVocabulary[] = [
  { protocol: 'openai-completions', label: 'OpenAI Chat Completions' },
  { protocol: 'openai-responses', label: 'OpenAI Responses' },
  { protocol: 'anthropic-messages', label: 'Anthropic Messages' },
];

/** 一条解析好的路由：协议、显示名与注册键。 */
export interface ResolvedRoute extends RouteVocabulary {
  /** 注册给 dsh 的 provider 路由键，例如 `aperture-openai-chat-completions`。 */
  readonly id: string;
  /** 选择器与官方「模型」页上显示的名字，例如 `Aperture (OpenAI Chat Completions)`。 */
  readonly displayName: string;
}

/** 把显示名括号里的协议名写成路由键能用的形状：`OpenAI Chat Completions` → `openai-chat-completions`。 */
function routeSuffix(label: string): string {
  return label.toLowerCase().replaceAll(' ', '-');
}

/**
 * 由前缀解析出这一代的三条路由。
 *
 * 一个部署要换的从来只是前缀（`aperture` → 自己的名字）：三条路由键都由它加协议名的小写写法拼
 * 出来，三个显示名由它的标题写法加协议名拼出来。让它们互相矛盾因此变成不可能，而不是要校验出来的
 * 错误。
 *
 * @param prefix - 已经过文法校验的路由名前缀。
 * @returns 三条路由，顺序与 {@link VOCABULARY} 一致。
 */
export function resolveRoutes(prefix: string): readonly ResolvedRoute[] {
  const base = prefix
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return VOCABULARY.map((route) => ({
    ...route,
    id: `${prefix}-${routeSuffix(route.label)}`,
    displayName: `${base} (${route.label})`,
  }));
}
