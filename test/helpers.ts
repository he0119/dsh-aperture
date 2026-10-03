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
import type { ProviderPublisher } from '../src/runtime.ts';
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

/**
 * 一个不做真事的注册层：只把方案里的路由键当成「已注册」报回去。
 *
 * 只关心发现与报告的用例（运行时、配置页）不该被真正的 provider 注册拖进来——那件事有自己的
 * 用例（`test/provider.test.ts`），而端到端那一份（`test/live.test.ts`）用的是真的 LLM 服务。
 */
export const fakeProvider: ProviderPublisher = {
  publish: (plan) => Promise.resolve({ routes: plan.routes.map((route) => route.provider) }),
};

/** 所有字段都取默认值的构建选项，使测试只陈述自身要验证的内容。 */
export function options(overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    models: [],
    enabledModelIds: [],
    modelAliases: {},
    images: 'ignore',
    reasoning: 'auto',
    ...overrides,
  };
}
