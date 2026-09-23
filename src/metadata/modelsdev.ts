/**
 * models.dev 清单的索引与查找。
 *
 * Aperture 会上报容量，但并不总是上报能力，而且在大多数 provider 上，其列表
 * 根本没有「这个模型是否会推理」的字段。models.dev 为同样的模型携带 `reasoning`、
 * `tool_call` 和输入模态，但 id 只是有时逐字节相同：网关会重命名上游（这里是
 * `x-ai/grok-4.5`，那里是 `xai/grok-4.5`），而其别名完全不带厂商前缀（`k3`）。
 *
 * 因此查找是评分式的，而非精确匹配。模型 id 按完整写法、按最后一个斜杠之后的
 * 分段、以及两者折叠标点后的 slug 来匹配；一个清单条目贡献同样的三个键；而两侧
 * 匹配上的 provider 别名优先于任何键得分，因为跨厂商的重名正是孤立的模型 id
 * 唯一会说谎的地方。
 *
 * @module dsh-aperture/metadata/modelsdev
 */

import type { CatalogLookup, CatalogMetadata, Modality } from '../types.ts';
import { asRecord, firstPositiveInteger, firstString, normalizeKey, slugKey, stringValue, suffixAfterSlash } from './utils.ts';

/** 一个已索引的清单条目。 */
interface CatalogEntry {
  readonly modelId: string;
  readonly modelName?: string;
  readonly providerAliases: readonly string[];
  readonly metadata: CatalogMetadata;
}

/** 一个已索引条目及其键所携带的得分。 */
interface ScoredEntry {
  readonly entry: CatalogEntry;
  readonly keyScore: number;
}

/** provider 别名匹配优先于任何键匹配。 */
const PROVIDER_ALIAS_BONUS = 200;

/** 已索引的 models.dev 清单，按单个模型的 id 与 provider 提示查询。 */
export class ModelCatalogIndex {
  private readonly byKey = new Map<string, ScoredEntry[]>();
  private readonly entries: readonly CatalogEntry[];

  /**
   * @param entries - 每一个可用的清单条目。
   */
  constructor(entries: readonly CatalogEntry[]) {
    this.entries = entries;
    for (const entry of entries) {
      for (const { key, score } of entryKeys(entry)) {
        const bucket = this.byKey.get(key);
        if (bucket === undefined) {
          this.byKey.set(key, [{ entry, keyScore: score }]);
        } else {
          bucket.push({ entry, keyScore: score });
        }
      }
    }
  }

  /** 该索引持有的可用条目数量。 */
  get size(): number {
    return this.entries.length;
  }

  /**
   * 为一个网关模型解析出最佳清单条目。
   * @param modelId - 网关公布的 id。
   * @param providerHints - 网关上报的上游 provider id 与名称。
   * @returns 胜出条目的元数据；无任何匹配时为 `undefined`。
   */
  lookup(modelId: string, providerHints: readonly string[] = []): CatalogMetadata | undefined {
    const candidates = new Map<CatalogEntry, number>();
    for (const { key, score } of lookupKeys(modelId)) {
      for (const scored of this.byKey.get(key) ?? []) {
        const current = candidates.get(scored.entry) ?? 0;
        candidates.set(scored.entry, Math.max(current, score + scored.keyScore));
      }
    }

    const hintAliases = providerHints.flatMap((hint) => providerAliases(hint));
    const modelProviderAliases = providerAliases(modelId.split('/')[0] ?? '');

    let best: { entry: CatalogEntry; score: number } | undefined;
    for (const [entry, baseScore] of candidates) {
      const providerScore =
        matchingAliasScore(entry.providerAliases, hintAliases) ||
        matchingAliasScore(entry.providerAliases, modelProviderAliases);
      const score = baseScore + providerScore;
      if (best === undefined || score > best.score) {
        best = { entry, score };
      }
    }
    return best === undefined ? undefined : { ...best.entry.metadata };
  }
}

/**
 * 在一份已解析的 models.dev 文档之上构建查找。
 *
 * 接受该文档发布过的所有形态：当前扁平的 `{ "<provider>/<model>": { … } }` 映射、
 * 值携带 `models` 的旧式 provider 键映射，以及在 `providers` 或 `models` 之下
 * 暴露上述任一形态的包装对象。
 *
 * @param document - 已解析的 JSON，或任何其他值。
 * @returns 该查找；文档不含可用条目时为 `undefined`。
 */
export function buildCatalogLookup(document: unknown): CatalogLookup | undefined {
  const index = buildCatalogIndex(document);
  if (index === undefined) {
    return undefined;
  }
  return (model) => index.lookup(model.id, providerHintsOf(model));
}

/** 仅构建索引，并暴露其大小以用于诊断。 */
export function buildCatalogIndex(document: unknown): ModelCatalogIndex | undefined {
  const entries = readEntries(document);
  return entries.length === 0 ? undefined : new ModelCatalogIndex(entries);
}

/** 一次查找可用于评分的 provider 提示。 */
function providerHintsOf(model: { id: string; provider?: string; providerName?: string }): string[] {
  const hints = [model.provider, model.providerName, model.id.includes('/') ? model.id.split('/')[0] : undefined];
  return [...new Set(hints.filter((hint): hint is string => typeof hint === 'string' && hint.trim().length > 0))];
}

/** 从一份清单文档中读取每一个可用条目。 */
function readEntries(document: unknown): CatalogEntry[] {
  const root = asRecord(document);
  if (!root) {
    return [];
  }

  const providers = asRecord(root.providers);
  if (providers) {
    return readProviderMap(providers);
  }
  const models = asRecord(root.models);
  if (models) {
    return readModelMap(models);
  }

  // 扁平文档：通过观察各值是否携带 `models` 容器，区分「provider → { models }」
  // 与「模型键 → 模型」。models.dev 实际发布的文档是第二种形态。
  const providerShaped = Object.values(root).some((value) => asRecord(asRecord(value)?.models) !== undefined);
  return providerShaped ? readProviderMap(root) : readModelMap(root);
}

/** 读取以 provider 为键的映射，并从其 provider 推导每个模型的别名。 */
function readProviderMap(providers: Record<string, unknown>): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const [providerKey, providerValue] of Object.entries(providers)) {
    const provider = asRecord(providerValue);
    const models = asRecord(provider?.models);
    if (!provider || !models) {
      continue;
    }
    const aliases = providerAliases(providerKey, stringValue(provider.id), stringValue(provider.name));
    for (const [modelKey, modelValue] of Object.entries(models)) {
      const entry = readModelEntry(modelKey, modelValue, aliases);
      if (entry) {
        entries.push(entry);
      }
    }
  }
  return entries;
}

/** 读取模型键 → 模型条目的映射，并从该键推导 provider 别名。 */
function readModelMap(models: Record<string, unknown>): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const [modelKey, modelValue] of Object.entries(models)) {
    const model = asRecord(modelValue);
    if (!model) {
      continue;
    }
    const modelId = firstString([model.id, modelKey]) ?? modelKey;
    const providerId = modelId.includes('/') ? (modelId.split('/')[0] ?? '') : '';
    const entry = readModelEntry(modelKey, model, providerAliases(providerId));
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

/** 读取一个清单条目；未给出任何可用信息时为 `undefined`。 */
function readModelEntry(modelKey: string, value: unknown, aliases: readonly string[]): CatalogEntry | undefined {
  const model = asRecord(value);
  if (!model) {
    return undefined;
  }
  const metadata = readModelMetadata(model);
  if (metadata === undefined) {
    return undefined;
  }
  const modelId = firstString([model.id, modelKey]) ?? modelKey;
  const modelName = firstString([model.name, model.display_name]);
  return {
    modelId,
    ...(modelName === undefined ? {} : { modelName }),
    providerAliases: aliases,
    metadata,
  };
}

/** 读取一个 models.dev 条目所贡献的元数据。 */
function readModelMetadata(model: Record<string, unknown>): CatalogMetadata | undefined {
  const limit = asRecord(model.limit);
  const topProvider = asRecord(model.top_provider);
  const modalities = asRecord(model.modalities);

  const contextWindow = firstPositiveInteger([
    model.contextWindow,
    model.context_window,
    model.context_length,
    model.max_input_tokens,
    limit?.context,
    limit?.input,
  ]);
  const maxTokens = firstPositiveInteger([
    model.maxOutputTokens,
    model.max_output_tokens,
    model.maxTokens,
    model.max_tokens,
    limit?.output,
    topProvider?.max_completion_tokens,
  ]);
  const reasoning = typeof model.reasoning === 'boolean' ? model.reasoning : undefined;
  const input = readInputModalities(model, modalities);
  const name = firstString([model.name, model.display_name]);

  if (
    contextWindow === undefined &&
    maxTokens === undefined &&
    reasoning === undefined &&
    input === undefined &&
    name === undefined
  ) {
    return undefined;
  }

  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(input === undefined ? {} : { input }),
    ...(name === undefined ? {} : { name }),
  };
}

/** 读取清单条目声明的输入模态。 */
function readInputModalities(
  model: Record<string, unknown>,
  modalities: Record<string, unknown> | undefined,
): Modality[] | undefined {
  const list = modalities?.input ?? model.input;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const declared = new Set<Modality>();
  for (const entry of list) {
    const label = stringValue(entry)?.toLowerCase();
    if (label === 'text') {
      declared.add('text');
    } else if (label === 'image' || label === 'vision') {
      declared.add('image');
    }
  }
  return declared.size === 0 ? undefined : [...declared];
}

/** 一个清单条目贡献的每一个索引键及其得分。 */
function entryKeys(entry: CatalogEntry): Array<{ key: string; score: number }> {
  const values = [entry.modelId, suffixAfterSlash(entry.modelId), entry.modelName];
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
    .flatMap((value) => [
      { key: normalizeKey(value), score: 40 },
      { key: slugKey(value), score: 30 },
    ])
    .filter((item) => item.key.length > 0);
}

/** 一个网关模型 id 被查询时使用的每一个查找键及其权重。 */
function lookupKeys(modelId: string): Array<{ key: string; score: number }> {
  const suffix = suffixAfterSlash(modelId);
  return [
    { value: modelId, score: 70 },
    { value: suffix, score: 80 },
  ]
    .flatMap(({ value, score }) => [
      { key: normalizeKey(value), score },
      { key: slugKey(value), score: score - 10 },
    ])
    .filter((item) => item.key.length > 0);
}

/** 一个 provider id 或名称响应的每一个别名写法。 */
function providerAliases(...values: readonly (string | undefined)[]): string[] {
  const aliases = new Set<string>();
  for (const value of values) {
    const slug = slugKey(value);
    if (!slug) {
      continue;
    }
    aliases.add(slug);
    aliases.add(slug.replace(/-?ai$/u, ''));
    aliases.add(slug.replace(/-?api$/u, ''));
    aliases.add(slug.replace(/-?cloud$/u, ''));
  }

  const normalized = new Set<string>();
  for (const alias of aliases) {
    if (!alias) {
      continue;
    }
    normalized.add(alias);
    switch (alias) {
      case 'google-ai-studio':
      case 'google-generative-ai':
        normalized.add('google');
        break;
      case 'deepseek-ai':
        normalized.add('deepseek');
        break;
      case 'x-ai':
        normalized.add('xai');
        break;
      case 'moonshot':
      case 'moonshot-ai':
        normalized.add('moonshotai');
        break;
      case 'xiaomi':
      case 'xiaomi-mimo':
        normalized.add('xiaomimimo');
        break;
      default:
        break;
    }
  }
  return [...normalized];
}

/** 对两个别名集评分：任何交集都算一次 provider 匹配。 */
function matchingAliasScore(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  return left.some((alias) => rightSet.has(alias)) ? PROVIDER_ALIAS_BONUS : 0;
}
