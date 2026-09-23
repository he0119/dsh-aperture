/**
 * The optional second source: models.dev.
 *
 * Aperture sizes models but rarely says whether one reasons, and says nothing
 * about input modalities. models.dev answers both for the same models under
 * ids that only sometimes match, so the document is indexed once and queried by
 * score (see `metadata/modelsdev.ts`).
 *
 * The fetch is optional in every sense: a deployment that leaves
 * `modelMetadataUrl` empty, or whose catalog is unreachable, gets a gateway-only
 * catalog rather than a failed refresh.
 *
 * @module dsh-aperture/catalog
 */

import { buildCatalogLookup } from './metadata/modelsdev.ts';
import type { CatalogLookup } from './types.ts';

/** Bounded read: the catalog is well under this, and a redirect to something huge is not it. */
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

/** Outcome of one catalog load, for the diagnostics report. */
export interface CatalogLoad {
  /** The lookup, when a usable document loaded. */
  readonly lookup?: CatalogLookup;
  /** Number of indexed entries, when one loaded. */
  readonly entries: number;
  /** Why no lookup is available, when none is. */
  readonly reason?: string;
}

/** Process-lifetime cache of one catalog URL. */
export class ModelCatalog {
  private loaded: { url: string; value: CatalogLoad } | undefined;

  /**
   * Load (or reuse) the catalog at one URL.
   * @param url - the catalog URL; empty disables the lookup.
   * @param timeoutMs - per-request timeout.
   * @returns the load outcome; never throws.
   */
  async load(url: string, timeoutMs: number): Promise<CatalogLoad> {
    if (url.length === 0) {
      return { entries: 0, reason: 'no catalog URL configured' };
    }
    if (this.loaded?.url === url) {
      return this.loaded.value;
    }

    const value = await this.fetchCatalog(url, timeoutMs);
    this.loaded = { url, value };
    return value;
  }

  /** Forget the cached document, so the next load refetches. */
  clear(): void {
    this.loaded = undefined;
  }

  /** Fetch, parse, and index one catalog document. */
  private async fetchCatalog(url: string, timeoutMs: number): Promise<CatalogLoad> {
    let body: unknown;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return { entries: 0, reason: `${url} answered HTTP ${response.status}` };
      }
      const text = await response.text();
      if (text.length > MAX_CATALOG_BYTES) {
        return { entries: 0, reason: `${url} answered ${text.length} bytes, beyond the catalog bound` };
      }
      body = JSON.parse(text);
    } catch (error) {
      return { entries: 0, reason: `${url} could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }

    const lookup = buildCatalogLookup(body);
    if (lookup === undefined) {
      return { entries: 0, reason: `${url} held no usable model metadata` };
    }
    return { lookup, entries: countEntries(body) };
  }
}

/** Count the model entries one catalog document holds, for the report only. */
function countEntries(document: unknown): number {
  if (document === null || typeof document !== 'object') {
    return 0;
  }
  const root = document as Record<string, unknown>;
  const wrapped = root.providers ?? root.models;
  if (wrapped !== null && typeof wrapped === 'object') {
    return Object.keys(wrapped as Record<string, unknown>).length;
  }
  return Object.keys(root).length;
}
