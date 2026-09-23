/**
 * Shared fixture loading for the pipeline tests.
 *
 * Fixtures are read rather than imported so neither the tests nor the build
 * depend on JSON import attributes: `aperture-models.json` is a verbatim
 * response from a live Aperture instance, and `models-dev.json` is the subset
 * of the real models.dev document that those ids resolve against.
 *
 * @module dsh-aperture/test/helpers
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildOptions } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read and parse one fixture. */
export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8')) as T;
}

/** The `data` array of the recorded Aperture listing. */
export function apertureEntries(): unknown[] {
  return fixture<{ data: unknown[] }>('aperture-models.json').data;
}

/** The recorded models.dev document. */
export function catalogDocument(): unknown {
  return fixture<unknown>('models-dev.json');
}

/** Build options with every field defaulted, so tests state only what they exercise. */
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
