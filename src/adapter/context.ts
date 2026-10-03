/**
 * 请求转换：宿主的消息词汇 → pi-ai 的 `Context`。
 *
 * 这里只做结构搬运，不做语义翻译：两边的消息词汇本来就是同一套（谁先有这套词汇不重要，
 * 重要的是三种协议的线缆形状由 pi-ai 的 API 实现负责）。真正需要判断的只有四件事——
 * system 提示落在哪里、工具结果怎么认领它的工具名、推理块携带的原生签名怎么回填，以及
 * 图片怎么变成网关收得下的字节。
 *
 * 宿主在本模块之前已经替所有路由做掉了两件投影：文件块 → 文本句柄、只声明文本的模型上的
 * 图片 → 稳定的占位文本（`LlmRuntime` 的 dispatch 路径）。因此这里看到的 `file` 块只可能
 * 是宿主自己也没投影的路径，遇到就响亮拒绝，而不是悄悄丢掉。
 *
 * @module dsh-aperture/adapter/context
 */

import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  contentHasImage,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
  type GenerateOptions,
  type RequestMessage,
} from '@deepseek-ai/dsh-llm';
import {
  requestImageDimensions,
  type AttachmentStore,
  type ImageAttachmentRef,
  type RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment';
import type {
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  ImageContent,
  Message as PiMessage,
  TextContent,
  Tool as PiTool,
  ToolCall,
  ToolResultMessage as PiToolResultMessage,
  UserMessage as PiUserMessage,
} from '@earendil-works/pi-ai';
import { readReplayState, type ReplayBlock } from './replay.ts';

/**
 * 一张图片在请求里的目标版本。
 *
 * 与 `dsh-llm-pi-ai` 自己的默认值一致：4 Mi 像素的上限（等价于 2048×2048）与 1 MiB 的
 * 单张编码字节上限。网关不通过任何接口声明它接受什么，而这两个数字是当前发布物里已经被
 * 验证过的那一组。
 */
const REQUEST_IMAGE_POLICY = { maxPixels: 4_194_304, maxBytes: 1_048_576 } as const;

/** 一次请求里图片累积后的 base64 字节上限；超过就要求上层先卸载最旧的几张。 */
const MAX_REQUEST_IMAGE_BYTES = 20_971_520;

/** 转换一张图片所需的东西。 */
export interface ImageConversion {
  /** 附件服务；没有它的部署里图片无法转换。 */
  readonly attachments: AttachmentStore;
  /** 取消信号，透传给附件的转换。 */
  readonly signal?: AbortSignal;
}

/**
 * 把一次请求的历史转成 pi-ai 的 `Context`。
 *
 * @param options - 完整请求。
 * @param images - 图片转换所需的附件服务；缺失时任何图片都按不可用处理。
 * @param onDegrade - 观察到一条历史因为重放元数据不可用而降级时调用。
 * @returns pi-ai 的请求上下文。
 * @throws LlmError 历史里有无法表示的块、缺附件服务、或图片超出请求预算时。
 */
export async function toPiContext(
  options: GenerateOptions,
  images?: ImageConversion,
  onDegrade?: (reason: string) => void,
): Promise<PiContext> {
  assertSupportedHistory(options.messages);
  const split = splitSystemPrompt(options);

  const requestImages =
    images === undefined ? undefined : await prepareRequestImages(split.messages, images);
  if (requestImages !== undefined) {
    const offloadImages = requiredImageOffload(
      split.messages,
      { representation: 'base64', maxBytes: MAX_REQUEST_IMAGE_BYTES },
      (block) => requestImages.get(block.attachment.attachmentId)?.bytes ?? 0,
    );
    if (offloadImages > 0) {
      throw new LlmError(
        `dsh-aperture: 请求里的图片超过 ${MAX_REQUEST_IMAGE_BYTES} 字节的 base64 上限；`
        + `还需要卸载最旧的 ${offloadImages} 张。`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages },
      );
    }
  }

  const exact = requestImages === undefined
    ? split.messages
    : projectOffloadedImages(split.messages, (ref) => offloadedImageText(ref));

  const toolNames = new Map<string, string>();
  const messages: PiMessage[] = [];
  for (const message of exact) {
    if (message.role === 'system') {
      // 只有首位 system 会被上面取成 systemPrompt；走到这里的都是历史中段的系统提示，
      // pi-ai 的三种协议都没有「中途改系统提示」这个概念，于是降级成一条 user 消息。
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 });
      continue;
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, onDegrade);
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name);
      }
      messages.push(assistant);
      continue;
    }
    if (message.role === 'tool') {
      messages.push(toolResultOf(message, toolNames, userContent(message.content, requestImages)));
      continue;
    }
    if (message.role === 'developer') {
      // 宿主已经把当前路由不支持的 developer 更新投影掉了；真漏进来就说明投影契约变了。
      throw new LlmError('dsh-aperture: 不支持 developer 消息', 'UNSUPPORTED_CONTENT');
    }
    messages.push({ role: 'user', content: userContent(message.content, requestImages), timestamp: 0 });
  }

  const tools = toolsOf(options);
  return {
    ...(split.systemPrompt === undefined ? {} : { systemPrompt: split.systemPrompt }),
    messages,
    ...(tools === undefined ? {} : { tools }),
  };
}

/** 拒绝任何无法表示的块，而不是把它们悄悄丢掉。 */
function assertSupportedHistory(messages: readonly RequestMessage[]): void {
  for (const message of messages) {
    if (message.content.some((block) => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      throw new LlmError('dsh-aperture: 工具变更块不在本次请求里表示', 'UNSUPPORTED_CONTENT');
    }
    if (message.role === 'developer') {
      throw new LlmError('dsh-aperture: 不支持 developer 消息', 'UNSUPPORTED_CONTENT');
    }
    if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
      throw new LlmError(
        `dsh-aperture: pi-ai 无法表示 ${message.role} 消息里的图片`,
        'UNSUPPORTED_CONTENT',
      );
    }
    if (message.content.some((block) => block.type === 'file')) {
      throw new LlmError('dsh-aperture: 文件块没有被投影成文本', 'UNSUPPORTED_CONTENT');
    }
  }
}

/**
 * 选出 system 提示。
 *
 * 一次性调用者把提示放在 `system` 字段里；循环构造的请求把它作为首位 `system` 消息放在历史
 * 里。两种都在这里归一。`system` 字段一旦存在就由它独占提示位，历史里的 `system` 消息一律
 * 降级——否则同一段提示会进两次。
 */
function splitSystemPrompt(options: GenerateOptions): {
  systemPrompt?: string;
  messages: readonly RequestMessage[];
} {
  if (options.system !== undefined) {
    return { systemPrompt: options.system, messages: options.messages };
  }
  const [first, ...rest] = options.messages;
  if (first?.role !== 'system') {
    return { messages: options.messages };
  }
  const text = flattenText(first);
  return {
    ...(text.length === 0 ? {} : { systemPrompt: text }),
    messages: rest,
  };
}

/** 把一个 harness 消息的文本块拼成一段文本。 */
function flattenText(message: RequestMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** 转换一条工具结果消息。 */
function toolResultOf(
  message: Extract<RequestMessage, { role: 'tool' }>,
  toolNames: ReadonlyMap<string, string>,
  content: string | (TextContent | ImageContent)[],
): PiToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: toolNames.get(message.toolCallId) ?? 'unknown',
    // 空输出要有话说：pi-ai 的 Anthropic 路径会拒绝空内容块数组，而一次「命令没有输出」正是
    // 最常见的空结果。
    content: typeof content === 'string' ? [{ type: 'text', text: content || '(no output)' }] : content,
    isError: message.isError ?? false,
    timestamp: 0,
  };
}

/** 把工具声明转成 pi-ai 的形状；没有任何工具时整个字段省略。 */
function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  if (options.tools === undefined || options.tools.length === 0) {
    return undefined;
  }
  if (options.tools.some((tool) => tool.deferLoading === true)) {
    throw new LlmError('dsh-aperture: 不支持延迟加载的工具声明', 'UNSUPPORTED_CONTENT');
  }
  return options.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * 转换一条 user/tool 消息的内容。
 *
 * 全是文本时给字符串——这是 pi-ai 侧最省事的形状，也让「一条只有文本的用户消息」在请求体里
 * 与手写的 OpenAI 请求看起来一样。
 */
function userContent(
  content: RequestMessage['content'],
  requestImages: ReadonlyMap<string, RequestImageAttachment> | undefined,
): string | (TextContent | ImageContent)[] {
  const converted: (TextContent | ImageContent)[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.length > 0) converted.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type !== 'image') continue;
    const version = requestImages?.get(block.attachment.attachmentId);
    if (version === undefined) {
      throw new LlmError(
        'dsh-aperture: 这条请求带图片，但没有可用的附件服务来转换它们',
        'UNSUPPORTED_CONTENT',
      );
    }
    converted.push({ type: 'text', text: requestImageHandleText(block.attachment, version) });
    converted.push({
      type: 'image',
      data: Buffer.from(version.data).toString('base64'),
      mimeType: version.mediaType,
    });
  }
  if (converted.every((block) => block.type === 'text')) {
    return converted.map((block) => block.text).join('');
  }
  return converted;
}

/** 收集并转换本次请求用到的所有图片。 */
async function prepareRequestImages(
  messages: readonly RequestMessage[],
  images: ImageConversion,
): Promise<ReadonlyMap<string, RequestImageAttachment>> {
  const refs = new Map<string, ImageAttachmentRef>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'image') continue;
      if (block.offloaded === true) continue;
      refs.set(block.attachment.attachmentId, block.attachment);
    }
  }
  const ordered = [...refs.values()];
  const prepared = await Promise.all(
    ordered.map((ref) => images.attachments.readImageRequest(ref, requestImageTarget(ref), images.signal)),
  );
  const versions = new Map<string, RequestImageAttachment>();
  for (const [index, ref] of ordered.entries()) {
    versions.set(ref.attachmentId, prepared[index]!);
  }
  return versions;
}

/** 一张图片在本次请求里的目标尺寸。 */
function requestImageTarget(ref: ImageAttachmentRef): { width: number; height: number; maxBytes: number } {
  return {
    ...requestImageDimensions(ref.width, ref.height, REQUEST_IMAGE_POLICY.maxPixels),
    maxBytes: REQUEST_IMAGE_POLICY.maxBytes,
  };
}

/**
 * 转换一条 assistant 历史消息。
 *
 * 原生重放元数据（Anthropic 的 thinking 签名、OpenAI Responses 的 message id 与 reasoning
 * item）只在本适配器自己生产、且路由与模型都对得上时才回填。版本更早的部署把同一条路由交给
 * `llm-pi-ai` 服务过，它的重放信封在这里读不出来——那时整条消息降级为 provider 中立的内容：
 * 思考块丢掉（没有签名的思考块会被 Anthropic 拒绝），文本与工具调用照旧。
 */
function toPiAssistant(
  message: Extract<RequestMessage, { role: 'assistant' }>,
  onDegrade?: (reason: string) => void,
): PiAssistantMessage {
  const replay = readReplayState(message.source.replayState);
  if (replay === undefined && message.source.replayState !== undefined) {
    onDegrade?.('重放元数据不可用');
  }
  const blocks = replay?.blocks;
  const content: PiAssistantMessage['content'] = [];
  let index = 0;
  for (const block of message.content) {
    const signature = blocks?.[index];
    index += 1;
    if (block.type === 'text') {
      content.push({
        type: 'text',
        text: block.text,
        ...(signature?.textSignature === undefined ? {} : { textSignature: signature.textSignature }),
      });
      continue;
    }
    if (block.type === 'reasoning') {
      if (replay === undefined || !hasThinkingSignature(signature)) continue;
      content.push({
        type: 'thinking',
        thinking: block.text,
        ...(signature.thinkingSignature === undefined ? {} : { thinkingSignature: signature.thinkingSignature }),
        ...(signature.redacted === undefined ? {} : { redacted: signature.redacted }),
      });
      continue;
    }
    if (block.type === 'tool-call') {
      content.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
        ...(signature?.thoughtSignature === undefined ? {} : { thoughtSignature: signature.thoughtSignature }),
        ...(signature?.namespace === undefined ? {} : { namespace: signature.namespace }),
      });
    }
  }
  return {
    role: 'assistant',
    content,
    api: replay?.response.api ?? 'dsh-foreign',
    provider: replay?.response.provider ?? 'dsh-foreign',
    model: replay?.response.model ?? message.source.model,
    ...(replay?.response.responseId === undefined ? {} : { responseId: replay.response.responseId }),
    ...(replay?.response.responseModel === undefined
      ? {}
      : { responseModel: replay.response.responseModel }),
    ...(replay?.response.providerThinkingLevel === undefined
      ? {}
      : { providerThinkingLevel: replay.response.providerThinkingLevel }),
    usage: ZERO_USAGE,
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  };
}

/** 一个块是否带着可回填的思考签名。 */
function hasThinkingSignature(block: ReplayBlock | undefined): block is ReplayBlock {
  return block?.thinkingSignature !== undefined || block?.redacted === true;
}

/**
 * 工具参数是裸 JSON 字符串；pi-ai 的历史消息里要的是对象。
 *
 * 解析不了就抛：这条历史是模型自己产出的，解析不了说明记录被改过，静默替换成 `{}` 会把一次
 * 工具调用悄悄改成另一次。
 */
function parseArguments(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    throw new LlmError(
      `dsh-aperture: 历史里的工具参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      'INVALID_REPLAY_STATE',
    );
  }
}

/** 历史消息里的用量不参与任何计价，一律清零。 */
const ZERO_USAGE: PiAssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 供流式转换复用的空用量，语义同 {@link ZERO_USAGE}。 */
export const EMPTY_USAGE = ZERO_USAGE;
