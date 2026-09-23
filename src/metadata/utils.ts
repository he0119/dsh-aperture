/**
 * Defensive readers for the loosely typed JSON both Aperture and models.dev
 * return. Every one accepts `unknown` and answers `undefined` rather than
 * throwing: one malformed entry must not fail a whole catalog refresh.
 *
 * @module dsh-aperture/metadata/utils
 */

/** Read a plain JSON object, rejecting arrays and primitives. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read a non-empty trimmed string. */
export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Read a strict boolean. */
export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Read a positive integer, accepting the `128k` / `1.5M` spellings some catalogs use. */
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

/** The first defined, non-empty trimmed string among the candidates. */
export function firstString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

/** The first positive integer among the candidates. */
export function firstPositiveInteger(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const normalized = positiveInteger(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

/** The first strict boolean among the candidates. */
export function firstBoolean(values: readonly unknown[]): boolean | undefined {
  for (const value of values) {
    const normalized = booleanValue(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

/** Lower-cased, trimmed key for exact matching. */
export function normalizeKey(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

/** Lower-cased, punctuation-collapsed key for tolerant matching. */
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

/** Everything after the last `/`, or the whole value when there is none. */
export function suffixAfterSlash(value: string): string {
  return value.includes('/') ? (value.split('/').pop() ?? value) : value;
}

/** Deduplicate trimmed non-empty strings, preserving order. */
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
