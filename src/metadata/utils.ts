/**
 * Aperture 与 models.dev 返回的松散类型 JSON 的防御式读取器。每一个都接受
 * `unknown`，并以 `undefined` 作答而不是抛错：一条格式错误的条目不能让整个清单
 * 刷新失败。
 *
 * @module dsh-aperture/metadata/utils
 */

/** 读取普通 JSON 对象，拒绝数组与原始值。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 读取非空且已去除首尾空白的字符串。 */
export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** 读取严格布尔值。 */
export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** 读取正整数，接受某些清单使用的 `128k` / `1.5M` 写法。 */
export function positiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = value.trim().replace(/[, _]/gu, '').match(/^(\d+(?:\.\d+)?)([kKmM])?$/u);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
  const normalized = amount * multiplier;
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : undefined;
}

/** 候选中第一个已定义且去空白后非空的字符串。 */
export function firstString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

/** 候选中第一个正整数。 */
export function firstPositiveInteger(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const normalized = positiveInteger(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

/** 候选中第一个严格布尔值。 */
export function firstBoolean(values: readonly unknown[]): boolean | undefined {
  for (const value of values) {
    const normalized = booleanValue(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

/** 用于精确匹配的、转小写并去除空白的键。 */
export function normalizeKey(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

/** 用于宽容匹配的、转小写并折叠标点的键。 */
export function slugKey(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/['"]/gu, '')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '') ?? ''
  );
}

/** 最后一个 `/` 之后的全部内容；没有 `/` 时即整个值。 */
export function suffixAfterSlash(value: string): string {
  return value.includes('/') ? (value.split('/').pop() ?? value) : value;
}

/** 对去空白后非空的字符串去重，并保持顺序。 */
export function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
