/**
 * Extraction of the facts an Aperture model entry states about itself.
 *
 * The gateway's listing is the authority for capacities: it knows what the
 * proxy in front of each upstream will accept, and it stays right when a model
 * is swapped upstream. So every field names as many spellings as the gateway
 * has been seen to use, and the first positive answer wins.
 *
 * The spellings below are a superset of the reference VS Code extension's list
 * plus the ones this plugin actually observed on a live Aperture instance
 * (`context_window_tokens`, `max_output_tokens`, `display_name`), which the
 * reference's list predates.
 *
 * @module dsh-aperture/metadata/extract
 */

import type { Modality } from '../types.ts';
import { asRecord, firstBoolean, firstPositiveInteger, firstString, stringValue } from './utils.ts';

/** Capacity facts one model entry states. */
export interface ExtractedLimits {
  /** Maximum combined request and response context, when the entry states one. */
  contextWindow?: number;
  /** Maximum output tokens, when the entry states one. */
  maxTokens?: number;
}

/** Capability facts one model entry states. */
export interface ExtractedCapabilities {
  /** Whether the entry claims reasoning-effort control. */
  reasoning?: boolean;
  /** Whether the entry claims tool calling. */
  toolCalling?: boolean;
  /** Request modalities the entry claims. */
  input?: Modality[];
}

/** The nested containers every Aperture entry may hide its facts in. */
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
 * Read the capacities one entry states, at the top level or nested under
 * `metadata`, `limit`, or `limits`.
 *
 * @param value - one raw model entry.
 * @returns the stated capacities, or `undefined` when it states neither.
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
    // Observed on a live Aperture listing.
    record.context_window_tokens,
    record.max_context_tokens,
    // The reference extension's spellings.
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

/** Read the display name an entry states (`display_name` is Aperture's spelling). */
export function extractDisplayName(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const metadata = asRecord(record.metadata);
  return firstString([record.display_name, record.displayName, record.name, metadata?.display_name, metadata?.name]);
}

/** Read the endpoint paths an entry advertises. */
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

/** Read the upstream provider identity an entry reports. */
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
 * Read the capability facts one entry states.
 *
 * `reasoning: true` is the reference extension's signal and models.dev's; a
 * `thinking` flag and a nested `capabilities` block are the gateway's own
 * vocabulary. Vision is read from a `modalities.input` list and from the
 * `vision` / `supports_vision` spellings.
 *
 * @param value - one raw model entry.
 * @returns the stated capabilities, or `undefined` when it states none.
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

/** Read declared request modalities from every spelling the two catalogs use. */
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

/** Whether one entry is a usable model row at all. */
export function extractModelId(value: unknown): string | undefined {
  const record = asRecord(value);
  return record === undefined ? undefined : stringValue(record.id);
}

/** Read the pricing summary the reference extension renders into one detail line. */
export function extractPricingDetail(value: unknown): string | undefined {
  const record = asRecord(value);
  const pricing = asRecord(record?.pricing);
  if (!pricing) {
    return undefined;
  }
  const input = stringValue(pricing.input);
  const output = stringValue(pricing.output);
  if (!input && !output) {
    return undefined;
  }
  return `in ${input ?? '?'} / out ${output ?? '?'}`;
}
