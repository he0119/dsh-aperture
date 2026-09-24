/**
 * 提取 Aperture 模型条目对自身所述的事实。
 *
 * 网关的列表是容量的权威来源：它知道每个上游之前的代理会接受什么，并且在上游
 * 更换模型时依然正确。因此每个字段都会列出网关被观察到使用过的所有写法，第一个
 * 成立的答案胜出。
 *
 * 下面的写法是参考 VS Code 扩展清单的超集，再加上本插件在真实 Aperture 实例上
 * 实际观察到的几个（`context_window_tokens`、`max_output_tokens`、`display_name`），
 * 参考的清单早于它们。
 *
 * @module dsh-aperture/metadata/extract
 */

import type { Modality } from '../types.ts';
import { asRecord, firstBoolean, firstPositiveInteger, firstString, stringValue } from './utils.ts';

/** 一个模型条目所述的容量事实。 */
export interface ExtractedLimits {
  /** 请求与响应合计的最大上下文窗口，条目给出时才有。 */
  contextWindow?: number;
  /** 最大输出 token 数，条目给出时才有。 */
  maxTokens?: number;
}

/** 一个模型条目所述的能力事实。 */
export interface ExtractedCapabilities {
  /** 条目是否声称支持推理强度控制。 */
  reasoning?: boolean;
  /** 条目是否声称支持工具调用。 */
  toolCalling?: boolean;
  /** 条目声称的请求模态。 */
  input?: Modality[];
}

/** 每个 Aperture 条目可能用来藏匿其事实的嵌套容器。 */
function containers(record: Record<string, unknown>): {
  metadata: Record<string, unknown> | undefined;
  capabilities: Record<string, unknown> | undefined;
  metadataCapabilities: Record<string, unknown> | undefined;
  limit: Record<string, unknown> | undefined;
  limits: Record<string, unknown> | undefined;
  modalities: Record<string, unknown> | undefined;
} {
  const metadata = asRecord(record.metadata);
  return {
    metadata,
    capabilities: asRecord(record.capabilities),
    metadataCapabilities: asRecord(metadata?.capabilities),
    limit: asRecord(record.limit),
    limits: asRecord(record.limits),
    modalities: asRecord(record.modalities),
  };
}

/**
 * 读取一个条目所述的容量，可位于顶层，或嵌套在 `metadata`、`limit`、`limits`
 * 之下。
 *
 * @param value - 一条原始模型条目。
 * @returns 所述的容量；两者都未给出时为 `undefined`。
 */
export function extractLimits(value: unknown): ExtractedLimits | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const { metadata, limit, limits } = containers(record);
  const metadataLimit = asRecord(metadata?.limit);
  const metadataLimits = asRecord(metadata?.limits);

  const contextWindow = firstPositiveInteger([
    // 在真实 Aperture 列表上观察到的。
    record.context_window_tokens,
    record.max_context_tokens,
    // 参考扩展的写法。
    record.maxInputTokens,
    record.max_input_tokens,
    record.input_token_limit,
    limit?.input,
    limits?.input,
    metadata?.maxInputTokens,
    metadata?.max_input_tokens,
    metadata?.input_token_limit,
    metadataLimit?.input,
    metadataLimits?.input,
    record.context_length,
    record.max_context_length,
    record.context_window,
    limit?.context,
    limits?.context,
    metadata?.context_length,
    metadata?.max_context_length,
    metadata?.context_window,
    metadata?.max_context_tokens,
    metadata?.context_window_tokens,
    metadataLimit?.context,
    metadataLimits?.context,
  ]);

  const maxTokens = firstPositiveInteger([
    record.max_output_tokens,
    record.maxOutputTokens,
    record.output_token_limit,
    record.max_completion_tokens,
    limit?.output,
    limits?.output,
    metadata?.max_output_tokens,
    metadata?.maxOutputTokens,
    metadata?.output_token_limit,
    metadata?.max_completion_tokens,
    metadataLimit?.output,
    metadataLimits?.output,
  ]);

  if (contextWindow === undefined && maxTokens === undefined) {
    return undefined;
  }
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

/** 读取条目所述的显示名（`display_name` 是 Aperture 的写法）。 */
export function extractDisplayName(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const metadata = asRecord(record.metadata);
  return firstString([record.display_name, record.displayName, record.name, metadata?.display_name, metadata?.name]);
}

/** 读取条目公布的端点路径。 */
export function extractEndpoints(value: unknown): string[] {
  const record = asRecord(value);
  const raw = record?.supported_endpoints;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    const path = stringValue(entry);
    return path === undefined ? [] : [path];
  });
}

/** 读取条目上报的上游 provider 身份。 */
export function extractProvider(value: unknown): { id?: string; name?: string } | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const metadata = asRecord(record.metadata);
  const provider = asRecord(metadata?.provider);
  const id = firstString([provider?.id, record.owned_by, metadata?.provider_id]);
  const name = firstString([provider?.name, metadata?.provider_name]);
  if (id === undefined && name === undefined) {
    return undefined;
  }
  return { ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }) };
}

/**
 * 读取一个条目所述的能力事实。
 *
 * `reasoning: true` 是参考扩展与 models.dev 的信号；`thinking` 标志和嵌套的
 * `capabilities` 块则是网关自己的词汇。视觉能力从 `modalities.input` 列表以及
 * `vision` / `supports_vision` 写法读取。
 *
 * @param value - 一条原始模型条目。
 * @returns 所述的能力；未给出任何能力时为 `undefined`。
 */
export function extractCapabilities(value: unknown): ExtractedCapabilities | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const { metadata, capabilities, metadataCapabilities, modalities } = containers(record);

  const reasoning =
    firstBoolean([
      record.reasoning,
      record.thinking,
      capabilities?.reasoning,
      capabilities?.thinking,
      metadata?.reasoning,
      metadata?.thinking,
      metadataCapabilities?.reasoning,
      metadataCapabilities?.thinking,
    ]) ?? undefined;

  const toolCalling =
    firstBoolean([
      record.tool_call,
      record.toolCalling,
      capabilities?.tool_call,
      capabilities?.toolCalling,
      metadata?.tool_call,
      metadata?.toolCalling,
      metadataCapabilities?.tool_call,
      metadataCapabilities?.toolCalling,
    ]) ?? undefined;

  const input = extractInput(record, metadata, capabilities, metadataCapabilities, modalities);

  if (reasoning === undefined && toolCalling === undefined && input === undefined) {
    return undefined;
  }
  return {
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(toolCalling === undefined ? {} : { toolCalling }),
    ...(input === undefined ? {} : { input }),
  };
}

/** 从两个清单使用的所有写法中读取声明的请求模态。 */
function extractInput(
  record: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
  capabilities: Record<string, unknown> | undefined,
  metadataCapabilities: Record<string, unknown> | undefined,
  modalities: Record<string, unknown> | undefined,
): Modality[] | undefined {
  const lists = [
    record.input,
    record.input_modalities,
    modalities?.input,
    asRecord(metadata?.modalities)?.input,
    metadata?.input,
    metadata?.input_modalities,
  ];
  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    const declared: Modality[] = [];
    for (const entry of list) {
      const label = stringValue(entry)?.toLowerCase();
      if (label === 'text' || label === 'image' || label === 'vision') {
        declared.push(label === 'text' ? 'text' : 'image');
      }
    }
    if (declared.length > 0) {
      return [...new Set(declared)];
    }
  }

  const vision = firstBoolean([
    record.vision,
    record.supports_vision,
    capabilities?.vision,
    capabilities?.image,
    metadata?.vision,
    metadata?.supports_vision,
    metadataCapabilities?.vision,
    metadataCapabilities?.image,
  ]);
  if (vision === true) {
    return ['text', 'image'];
  }
  if (vision === false) {
    return ['text'];
  }
  return undefined;
}

/** 一个条目究竟是不是可用的模型行。 */
export function extractModelId(value: unknown): string | undefined {
  const record = asRecord(value);
  return record === undefined ? undefined : stringValue(record.id);
}
