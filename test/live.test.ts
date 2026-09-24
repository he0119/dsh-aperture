/**
 * 在真实 harness 中针对真实网关的端到端验证。
 *
 * 本测试不再自己拼服务栈，而是走部署实际走的那条路：临时建一个 profile 目录，把它交给
 * `boot()` 与 Cordis Loader —— `dsh-llm`、`llm-pi-ai` 适配器、`dsh-config-editor`、
 * `dsh-settings` 以及本插件都是 profile 里的行，本插件那一行指着本地源码（`src/index.ts`
 * 的 `file://` URL），所以加载的正是待验证的代码。它随后连到一个真实的 Aperture 实例，
 * 断言用户会看到的结果：发现结果经设置接缝写进 profile 的补丁文档
 * （`<profile>/cordis.patch.yml`），又作为 `loader/volatile-update` 抵达正在运行的那个
 * 插件，适配器接受了它，路由于是能通过 LLM 服务解析出模型。
 *
 * 之所以非要走 Loader：配置的读者是**正在运行的插件**，而不是本进程里的一份副本。只有真的
 * 把这一行挂在 Loader 上，`ctx.settings.mutate()` 的写入才有「就地换热引用还是重建 entry」
 * 这个区别可以断言 —— 那正是本测试盯着的性质。
 *
 * 它是唯一能证明该*写入*合法而非看似合理的测试，因此是选择性启用的：它需要网络、
 * 一个网关以及 harness 软件包。
 *
 * ```sh
 * DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run test:live
 * ```
 *
 * @module dsh-aperture/test/live
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
// `Entry` 只为类型而来，但它同时带来 `loader` 那个服务的声明合并；`llm` 与 `settings`
// 也一样在上述两个包的类型里，所以空导入是有用的：编译期由此看得见 `ctx.loader` /
// `ctx.llm` / `ctx.settings`。运行时不需要它们——profile 里的行由 Loader 按名字加载，
// 本测试不亲自持有任何一个适配器实例。
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-settings';
import {
  PROFILE_PATCH_FILENAME,
  boot,
  readProfilePatches,
  type ProfileContext,
} from '@deepseek-ai/dsh-app-boot';

/** 本仓库根；本插件那一行按 `file://` URL 从这里拼出来。 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 被加载的行：本插件的源码入口（Node 就地剥掉类型注解）。 */
const PLUGIN_ENTRY = join(REPO, 'src', 'index.ts');

/** 本插件自己的设置段，也是它的 entry id。 */
const APERTURE = 'aperture';

/** 承载已发布路由的适配器设置段。 */
const PI_AI = 'llm-pi-ai';

const INSTANCE = process.env.DSH_APERTURE_LIVE_URL;

describe('live Aperture discovery', { skip: INSTANCE === undefined ? 'set DSH_APERTURE_LIVE_URL' : false }, () => {
  let directory: string;
  let patchPath: string;
  let ctx: Context;
  /** 插件自己的日志；探针超时时用来解释它卡在哪里。 */
  const logs: string[] = [];

  before(async () => {
    const instance = INSTANCE!;

    directory = await mkdtemp(join(tmpdir(), 'dsh-aperture-live-'));
    const home = join(directory, 'home');
    await mkdir(home, { recursive: true });

    // 一个 profile 目录至少要有这两样：`loadProfileDirectory` 从 `package.json` 读
    // `dsh.profile.bundles`（空列表即「没有 bundle 层」），而根 Include 自己的文档由
    // `boot()` 读作树的根。
    await writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify(
        { name: 'dsh-aperture-live-profile', private: true, version: '0.0.0', dsh: { profile: { bundles: [] } } },
        undefined,
        2,
      )}\n`,
    );
    const rootConfig = join(directory, 'cordis.yml');
    await writeFile(rootConfig, '[]\n');

    // 被断言的文档：`<profile>/cordis.patch.yml`，正是 `ConfigEditor.documentPath`
    // （== `profileContext.patchPath`）编辑的那一份。三条形状规则都不可省：
    //   * 它是顶层 YAML 数组，而组合从空根开始，所以行必须用 `insert:` 建；
    //   * 本地路径的插件用 `name:` 寻址，且值必须是**字面** `file://` URL——写成裸路径
    //     时 name 会在每次写入后来回翻转，`Entry.update` 于是重建整棵 Include 子树，
    //     而不是就地提交活引用；
    //   * `aperture` 的 `config` 写在**另一个省略 `name:` 的顶层行**里，否则
    //     `ConfigEditor.edit()` 会追加一行重复的 `aperture` 并报「被更高优先级的层覆盖」。
    patchPath = join(directory, PROFILE_PATCH_FILENAME);
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

    // `profileContext` 是纯数据，不是服务实现：`boot()` 与 config-editor 只读
    // `ctx.get('profileContext')`，因此在 `prepare` 里 `provide` 登记即可——settings 与
    // config-editor 都以它为门，必须在任何配置树的行挂载之前就位。
    const profileContext: ProfileContext = {
      name: 'dsh-aperture-live',
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
      'dsh-aperture-live',
      rootConfig,
      readProfilePatches('dsh-aperture-live', profileContext),
      (root) => {
        root.provide('profileContext', profileContext);
        root.logger.exporter({
          levels: { default: 4 },
          export: ({ name, type, args }) => {
            logs.push(`[${type} ${name}] ${args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')}`);
          },
        });
      },
      // 第五个参数必填：没有它，profile 里每个包名行都会以 ERR_MODULE_NOT_FOUND 收场。
      pathToFileURL(join(REPO, 'package.json')).href,
    );

    try {
      // 插件自己报出失败时立刻收手：否则一个不可达的 URL 会让人对着 30 秒的沉默发呆
      // （真正的原因——网关不可达、路由键不合法——只在它的日志里）。
      await waitFor(
        () => publishedModelIds(ctx).length > 0 || discoveryFailed(logs),
        '发现结果写进 profile 补丁文档',
      );
      assert.ok(publishedModelIds(ctx).length > 0, 'expected the plugin to publish its OpenAI-compatible route');
    } catch (error) {
      throw new Error(`${message(error)}\n插件的日志：\n${logs.join('\n')}`, { cause: error });
    }
  });

  after(async () => {
    // 失败路径下 `before` 可能没走到最后一步，清理各自容错，别盖住真正的失败。
    await ctx?.fiber.dispose().catch(() => undefined);
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('把 OpenAI 兼容路由发布到 profile 的补丁文档', async () => {
    const text = await readFile(patchPath, 'utf8');
    assert.match(text, /^- id: llm-pi-ai$/mu, 'expected the profile patch document to carry a llm-pi-ai row');
    assert.match(text, /^ +providers:$/mu);
    assert.match(text, /^ +aperture:$/mu);
    const base = INSTANCE!.trim().replace(/\/+$/u, '').replace(/\/v1$/u, '');
    assert.match(
      text,
      new RegExp(`^ +baseURL: ${base.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/v1`, 'mu'),
      `expected providers.aperture.baseURL to point at ${base}/v1`,
    );
  });

  it('向 LLM 服务注册两个路由', () => {
    const providers = ctx.llm.listProviders().map((provider) => provider.id);
    assert.ok(providers.includes('aperture'), `expected aperture among ${providers.join(', ')}`);
    assert.ok(providers.includes('aperture-anthropic'), `expected aperture-anthropic among ${providers.join(', ')}`);
  });

  it('通过 LLM 服务提供已发现的模型', async () => {
    const models = await ctx.llm.listModels('aperture');
    assert.ok(models.length > 0, 'expected at least one OpenAI-compatible model');
    const ids = models.map((model) => model.id);
    assert.ok(ids.includes('deepseek-flash'), `expected deepseek-flash among ${ids.join(', ')}`);
  });

  it('依据网关字段推算已发现模型的容量', async () => {
    const info = await ctx.llm.resolveModelInfo('aperture', 'deepseek-flash');
    assert.equal(info.context?.contextWindow, 1_048_576);
    assert.equal(info.defaultMaxTokens, 384_000);
    assert.equal(info.name, 'DeepSeek V4.1 Flash');
  });

  it('提供适配器真正会接受的推理档位', async () => {
    const info = await ctx.llm.resolveModelInfo('aperture', 'deepseek-v4-pro');
    assert.deepEqual(
      info.reasoning?.efforts.map((effort) => String(effort.id)),
      ['off', 'high', 'max'],
    );
  });

  it('把仅支持 Anthropic 的模型路由到 Anthropic 路由', async () => {
    const models = await ctx.llm.listModels('aperture-anthropic');
    assert.deepEqual(
      models.map((model) => model.id),
      ['MiniMax-M3'],
    );
  });

  it('在用户层变化时重新读取其设置段', async () => {
    // 该配置段是以活引用（thunk）而非快照交出的，因此一次编辑必须能在不重载的情况下
    // 抵达下一次刷新。把发现范围限制为单个 id 在已发布的清单中是可观测的：若是快照，
    // 完整列表会原样保留，这里就永远不会收敛。
    //
    // 写入走设置接缝的路径寻址 op，而不是整段覆盖：它经 config-editor 落进 profile 的
    // 补丁文档，再由 Loader 就地提交进那份活引用。`loader/volatile-update` 只发给拥有
    // 该 entry 的 fiber，所以监听器挂在它的 fiber 上下文上，而不是根上下文——根上什么
    // 都收不到。
    const entry = apertureEntry(ctx);
    assert.ok(entry !== undefined && entry.fiber !== undefined, 'expected the aperture entry to be running');
    const { fiber } = entry;
    const uid = fiber.uid;
    const updates: Array<readonly (readonly string[])[]> = [];
    fiber.ctx.on('loader/volatile-update', (paths) => {
      updates.push(paths);
    });

    await ctx.settings.mutate(APERTURE, [{ op: 'set', path: ['enabledModelIds'], value: ['deepseek-flash'] }]);

    await waitFor(() => publishedModelIds(ctx).join(',') === 'deepseek-flash', '已发布的模型清单收敛到单个 id');
    assert.deepEqual(publishedModelIds(ctx), ['deepseek-flash']);

    // 就地更新：整份配置作为一个 volatile 根被重提（路径为空），因此 entry 没有被重建。
    const inPlace = updates.find((paths) => paths.length === 1 && paths[0]?.length === 0);
    assert.deepEqual(inPlace, [[]], `expected an in-place volatile update (paths [[]]), saw ${JSON.stringify(updates)}`);
    assert.equal(apertureEntry(ctx)?.fiber?.uid, uid, 'the aperture entry was re-created instead of updated in place');
  });
});

/** 本插件在 Loader 里的那一行。 */
function apertureEntry(context: Context): Entry | undefined {
  return [...context.loader.entries()].find((entry) => entry.options.id === APERTURE);
}

/** 插件在其 OpenAI 兼容路由上已发布的 id。 */
function publishedModelIds(context: Context): string[] {
  const section = sectionValue(context, PI_AI) as
    | { providers?: Record<string, { models?: Array<{ id?: string }> }> }
    | undefined;
  return (section?.providers?.[APERTURE]?.models ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * 设置接缝报告的某个 entry 的生效值。
 *
 * 设置接缝没有「按命名空间取值」这种读法：`describe()` 是唯一入口，它按 Loader 里的
 * entry 逐个报告（`ns` 就是 entry id）。
 */
function sectionValue(context: Context, ns: string): unknown {
  return context.settings.describe().find((descriptor) => descriptor.ns === ns)?.value;
}

/** 轮询直到条件成立，否则以始终未发生的事实判定测试失败。 */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待「${what}」超时`);
}

/** 插件自己报出的发现失败（网关不可达、响应不合法）；有它就不必再等满超时。 */
function discoveryFailed(lines: readonly string[]): boolean {
  return lines.some((line) => line.includes('发现失败'));
}

/** 把未知的可抛出对象渲染成单行原因。 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
