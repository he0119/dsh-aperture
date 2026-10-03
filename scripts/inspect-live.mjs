/**
 * 手动走查用的脚手架：对着真实网关启动真实服务栈，打印出本插件注册了哪些路由、
 * LLM 服务又解析出了什么。
 *
 * 这不是测试——带断言的那份是 `test/live.test.ts`。它存在的意义是：东西一旦变动，
 * 人能亲眼看一眼**注册之后**的路由，以及那份「什么都没写」的证据。
 *
 * 它走的是与部署同一条路：临时建一个 profile 目录（`cordis.patch.yml` 里带上 `aperture`
 * 那一行），由 `boot()` 交给 Cordis Loader 真正挂起来。它加载的是**构建产物** `lib/`，
 * 也就是 profile 实际加载的那个文件。
 *
 * 打印 profile 补丁文档是**反证**：本插件不写任何配置，那一份跑完之后应当与跑之前逐字相同。
 * 这里不做任何断言（补丁文档是否原样、路由是否真的会流式回答，都由 `test/live.test.ts` 核），
 * 它只把事实摆出来给人看。
 *
 * ```sh
 * pnpm run build && DSH_APERTURE_LIVE_URL=https://ai.example.ts.net pnpm run inspect
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

// 本插件注册的三条路由键：三种线缆协议各一条。它们必须在跑完之后都出现在
// `ctx.llm.listProviders()` 里，晚到或缺失都会让下面那段等待空转到超时。
const ROUTES = [APERTURE, `${APERTURE}-responses`, `${APERTURE}-anthropic`];

/** 每条路由配一个模型来展示 `resolveModelInfo`；不存在的模型会被接缝拒绝并打印原因。 */
const SAMPLES = [
  [APERTURE, 'deepseek-v4-pro'],
  [`${APERTURE}-responses`, 'deepseek-v4-codex'],
  [`${APERTURE}-anthropic`, 'MiniMax-M3'],
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const instance = process.env.DSH_APERTURE_LIVE_URL?.trim();
if (!instance) {
  // 旧版本在这里回退到一个硬编码的实例；现在没有它了：走完整套 profile + Loader 只为
  // 猜一个地址，不如把该给的东西说清楚。
  console.error('需要 DSH_APERTURE_LIVE_URL，例如：DSH_APERTURE_LIVE_URL=https://ai.example.ts.net pnpm run inspect');
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
// 写在另一个省略 `name:` 的顶层行里。
//
// 这里**没有** `llm-pi-ai`：本插件不往别的插件的配置段里写路由，它自己就是那三条路由的
// provider。下面打印的补丁文档因此是「插件什么都没写」的证据。
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

/** 插件自己报出的发现失败；有它就不必在这里干等满 30 秒。 */
const failed = () => logs.some((line) => line.includes('发现失败') || line.includes('刷新失败'));

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

  /** 本插件当前注册出去的路由键；注册是被拒绝还是晚到，全由这个方法回答。 */
  const registered = () => ctx.llm.listProviders().map((provider) => provider.id);
  const published = () => ROUTES.every((route) => registered().includes(route));

  // 等第一轮发现落地：三条路由都出现在 LLM 服务里，或插件自己报了失败——不可达的网关不该
  // 让人在这里干等满 30 秒。
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !published() && !failed()) {
    await sleep(200);
  }

  console.log(`=== 实例 ===\n${instance}`);
  console.log(`=== profile 补丁文档（${patchPath}）===`);
  console.log(await readFile(patchPath, 'utf8'));
  console.log('=== 已注册的 providers ===');
  console.log(registered());
  console.log('=== 三条路由各自的模型 ===');
  for (const route of ROUTES) {
    try {
      console.log(`${route}:`, (await ctx.llm.listModels(route)).map((model) => model.id));
    } catch (error) {
      // 一条路由都没注册时，这里不是「零个模型」而是「没有这个 provider」。
      console.log(`${route}:`, error instanceof Error ? error.message : String(error));
    }
  }
  console.log('=== LLM 服务解析出的模型信息 ===');
  for (const [provider, model] of SAMPLES) {
    console.log(`--- ${provider} / ${model} ---`);
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
