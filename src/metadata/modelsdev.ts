/**
 * models.dev catalog indexing and lookup.
 *
 * Aperture reports capacities but not always capabilities, and its listing has
 * no field at all for "does this model reason" on most providers. models.dev
 * carries `reasoning`, `tool_call`, and input modalities for the same models
 * under ids that only sometimes match byte-for-byte: the gateway renames
 * upstreams (`x-ai/grok-4.5` here, `xai/grok-4.5` there) and its aliases carry
 * no vendor prefix at all (`k3`).
 *
 * So lookup is scored rather than exact. A model id is matched by its full
 * spelling, by its segment after the last slash, and by a punctuation-collapsed
 * slug of either; a catalog entry contributes the same three keys; and a
 * provider alias that matches between the two sides outranks every key score,
 * because a name collision across vendors is the one way a lone model id lies.
 *
 * @module dsh-aperture/metadata/modelsdev
 */

import type { CatalogLookup, CatalogMetadata, Modality } from '../types.ts';
import { asRecord, firstPositiveInteger, firstString, normalizeKey, slugKey, stringValue, suffixAfterSlash } from './utils.ts';

/** One indexed catalog entry. */
interface CatalogEntry {
  readonly modelId: string;
  readonly modelName?: string;
  readonly providerAliases: readonly string[];
  readonly metadata: CatalogMetadata;
}

/** One indexed entry with the score its key carries. */
interface ScoredEntry {
  readonly entry: CatalogEntry;
  readonly keyScore: number;
}

/** Provider-alias match outranks every key match. */
const PROVIDER_ALIAS_BONUS = 200;

/** Indexed models.dev catalog, queried by one model's id and provider hints. */
export class ModelCatalogIndex {
  private readonly byKey = new Map<string, ScoredEntry[]>();
  private readonly entries: readonly CatalogEntry[];

  /**
   * @param entries - every usable catalog entry.
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

  /** Number of usable entries this index holds. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Resolve the best catalog entry for one gateway model.
   * @param modelId - the id the gateway advertises.
   * @param providerHints - upstream provider ids and names the gateway reports.
   * @returns the winning entry's metadata, or `undefined` when nothing matched.
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
 * Build a lookup over a parsed models.dev document.
 *
 * Accepts every shape the document has shipped in: the current flat
 * `{ "<provider>/<model>": { … } }` map, an older provider-keyed map whose
 * values carry `models`, and a wrapper exposing either under `providers` or
 * `models`.
 *
 * @param document - parsed JSON, or anything else.
 * @returns the lookup, or `undefined` when the document holds no usable entry.
 */
export function buildCatalogLookup(document: unknown): CatalogLookup | undefined {
  const index = buildCatalogIndex(document);
  if (index === undefined) {
    return undefined;
  }
  return (model) => index.lookup(model.id, providerHintsOf(model));
}

/** Build the index alone, exposing its size for diagnostics. */
export function buildCatalogIndex(document: unknown): ModelCatalogIndex | undefined {
  const entries = readEntries(document);
  return entries.length === 0 ? undefined : new ModelCatalogIndex(entries);
}

/** The provider hints a lookup may score against. */
function providerHintsOf(model: { id: string; provider?: string; providerName?: string }): string[] {
  const hints = [model.provider, model.providerName, model.id.includes('/') ? model.id.split('/')[0] : undefined];
  return [...new Set(hints.filter((hint): hint is string => typeof hint === 'string' && hint.trim().length > 0))];
}

/** Read every usable entry from one catalog document. */
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

  // Flat document: distinguish "provider → { models }" from "model key → model"
  // by looking at whether the values carry a `models` container. The shipped
  // models.dev document is the second shape.
  const providerShaped = Object.values(root).some((value) => asRecord(asRecord(value)?.models) !== undefined);
  return providerShaped ? readProviderMap(root) : readModelMap(root);
}

/** Read a provider-keyed map, deriving each model's aliases from its provider. */
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

/** Read a map of model key → model entry, deriving provider aliases from the key. */
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

/** Read one catalog entry, or `undefined` when it states nothing usable. */
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

/** Read the metadata one models.dev entry contributes. */
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

/** Read input modalities a catalog entry declares. */
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

/** Every index key one catalog entry contributes, with its score. */
function entryKeys(entry: CatalogEntry): Array<{ key: string; score: number }> {
  const values = [entry.modelId, suffixAfterSlash(entry.modelId), entry.modelName];
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
    .flatMap((value) => [
      { key: normalizeKey(value), score: 40 },
      { key: slugKey(value), score: 30 },
    ])
    .filter((item) => item.key.length > 0);
}

/** Every lookup key one gateway model id is queried under, with its weight. */
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

/** Every alias spelling one provider id or name answers to. */
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

/** Score two alias sets: any intersection is a provider match. */
function matchingAliasScore(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  return left.some((alias) => rightSet.has(alias)) ? PROVIDER_ALIAS_BONUS : 0;
}
