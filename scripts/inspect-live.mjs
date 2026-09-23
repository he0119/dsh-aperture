/**
 * 手动走查用的脚手架：对着真实网关启动真实服务栈，打印出插件发布了什么、
 * LLM 服务又解析出了什么。
 *
 * 这不是测试——带断言的那份是 `test/live.test.ts`。它存在的意义是：东西一旦变动，
 * 人能亲眼看一眼生成的配置段；而且它加载的是**构建产物** `lib/`，也就是 profile
 * 实际加载的那个文件。
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
console.log('=== aperture 的模型 ===');
console.log((await ctx.llm.listModels('aperture')).map((model) => model.id));
console.log('=== 解析结果 deepseek-v4-pro ===');
console.log(JSON.stringify(await ctx.llm.resolveModelInfo('aperture', 'deepseek-v4-pro'), undefined, 2));
console.log('=== 解析结果 deepseek-flash ===');
console.log(JSON.stringify(await ctx.llm.resolveModelInfo('aperture', 'deepseek-flash'), undefined, 2));
console.log('=== 解析结果 MiniMax-M3 ===');
console.log(JSON.stringify(await ctx.llm.resolveModelInfo('aperture-anthropic', 'MiniMax-M3'), undefined, 2));
console.log(`设置目录：${directory}`);
process.exit(0);
