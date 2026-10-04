/**
 * 线缆侧：一条已发布的路由 → pi-ai 的 `Model` 与协议实现。
 *
 * 这里刻意**不用** pi-ai 的 `Models` 集合与 `Provider` 封装。那层的职责是为「一个集合里的多个
 * provider、各自带 auth 与目录」服务：它按 provider 解析 auth、合并 provider 的默认头、并延迟到
 * 首次消费时才 dispatch。本插件只有自己声明的三条路由、凭据由宿主的凭据接缝解析、头由本模块
 * 自己拼齐，于是那层每一样都成了多余的间接——它的 auth 语义还会要求一个永远解析成功的
 * `apiKey` 才能派发，而本插件的路由本来就靠占位凭据工作。
 *
 * 协议实现从 pi-ai 的 `.lazy` 入口取：实现模块要到第一次真正发起流式请求时才被动态载入，
 * 而聚合入口会连带拉进整份 provider 目录，本插件一条都不需要。
 *
 * @module dsh-aperture/adapter/route
 */

import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import type { Api, Model as PiModel, ProviderStreams, ThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';
import { DEFAULT_CONTEXT_WINDOW } from '../config.ts';
import { REASONING_LEVELS, type ProviderModel, type ProviderRoute, type ReasoningEfforts } from '../plan.ts';
import type { ApertureProtocol } from '../types.ts';

/**
 * 模型没有声明输出上限时，pi-ai 侧使用的上限。
 *
 * 与 `dsh-llm-pi-ai` 的缺省值一致，而 pi-ai 的每一层都要求 `Model.maxTokens` 存在、并**总是**
 * 把它作为请求上限发出去——没有「不带上限」这条路。这里选一个宽松的值，同时保证它不作为
 * 本插件向宿主声明的默认（见 `resolveModel` 的 `defaultMaxTokens`）：宿主侧的「没声明过上限」
 * 必须继续是「没声明」。
 */
export const DEFAULT_MAX_TOKENS = 32_768;

/** 三种协议各自的 pi-ai 实现。 */
const PROTOCOLS: Record<ApertureProtocol, () => ProviderStreams> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
};

/** 取一种协议的实现。 */
export function protocolApi(protocol: ApertureProtocol): ProviderStreams {
  return PROTOCOLS[protocol]();
}

/** 历史消息里的用量不参与任何计价。 */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * 把一条已发布的模型变成 pi-ai 的 `Model`。
 *
 * @param provider - provider 路由键。
 * @param route - 该路由的协议与地址。
 * @param model - 已发布的模型。
 * @returns pi-ai 的模型描述符。
 */
export function buildModel(
  provider: string,
  route: ProviderRoute,
  model: ProviderModel,
): PiModel<Api> {
  return {
    id: model.id,
    name: model.name,
    api: route.protocol,
    provider,
    baseUrl: route.baseURL,
    input: [...model.input],
    cost: { ...ZERO_COST },
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...reasoningOf(model.reasoningEfforts),
    ...(model.compat === undefined ? {} : { compat: model.compat }),
  };
}

/**
 * 推理档位 → pi-ai 的 `reasoning` 与 `thinkingLevelMap`。
 *
 * 未声明的档位一律**显式钉成不支持**：pi-ai 自己的缺省是不对称的——五个基础档位缺键即视为
 * 支持，`xhigh` 与 `max` 缺键则视为不支持——而写下这份字典的人只该声明它支持的档位，不该
 * 需要知道这条规则。唯一例外是「声明了 `off` 却没有线缆写法」：它留在表外，pi-ai 读作
 * 「支持，但什么都不发」，这正是「不思考」在该协议上的表示。
 *
 * @param efforts - 配置里声明的档位；未声明表示该模型不提供任何档位。
 * @returns pi-ai 模型的推理字段。
 */
function reasoningOf(efforts: Readonly<ReasoningEfforts> | undefined): {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
} {
  if (efforts === undefined) {
    return { reasoning: false };
  }
  const map: ThinkingLevelMap = {};
  for (const level of REASONING_LEVELS) {
    const wire = efforts[level];
    if (wire === undefined) {
      map[level] = null;
      continue;
    }
    if (wire !== null) {
      map[level] = wire;
    }
  }
  return { reasoning: true, thinkingLevelMap: map };
}

/**
 * 一个模型可选的全部推理档位。
 *
 * 与 pi-ai 的 `getSupportedThinkingLevels` 同义，就地实现是为了不从聚合入口取值：那个入口会
 * 连带载入本插件用不到的目录与 provider 实现。
 *
 * @param model - pi-ai 的模型描述符。
 * @returns 按升序排列的档位。
 */
export function supportedEfforts(model: PiModel<Api>): readonly string[] {
  if (!model.reasoning) return ['off'];
  return REASONING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/**
 * 宿主选中的推理档位 → pi-ai 的 `reasoning` 选项。
 *
 * 调用方**必须先**用 {@link supportedEfforts} 验证过档位；这里只负责最后的映射：`off` 与
 * 未指定都在协议上等同「不带上思考参数」。
 *
 * @param effort - 已通过验证的档位 id。
 * @returns pi-ai 的档位，或 `undefined`。
 */
export function effortOption(effort: string | undefined): ThinkingLevel | undefined {
  if (effort === undefined || effort === 'off') return undefined;
  return effort as ThinkingLevel;
}
