/**
 * Manual walkthrough harness: boot the real stack against a live gateway and
 * print what the plugin published and what the LLM service resolves.
 *
 * Not a test — `test/live.test.ts` is the assertion-carrying version. This one
 * exists so a human can look at the generated section when something moves, and
 * it loads the *built* `lib/`, which is the artifact a profile actually loads.
 *
 * ```sh
 * npm run build && DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run inspect
 * ```
 *
 * @module dsh-aperture/scripts/inspect-live
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file';
import * as AperturePlugin from '../lib/index.js';

const instance = process.env.DSH_APERTURE_LIVE_URL ?? 'https://ai.long-antares.ts.net';
const directory = process.env.DSH_APERTURE_INSPECT_DIR ?? (await mkdtemp(join(tmpdir(), 'dsh-aperture-inspect-')));
const settingsPath = join(directory, 'settings.yaml');

const ctx = new Context();
ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false });
ctx.plugin(LlmRuntime);
ctx.plugin(PiAi, {});
ctx.plugin(AperturePlugin, {
  baseUrl: instance,
  refreshIntervalMinutes: 0,
  ...(process.env.DSH_APERTURE_INSPECT_METADATA === '1' ? {} : { modelMetadataUrl: '' }),
});

const deadline = Date.now() + 30_000;
let text = '';
while (Date.now() < deadline) {
  text = await readFile(settingsPath, 'utf8').catch(() => '');
  if (text.length > 0) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

console.log('=== settings.yaml ===');
console.log(text);
console.log('=== providers ===');
console.log(ctx.llm.listProviders());
console.log('=== aperture models ===');
console.log((await ctx.llm.listModels('aperture')).map((model) => model.id));
console.log('=== resolved deepseek-v4-pro ===');
console.log(JSON.stringify(await ctx.llm.resolveModelInfo('aperture', 'deepseek-v4-pro'), undefined, 2));
console.log('=== resolved deepseek-flash ===');
console.log(JSON.stringify(await ctx.llm.resolveModelInfo('aperture', 'deepseek-flash'), undefined, 2));
console.log('=== resolved MiniMax-M3 ===');
console.log(JSON.stringify(await ctx.llm.resolveModelInfo('aperture-anthropic', 'MiniMax-M3'), undefined, 2));
console.log(`settings dir: ${directory}`);
process.exit(0);
