/**
 * 流式转换：pi-ai 的助手事件 → 宿主的 `StreamChunk`。
 *
 * 两处形状差异塑造了本模块。其一，pi-ai 的工具参数在流里以**原始 JSON 片段**出现、在结束时
 * 给出解析好的对象，而宿主的协议要求参数自始至终是字符串；本模块只转发片段，并在块结束时
 * 把对象重新串化。其二，pi-ai 把失败当作**流里的终态事件**（不抛），而宿主的协议有两条合法
 * 错误路径：抛，或者发一个 `finish{kind:'error'|'aborted'}`。这里全部走后者，于是调用方看到的
 * 永远是一条以 `usage` 与 `finish` 收尾的流。
 *
 * @module dsh-aperture/adapter/stream
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ToolCallId,
  isContextWindowExceededError,
  isQuotaExceededError,
  type FinishReason,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import type {
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import { toReplayState, type ReplayBlock } from './replay.ts';

/** 一次流式转换所需的上下文事实。 */
export interface StreamConversion {
  /** provider 路由键，写进重放信封。 */
  readonly provider: string;
  /** 请求里的模型 id，写进重放信封。 */
  readonly model: string;
  /** 该模型声明的上下文容量，用于识别静默溢出。 */
  readonly contextWindow?: number;
  /** 调用方的取消信号；已中止时把终态错误改写成中止。 */
  readonly signal?: AbortSignal;
}

/**
 * 把一条 pi-ai 事件流翻成宿主的块序列。
 *
 * @param events - 一次助手回合的 pi-ai 事件流。
 * @param conversion - 路由、模型与容量事实。
 * @returns 块序列；以 `usage` 与 `finish` 收尾。
 * @throws LlmError 事件流在没有终态事件的情况下结束（`STREAM_CLOSED`）。
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  conversion: StreamConversion,
): AsyncIterable<StreamChunk> {
  // 工具调用的 id 与名字只能在 `toolcall_start` 抓一次：那一刻 pi-ai 可能还没把 id 写进块里，
  // 权威值在 `toolcall_end`。片段事件因此允许 id 为空串，名字可缺。
  const toolCalls = new Map<number, { id: string; name: string }>();
  // 重放信封的块槽位：按块**首次出现**的顺序记下它对应 pi-ai 的哪个 contentIndex。
  const slots: number[] = [];

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break;
      case 'text_start':
        slots.push(event.contentIndex);
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' };
        break;
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta };
        break;
      case 'text_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: { type: 'text', text: event.content },
        };
        break;
      case 'thinking_start':
        slots.push(event.contentIndex);
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' };
        break;
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta };
        break;
      case 'thinking_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: { type: 'reasoning', text: event.content },
        };
        break;
      case 'toolcall_start': {
        const block = event.partial.content[event.contentIndex];
        toolCalls.set(event.contentIndex, {
          id: block?.type === 'toolCall' ? block.id : '',
          name: block?.type === 'toolCall' ? block.name : '',
        });
        slots.push(event.contentIndex);
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' };
        break;
      }
      case 'toolcall_delta': {
        const known = toolCalls.get(event.contentIndex);
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: ToolCallId(known?.id ?? ''),
          ...(known === undefined || known.name.length === 0 ? {} : { name: known.name }),
          argumentsDelta: event.delta,
        };
        break;
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: ToolCallId(event.toolCall.id),
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        };
        break;
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) };
        yield {
          type: 'finish',
          reason: finishReason(event.message, conversion.contextWindow),
          replayState: toReplayState(
            event.message,
            conversion.provider,
            conversion.model,
            replayBlocks(event.message, slots),
          ),
        };
        return;
      case 'error': {
        const message = conversion.signal?.aborted === true
          ? { ...event.error, stopReason: 'aborted' as const }
          : event.error;
        yield { type: 'usage', usage: mapUsage(message.usage) };
        yield { type: 'finish', reason: finishReason(message, conversion.contextWindow) };
        return;
      }
    }
  }
  throw new LlmError('dsh-aperture: pi-ai 的事件流没有以 done/error 收尾', 'STREAM_CLOSED');
}

/**
 * 每个已发出块的原生元数据。
 *
 * @param message - 终态助手消息。
 * @param slots - 已发出块的 contentIndex，按首次出现顺序。
 * @returns 与已发出块一一对应的条目。
 */
function replayBlocks(message: PiAssistantMessage, slots: readonly number[]): readonly ReplayBlock[] {
  return slots.map((index) => {
    const block = message.content[index];
    if (block === undefined) return {};
    if (block.type === 'text') {
      return block.textSignature === undefined ? {} : { textSignature: block.textSignature };
    }
    if (block.type === 'thinking') {
      return {
        ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    }
    if (block.type === 'toolCall') {
      return {
        ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
        ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
      };
    }
    return {};
  });
}

/**
 * pi-ai 的用量 → 宿主的用量。
 *
 * pi-ai 把推理 token 折进 `output`（`reasoning` 只是它的细分），因此这里不重复上报；
 * 缓存字段在 pi-ai 里恒为数字，而宿主的口径是「只在真的有缓存时出现」。
 */
function mapUsage(usage: PiAssistantMessage['usage']): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  };
}

/**
 * 终态消息 → 宿主的终止原因。
 *
 * 先判溢出：pi-ai 既可能在错误文本里说溢出，也可能**成功返回**一个超出容量的请求（部分兼容
 * 端会静默接受），后者只能靠用量与容量比出来。空回答是错误而不是成功：宿主的上层会把它当作
 * 可重试的失败，而 `stop` 加上零内容一旦被当成成功，整轮对话会安静地什么都不产生。
 */
function finishReason(message: PiAssistantMessage, contextWindow: number | undefined): FinishReason {
  if (isContextOverflow(message, contextWindow)) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `dsh-aperture: 模型 "${message.model}" 超过上下文容量`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    };
  }
  if (
    message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  ) {
    return {
      kind: 'error',
      failure: { message: message.errorMessage, code: CONTEXT_WINDOW_EXCEEDED_CODE },
    };
  }

  switch (message.stopReason) {
    case 'stop':
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `dsh-aperture: 模型 "${message.model}" 正常结束却没有产出任何内容`,
            code: EMPTY_RESPONSE_CODE,
          },
        };
      }
      return { kind: 'stop' };
    case 'length':
      return { kind: 'max-tokens' };
    case 'toolUse':
      return { kind: 'tool-calls' };
    case 'aborted':
      return {
        kind: 'aborted',
        failure: { message: message.errorMessage ?? 'dsh-aperture: 流已中止', code: 'ABORTED' },
      };
    default: {
      const text = message.errorMessage
        ?? `dsh-aperture: pi-ai 的流以 "${message.stopReason}" 收尾`;
      return { kind: 'error', failure: { message: text, code: classifyMessage(text) } };
    }
  }
}

/**
 * 从错误文本里猜一个稳定的机器码。
 *
 * pi-ai 的错误路径只有一个字符串（HTTP 状态被拼进文本，没有结构化字段），而宿主的重试策略
 * 按码判断该不该重试。猜错的代价是重试策略或诊断分类不准，不是请求正确性；无法归类的都落进
 * `PI_AI_ERROR`。
 *
 * @param message - 终态错误文本。
 * @returns 稳定的机器码。
 */
function classifyMessage(message: string): string {
  if (/\b(?:401|403)\b/u.test(message)) return 'AUTH';
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
  if (/\b429\b|rate.?limit/iu.test(message)) return 'RATE_LIMIT';
  if (/\b413\b|payload too large|request body too large/iu.test(message)) return 'INVALID_REQUEST';
  if (/\b400\b|invalid.?request/iu.test(message)) return 'INVALID_REQUEST';
  if (/\b5\d\d\b/u.test(message)) return 'SERVER';
  if (/\btime(?:d)?\s*out\b|timeout/iu.test(message)) return 'TIMEOUT';
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/iu.test(message)) return 'TRANSPORT';
  if (/premature close|terminated|other side closed/iu.test(message)) return 'TRANSPORT';
  return 'PI_AI_ERROR';
}
