/**
 * 手动走查用的脚手架：对着真实网关启动真实服务栈，打印出插件发布了什么、
 * LLM 服务又解析出了什么。
 *
 * 这不是测试——带断言的那份是 `test/live.test.ts`。它存在的意义是：东西一旦变动，
 * 人能亲眼看一眼生成的配置段。
 *
 * 它走的是与部署同一条路：临时建一个 profile 目录（`cordis.patch.yml` 里带上 `aperture`
 * 那一行），由 `boot()` 交给 Cordis Loader 真正挂起来，因此看到的是**真实写入之后**的
 * 结果——写入经 `dsh-config-editor` + `dsh-settings` 落进 profile 的补丁文档，而不是内存里
 * 拼出来的对象。它加载的是**构建产物** `lib/`，也就是 profile 实际加载的那个文件。
 *
 * ```sh
 * npm run build && DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run inspect
 * ```
 *
 * @module dsh-aperture/scripts/inspect-live
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROFILE_PATCH_FILENAME, boot, readProfilePatches } from '@deepseek-ai/dsh-app-boot';

/** 本仓库根；本插件那一行按 `file://` URL 从这里拼出来。 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 被加载的行：构建产物，也就是 profile 实际加载的那个文件。 */
const PLUGIN_ENTRY = join(REPO, 'lib', 'index.js');

/** 本插件自己的设置段，也是它的 entry id。 */
const APERTURE = 'aperture';

/** 承载已发布路由的适配器设置段。 */
const PI_AI = 'llm-pi-ai';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const instance = process.env.DSH_APERTURE_LIVE_URL?.trim();
if (!instance) {
  // 旧版本在这里回退到一个硬编码的实例；现在没有它了：走完整套 profile + Loader 只为
  // 猜一个地址，不如把该给的东西说清楚。
  console.error('需要 DSH_APERTURE_LIVE_URL，例如：DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run inspect');
  process.exit(1);
}

// ── 临时 profile ────────────────────────────────────────────────────────────
// `loadProfileDirectory` 从 `package.json` 读 `dsh.profile.bundles`（空列表即「没有
// bundle 层」），而根 Include 自己的文档由 `boot()` 读作树的根。
const directory = await mkdtemp(join(tmpdir(), 'dsh-aperture-inspect-'));
const home = join(directory, 'home');
await mkdir(home, { recursive: true });
await writeFile(
  join(directory, 'package.json'),
  `${JSON.stringify(
    { name: 'dsh-aperture-inspect-profile', private: true, version: '0.0.0', dsh: { profile: { bundles: [] } } },
    undefined,
    2,
  )}\n`,
);
const rootConfig = join(directory, 'cordis.yml');
await writeFile(rootConfig, '[]\n');

// 顶层 YAML 数组，而组合从空根开始，所以行必须用 `insert:` 建；本地路径的插件用 `name:`
// 寻址，且值必须是**字面** `file://` URL——写成裸路径时 name 会在每次写入后来回翻转，
// `Entry.update` 于是重建整棵 Include 子树，而不是就地提交活引用。`aperture` 的 `config`
// 写在另一个省略 `name:` 的顶层行里，否则 `ConfigEditor.edit()` 会追加一行重复的
// `aperture` 并报「被更高优先级的层覆盖」。
const patchPath = join(directory, PROFILE_PATCH_FILENAME);
await writeFile(
  patchPath,
  [
    '- insert:',
    `    - id: llm`,
    `      name: '@deepseek-ai/dsh-llm'`,
    `    - id: config-editor`,
    `      name: '@deepseek-ai/dsh-config-editor'`,
    `    - id: settings`,
    `      name: '@deepseek-ai/dsh-settings'`,
    `    - id: ${PI_AI}`,
    `      name: '@deepseek-ai/dsh-llm-pi-ai'`,
    `    - id: ${APERTURE}`,
    `      name: '${pathToFileURL(PLUGIN_ENTRY).href}'`,
    `- id: ${APERTURE}`,
    `  config:`,
    `    baseUrl: '${instance}'`,
    `    refreshIntervalMinutes: 0`,
    ``,
  ].join('\n'),
);

/** 插件的日志，用来解释一轮发现到底成了没有。 */
const logs = [];
const record = ({ name, type, args }) => {
  logs.push(`[${type} ${name}] ${args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')}`);
};

let ctx;
try {
  // `profileContext` 是纯数据；settings 与 config-editor 都以它为门，必须在任何配置树的
  // 行挂载之前就位。
  const profileContext = {
    name: 'dsh-aperture-inspect',
    dir: directory,
    patchPath,
    installAnchor: join(REPO, 'package.json'),
    cwd: REPO,
    home,
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  };
  ctx = await boot(
    'dsh-aperture-inspect',
    rootConfig,
    readProfilePatches('dsh-aperture-inspect', profileContext),
    (root) => {
      root.provide('profileContext', profileContext);
      root.logger.exporter({ levels: { default: 4 }, export: record });
    },
    // 第五个参数必填：没有它，profile 里每个包名行都会以 ERR_MODULE_NOT_FOUND 收场。
    pathToFileURL(join(REPO, 'package.json')).href,
  );

  /** 设置接缝报告的某个 entry 的生效值（`describe()` 是唯一的读法）。 */
  const section = (ns) => ctx.settings.describe().find((descriptor) => descriptor.ns === ns)?.value;
  const published = () => section(PI_AI)?.providers?.[APERTURE] !== undefined;
  const failed = () => logs.some((line) => line.includes('发现失败') || line.includes('刷新失败'));

  // 等第一轮发现落地：要么路由出现在 `llm-pi-ai` 配置段里，要么插件自己报了失败——
  // 不可达的网关不该让人在这里干等满 30 秒。
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !published() && !failed()) {
    await sleep(200);
  }

  console.log(`=== 实例 ===\n${instance}`);
  console.log(`=== profile 补丁文档（${patchPath}）===`);
  console.log(await readFile(patchPath, 'utf8'));
  console.log(`=== ${PI_AI}（设置接缝解析后的值）===`);
  console.log(JSON.stringify(section(PI_AI), undefined, 2));
  console.log('=== providers ===');
  console.log(ctx.llm.listProviders());
  console.log('=== aperture 的模型 ===');
  for (const provider of [APERTURE, `${APERTURE}-anthropic`]) {
    try {
      console.log(`${provider}:`, (await ctx.llm.listModels(provider)).map((model) => model.id));
    } catch (error) {
      // 一条路由都没发布时，这里不是「零个模型」而是「没有这个 provider」。
      console.log(`${provider}:`, error instanceof Error ? error.message : String(error));
    }
  }
  for (const [provider, model] of [
    [APERTURE, 'deepseek-v4-pro'],
    [APERTURE, 'deepseek-flash'],
    [`${APERTURE}-anthropic`, 'MiniMax-M3'],
  ]) {
    console.log(`=== 解析结果 ${model} ===`);
    try {
      console.log(JSON.stringify(await ctx.llm.resolveModelInfo(provider, model), undefined, 2));
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
    }
  }
  console.log('=== 发现日志 ===');
  console.log(logs.join('\n'));
} finally {
  await ctx?.fiber.dispose().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
  console.log(`=== 临时 profile 已删除：${directory} ===`);
}

process.exit(0);
