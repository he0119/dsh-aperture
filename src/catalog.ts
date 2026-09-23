/**
 * 可选的第二来源：models.dev。
 *
 * Aperture 会设定模型的容量，但很少说明某个模型是否会推理，对输入模态则完全不
 * 提。models.dev 会为同一批模型回答这两个问题，只是 id 有时才对得上，因此该文档
 * 只索引一次，之后按评分查询（见 `metadata/modelsdev.ts`）。
 *
 * 这次抓取在任何意义上都是可选的：把 `modelMetadataUrl` 留空的部署，或者清单不
 * 可达的部署，得到的是仅来自网关的清单，而不是一次失败的刷新。
 *
 * @module dsh-aperture/catalog
 */

import { buildCatalogLookup } from './metadata/modelsdev.ts';
import type { CatalogLookup } from './types.ts';

/** 有界读取：清单远小于此值，而重定向到巨大的东西则不是清单。 */
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

/** 一次清单加载的结果，用于诊断报告。 */
export interface CatalogLoad {
  /** 查找器，在加载到可用文档时提供。 */
  readonly lookup?: CatalogLookup;
  /** 已索引条目的数量，在加载成功时提供。 */
  readonly entries: number;
  /** 没有可用查找器的原因，在不可用时提供。 */
  readonly reason?: string;
}

/** 一个清单 URL 的进程生命周期缓存。 */
export class ModelCatalog {
  private loaded: { url: string; value: CatalogLoad } | undefined;

  /**
   * 加载（或复用）某个 URL 上的清单。
   * @param url - 清单 URL；为空则禁用查找。
   * @param timeoutMs - 每次请求的超时时间。
   * @returns 加载结果；从不抛出。
   */
  async load(url: string, timeoutMs: number): Promise<CatalogLoad> {
    if (url.length === 0) {
      return { entries: 0, reason: '未配置清单 URL' };
    }
    if (this.loaded?.url === url) {
      return this.loaded.value;
    }

    const value = await this.fetchCatalog(url, timeoutMs);
    this.loaded = { url, value };
    return value;
  }

  /** 丢弃缓存的文档，使下次加载重新抓取。 */
  clear(): void {
    this.loaded = undefined;
  }

  /** 抓取、解析并索引一份清单文档。 */
  private async fetchCatalog(url: string, timeoutMs: number): Promise<CatalogLoad> {
    let body: unknown;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return { entries: 0, reason: `${url} 应答 HTTP ${response.status}` };
      }
      const text = await response.text();
      if (text.length > MAX_CATALOG_BYTES) {
        return { entries: 0, reason: `${url} 应答了 ${text.length} 字节，超出清单上限` };
      }
      body = JSON.parse(text);
    } catch (error) {
      return { entries: 0, reason: `${url} 无法读取：${error instanceof Error ? error.message : String(error)}` };
    }

    const lookup = buildCatalogLookup(body);
    if (lookup === undefined) {
      return { entries: 0, reason: `${url} 中没有可用的模型元数据` };
    }
    return { lookup, entries: countEntries(body) };
  }
}

/** 统计一份清单文档包含的模型条目数，仅用于报告。 */
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
