/**
 * 供流水线测试共享的夹具加载。
 *
 * 夹具采用读取而非导入的方式，因此测试与构建都不依赖 JSON 导入属性：
 * `aperture-models.json` 是来自真实 Aperture 实例的原样响应，
 * `models-dev.json` 则是这些 id 所解析依据的 models.dev 真实文档子集。
 *
 * @module dsh-aperture/test/helpers
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildOptions } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 读取并解析一个夹具。 */
export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8')) as T;
}

/** 录制下来的 Aperture 清单中的 `data` 数组。 */
export function apertureEntries(): unknown[] {
  return fixture<{ data: unknown[] }>('aperture-models.json').data;
}

/** 录制下来的 models.dev 文档。 */
export function catalogDocument(): unknown {
  return fixture<unknown>('models-dev.json');
}

/** 所有字段都取默认值的构建选项，使测试只陈述自身要验证的内容。 */
export function options(overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    models: [],
    enabledModelIds: [],
    modelAliases: {},
    defaultContextWindow: 128_000,
    images: 'ignore',
    reasoning: 'auto',
    ...overrides,
  };
}
