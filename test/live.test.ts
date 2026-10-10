/**
 * 在真实 harness 中针对真实网关的端到端验证。
 *
 * 本测试不再自己拼服务栈，而是走部署实际走的那条路：临时建一个 profile 目录，把它交给
 * `boot()` 与 Cordis Loader —— `dsh-llm`、`dsh-config-editor`、`dsh-settings` 以及本插件都是
 * profile 里的行，本插件那一行指着本地源码（`src/index.ts` 的 `file://` URL），所以加载的正是
 * 待验证的代码。profile 里**没有** `llm-pi-ai`：本插件自己就是这三条路由的 provider，路由能流式
 * 回答这件事因此只能由本插件自己挣来。
 *
 * 它随后连到一个真的网关（默认是 `test/fake-gateway.ts` 自己起的那个，也可以给一个真实实例），
 * 断言的是**用户会看到的结果**：
 *
 * - 三条路由都在 LLM 服务里注册了，模型元数据（容量、输出上限、推理档位）与本插件的发现一致；
 * - 三种线缆协议各自**真的流式说出话来**——文本增量抵达调用方，终止原因是 `stop`；
 * - 推理档位真的按 DeepSeek 方言发到了线上（`reasoning_effort` / `thinking.disabled`），
 *   工具结果与历史按 pi-ai 的形状发出；
 * - Anthropic 的思考签名经宿主的重放信封回到下一轮请求里——多轮对话不丢原生元数据；
 * - 用户层改动抵达正在运行的插件（就地换引用而不是重建 entry），关掉注册开关会把路由撤下来。
 *
 * 之所以非要走 Loader：配置的读者是**正在运行的插件**，而不是本进程里的一份副本。只有真的把
 * 这一行挂在 Loader 上，「设置写入 → 活引用就地更新 → 路由重新注册」这条链才有意义可断言。
 *
 * 流式断言需要一个**会按线缆协议回答**的网关，因此只在自带假网关时跑；给了
 * `DSH_APERTURE_LIVE_URL` 时跳过它们（真实实例要花真实 token，回答内容也不由本仓库决定）：
 *
 * ```sh
 * pnpm run test:live                                                   # 自己起假网关
 * DSH_APERTURE_LIVE_URL=https://ai.example.ts.net pnpm run test:live    # 真实实例
 * ```
 *
 * @module dsh-aperture/test/live
 */

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
// 这三个空导入只为类型而来，它们同时带来 `loader` / `llm` / `settings` 三个服务的声明合并，
// 本测试因此看得见 `ctx.loader` / `ctx.llm` / `ctx.settings`。运行时不需要它们——profile 里的
// 行由 Loader 按名字加载，本测试不亲自持有任何一个实例。
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-settings';
import { BlockAssembler, type StreamChunk } from '@deepseek-ai/dsh-llm';
import {
  PROFILE_PATCH_FILENAME,
  boot,
  readProfilePatches,
  type ProfileContext,
} from '@deepseek-ai/dsh-app-boot';
import { FAKE_THINKING_SIGNATURE, startFakeGateway, type FakeGateway, type GatewayCall } from './fake-gateway.ts';

/** 本仓库根；本插件那一行按 `file://` URL 从这里拼出来。 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 被加载的行：本插件的源码入口（Node 就地剥掉类型注解）。 */
const PLUGIN_ENTRY = join(REPO, 'src', 'index.ts');

/** 本插件自己的设置段，也是它的 entry id。 */
const APERTURE = 'aperture';

/** 承载 Chat Completions 的那条路由键；三条路由的名字都由前缀加协议名的小写写法拼出来。 */
const CHAT_ROUTE = `${APERTURE}-openai-chat-completions`;

/** 三条路由的键。 */
const ROUTES = [
  CHAT_ROUTE,
  `${APERTURE}-openai-responses`,
  `${APERTURE}-anthropic-messages`,
] as const;

/** 真实实例地址；没给就自己起一个假网关（`before` 里决定）。 */
const INSTANCE = process.env.DSH_APERTURE_LIVE_URL?.trim();

/** 只有自带假网关时，才断言「线上到底发了什么」。 */
const wireIt = INSTANCE === undefined || INSTANCE === '' ? it : it.skip;

describe('live Aperture routes', () => {
  let directory: string;
  let ctx: Context;
  /** 这一轮实际连的那个网关：给定地址，或自己起的那个。 */
  let instance: string;
  /** 自己起的假网关；给了 `DSH_APERTURE_LIVE_URL` 时它不存在。 */
  let gateway: FakeGateway | undefined;
  /** 插件自己的日志；探针超时时用来解释它卡在哪里。 */
  const logs: string[] = [];

  before(async () => {
    // 没给地址就自己起一个：CI 与不在 Tailscale 网里的机器因此也能跑这一份。端口交给内核挑，
    // 于是并行跑两份用例也不会互相打断。
    if (INSTANCE === undefined || INSTANCE === '') {
      gateway = await startFakeGateway();
      instance = gateway.url;
    } else {
      instance = INSTANCE;
    }

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

    // profile 的三行：LLM 服务、设置与它的写入器、以及本插件。本插件那一行按 `file://` URL
    // 寻址（字面 URL，不是裸路径：裸路径会让 name 在每次写入后来回翻转、`Entry.update` 于是
    // 重建整棵 Include 子树，而不是就地提交活引用）。配置写在**另一个省略 `name:` 的顶层行**里，
    // 否则 `ConfigEditor.edit()` 会追加一行重复的 `aperture` 并报「被更高优先级的层覆盖」。
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
        // 真实部署还有一个 `hmr`：base bundle 在有 profileContext 时把它挂起来（`root: []`），
        // 而设置写入正落在它的事务里。真身要 `--expose-internals` 与 `timer` 服务才挂得起来，
        // 本 profile 两样都没有，因此这里给一个只留 `runExclusive` 那条约定的替身。少了它，
        // 设置写入这条路径与真实部署不是同一个形状——而这一份用例盯着的正是那条路径。
        root.provide('hmr', hmrSeam());
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
        () => routeIds(ctx).length === ROUTES.length || discoveryFailed(logs),
        '三条路由都注册出去',
      );
      assert.equal(routeIds(ctx).length, ROUTES.length, 'expected the plugin to register all three routes');
    } catch (error) {
      throw new Error(`${message(error)}\n插件的日志：\n${logs.join('\n')}`, { cause: error });
    }
  });

  after(async () => {
    // 失败路径下 `before` 可能没走到最后一步，清理各自容错，别盖住真正的失败。
    await ctx?.fiber.dispose().catch(() => undefined);
    await gateway?.close().catch(() => undefined);
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('向 LLM 服务注册三条路由，每条都只承载自己的协议', async () => {
    assert.deepEqual([...routeIds(ctx)].sort(), [...ROUTES].sort());
    assert.deepEqual(
      (await ctx.llm.listModels(CHAT_ROUTE)).map((model) => model.id).sort(),
      ['deepseek-flash', 'deepseek-v4-pro'],
    );
    assert.deepEqual(
      (await ctx.llm.listModels(`${APERTURE}-openai-responses`)).map((model) => model.id),
      ['deepseek-v4-codex'],
    );
    assert.deepEqual(
      (await ctx.llm.listModels(`${APERTURE}-anthropic-messages`)).map((model) => model.id),
      ['MiniMax-M3'],
    );
  });

  it('provider 目录里那三行各自写出协议名', () => {
    // 官方「模型」页与选择器读的就是这一列，因此三条标签必须自己说清承载的是哪种协议：只叫
    // 「Aperture」的那一条看不出它收的是 Chat Completions。
    const labels = new Map(
      ctx.llm.listConfigurableProviders().map((entry) => [entry.provider, entry.displayName]),
    );
    assert.deepEqual(
      ROUTES.map((route) => labels.get(route)),
      ['Aperture (OpenAI Chat Completions)', 'Aperture (OpenAI Responses)', 'Aperture (Anthropic Messages)'],
    );
  });

  it('依据网关字段推算已发现模型的容量', async () => {
    const info = await ctx.llm.resolveModelInfo(CHAT_ROUTE, 'deepseek-flash');
    assert.equal(info.context?.contextWindow, 1_048_576);
    assert.equal(info.defaultMaxTokens, 384_000);
    assert.equal(info.name, 'DeepSeek V4.1 Flash');
  });

  it('提供适配器真正会接受的推理档位', async () => {
    const info = await ctx.llm.resolveModelInfo(CHAT_ROUTE, 'deepseek-v4-pro');
    assert.deepEqual(
      info.reasoning?.efforts.map((effort) => String(effort.id)),
      ['off', 'high', 'max'],
    );
  });

  wireIt('OpenAI Chat Completions 路由真的流式说出话来', async () => {
    const turn = await run(ctx, CHAT_ROUTE, 'deepseek-flash');
    assert.equal(turn.text, 'pong');
    assert.deepEqual(turn.finish, { kind: 'stop' });
    // 用量来自网关最后那个 usage 块，且穿过 pi-ai 的语义（缓存字段为零时不再出现）。
    assert.deepEqual(turn.usage, { inputTokens: 11, outputTokens: 3, totalTokens: 14 });
  });

  wireIt('OpenAI Responses 路由真的流式说出话来', async () => {
    const turn = await run(ctx, `${APERTURE}-openai-responses`, 'deepseek-v4-codex');
    assert.equal(turn.text, 'pong');
    assert.deepEqual(turn.finish, { kind: 'stop' });
    assert.equal(turn.usage?.inputTokens, 5);
    assert.equal(turn.usage?.outputTokens, 1);
  });

  wireIt('Anthropic 路由真的流式说出话来，思考与文本各成一块', async () => {
    const turn = await run(ctx, `${APERTURE}-anthropic-messages`, 'MiniMax-M3');
    assert.equal(turn.text, 'pong');
    assert.equal(turn.reasoning, '想一想');
    assert.deepEqual(turn.finish, { kind: 'stop' });
  });

  wireIt('推理档位按 DeepSeek 方言发到线上', async () => {
    await run(ctx, CHAT_ROUTE, 'deepseek-v4-pro', { reasoningEffort: 'high' });
    const high = lastCall(gateway, '/v1/chat/completions');
    assert.equal(high.body.reasoning_effort, 'high', `expected reasoning_effort in ${JSON.stringify(high.body)}`);
    // 模型 id 与归因头都在线上：网关看到的是这次的模型，而不是配置里的路由名。
    assert.equal(high.body.model, 'deepseek-v4-pro');
    assert.match(String(high.headers['user-agent']), /deepseek-harness/u);

    await run(ctx, CHAT_ROUTE, 'deepseek-v4-pro', { reasoningEffort: 'off' });
    const off = lastCall(gateway, '/v1/chat/completions');
    assert.deepEqual(off.body.thinking, { type: 'disabled' }, `expected disabled thinking in ${JSON.stringify(off.body)}`);
    assert.equal(off.body.reasoning_effort, undefined);
  });

  wireIt('system 提示与工具声明都到线上', async () => {
    await drain(ctx.llm.stream({
      provider: CHAT_ROUTE,
      model: 'deepseek-flash',
      system: '你是这条用例的验证助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [
        {
          name: 'probe_tool',
          description: '验证工具声明真的到线上',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      ],
    }));

    const call = lastCall(gateway, '/v1/chat/completions');
    // pi-ai 1.x 的 provider 只读 transcript：system 提示与工具声明必须先折进头部那条指令消息，
    // 原样传 `Context` 不会报错，只是这两样从请求里整个消失（见 `src/adapter/index.ts` 的
    // `normalizeContext`）。这条用例钉的就是那一步。
    //
    // 那条消息的角色名不是本插件定的：pi-ai 对推理模型按 `supportsDeveloperRole` 发 `developer`
    // （0.85.1 起就是如此），因此这里只钉「首位那条指令消息带着这段提示」。
    const messages = call.body.messages as Array<{ role: string; content: unknown }>;
    const instruction = messages.find(
      (message) => message.role === 'system' || message.role === 'developer',
    );
    assert.ok(instruction !== undefined, `expected an instruction message, saw ${JSON.stringify(call.body.messages)}`);
    assert.equal(messages[0], instruction, 'system 提示必须落在整个对话的最前面');
    assert.match(JSON.stringify(instruction.content), /你是这条用例的验证助手/u);
    assert.deepEqual(
      (call.body.tools as Array<{ name?: string; function?: { name?: string } }> | undefined)
        ?.map((tool) => tool.function?.name ?? tool.name),
      ['probe_tool'],
      `expected the tool declaration on the wire, saw ${JSON.stringify(call.body.tools)}`,
    );
  });

  wireIt('Anthropic 的思考签名经重放信封回到下一轮', async () => {
    const first = await run(ctx, `${APERTURE}-anthropic-messages`, 'MiniMax-M3', { assemble: true });
    assert.ok(first.message !== undefined, 'expected an assembled assistant message');
    assert.equal(first.message.source.replayState !== undefined, true, 'expected replay state on the assembled message');

    await drain(ctx.llm.stream({
      provider: `${APERTURE}-anthropic-messages`,
      model: 'MiniMax-M3',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
        first.message,
        { role: 'user', content: [{ type: 'text', text: '第二轮' }] },
      ],
    }));

    const second = lastCall(gateway, '/v1/messages');
    const messages = second.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const thinking = messages
      .flatMap((entry) => entry.content ?? [])
      .find((block) => block.type === 'thinking');
    assert.equal(thinking?.signature, FAKE_THINKING_SIGNATURE, `expected the signature back, saw ${JSON.stringify(second.body.messages)}`);
    assert.equal(thinking?.thinking, '想一想');
  });

  it('在用户层变化时就地重读其设置段', async () => {
    // 该配置段是以活引用（thunk）而非快照交出的，因此一次编辑必须能在不重载的情况下抵达下一次
    // 刷新。把发现范围限制为单个 id 在已注册的路由里是可观测的：若是快照，完整列表会原样保留，
    // 这里就永远不会收敛。
    //
    // 写入走设置接缝的路径寻址 op：它经 config-editor 落进 profile 的补丁文档，再由 Loader 就地
    // 提交进那份活引用。`loader/volatile-update` 只发给拥有该 entry 的 fiber，所以监听器挂在它的
    // fiber 上下文上，而不是根上下文——根上什么都收不到。
    const entry = apertureEntry(ctx);
    assert.ok(entry !== undefined && entry.fiber !== undefined, 'expected the aperture entry to be running');
    const { fiber } = entry;
    const uid = fiber.uid;
    const updates: Array<readonly (readonly string[])[]> = [];
    fiber.ctx.on('loader/volatile-update', (paths) => {
      updates.push(paths);
    });

    await ctx.settings.mutate(APERTURE, [{ op: 'set', path: ['enabledModelIds'], value: ['deepseek-flash'] }]);

    await waitFor(
      async () => (await ctx.llm.listModels(CHAT_ROUTE)).map((model) => model.id).join(',') === 'deepseek-flash',
      '已注册的模型清单收敛到单个 id',
    );
    assert.deepEqual(
      (await ctx.llm.listModels(CHAT_ROUTE)).map((model) => model.id),
      ['deepseek-flash'],
    );

    // 就地更新：整份配置作为一个 volatile 根被重提（路径为空），因此 entry 没有被重建。
    const inPlace = updates.find((paths) => paths.length === 1 && paths[0]?.length === 0);
    assert.deepEqual(inPlace, [[]], `expected an in-place volatile update (paths [[]]), saw ${JSON.stringify(updates)}`);
    assert.equal(apertureEntry(ctx)?.fiber?.uid, uid, 'the aperture entry was re-created instead of updated in place');
  });

  // 放在最后：它把注册关掉，之前的用例都假定路由在服务。
  it('关掉注册就把路由撤下来，而不是留在原地', async () => {
    await ctx.settings.mutate(APERTURE, [{ op: 'set', path: ['sync'], value: false }]);
    await waitFor(() => routeIds(ctx).length === 0, '三条路由都从 LLM 服务里撤下来');
    assert.deepEqual(routeIds(ctx), []);
    // 撤下之后这个键就没人服务了：LLM 服务连模型清单都给不出来（界面上那一行因此显示成
    // 「没有路由可服务」，而不是「这个路由上一个模型都没有」）。
    await assert.rejects(
      () => ctx.llm.listModels(CHAT_ROUTE),
      /no adapter registered for provider "aperture-openai-chat-completions"/u,
    );
  });
});

/** 一次流式回答里值得断言的东西。 */
interface Turn {
  readonly text: string;
  readonly reasoning: string;
  readonly finish: unknown;
  readonly usage: { inputTokens: number; outputTokens: number; totalTokens?: number } | undefined;
  readonly message: ReturnType<BlockAssembler['message']> | undefined;
}

/** 把一条流读干净；多轮重放那一轮只关心网关收到了什么。 */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) {
    // 读完即弃。
  }
}

/**
 * 跑一轮请求并收集结果。
 *
 * @param context - 已启动的 harness。
 * @param provider - 路由键。
 * @param model - 模型 id。
 * @param options - 需要额外指定的请求控制项（推理档位、是否装配消息）。
 * @returns 文本、思考、终止原因、用量与装配出的助手消息。
 */
async function run(
  context: Context,
  provider: string,
  model: string,
  options: { reasoningEffort?: string; assemble?: boolean } = {},
): Promise<Turn> {
  const assembler = new BlockAssembler();
  let text = '';
  let reasoning = '';
  let finish: unknown;
  for await (const chunk of context.llm.stream({
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    ...(options.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: options.reasoningEffort as never }),
  })) {
    assembler.push(chunk);
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
    if (chunk.type === 'finish') finish = chunk.reason;
  }
  // 装配出的消息要自己带上重放信封：`BlockAssembler.message()` 只铺块，信封由调用方
  // 从 `replayState` 取（这正是宿主自己的装配路径做的事）。
  const replayState = assembler.replayState;
  return {
    text,
    reasoning,
    finish,
    usage: assembler.usage,
    message: options.assemble !== true
      ? undefined
      : assembler.message({ provider, model, ...(replayState === undefined ? {} : { replayState }) }),
  };
}

/** 网关记录下来的最后一个某个路径的推理请求。 */
function lastCall(gatewayInstance: FakeGateway | undefined, path: string): GatewayCall {
  assert.ok(gatewayInstance !== undefined, 'expected the fake gateway');
  const found = [...gatewayInstance.calls()].reverse().find((call) => call.path.startsWith(path));
  assert.ok(found !== undefined, `expected a ${path} call, saw ${gatewayInstance.calls().map((call) => call.path).join(', ')}`);
  return found;
}

/** 本插件当前注册出去的路由键。 */
function routeIds(context: Context): string[] {
  return context.llm
    .listProviders()
    .map((provider) => provider.id)
    .filter((id) => (ROUTES as readonly string[]).includes(id));
}

/** 本插件在 Loader 里的那一行。 */
function apertureEntry(context: Context): Entry | undefined {
  return [...context.loader.entries()].find((entry) => entry.options.id === APERTURE);
}

/**
 * `@deepseek-ai/dsh-hmr` 的替身，只留 `runExclusive` 那件事。
 *
 * `dsh-config-editor` 把**整次**设置写入包在 `hmr.runExclusive()` 里，而这条事务的
 * AsyncLocalStorage 印记会跟着事务里同步发出的 `loader/volatile-update` 一路走下去：本插件那一轮
 * 刷新若从事件处理器那条链上发起，就会带着事务印记去注册路由。真实部署里这个服务在场，本 profile
 * 因此也给它一个位置——这条替身让「刷新从事务里起跑」这个形状是真的被测到，而不是被绕开。
 *
 * 两个字段的语义逐字来自 `dsh-hmr` 的 `runExclusive()`：事务里再来一次 → 拒绝；否则排在上一件
 * 工作后面，并在自己的上下文里跑。
 *
 * @returns 一个只有 `runExclusive` 的 `hmr` 服务。
 */
function hmrSeam(): { runExclusive(operation: () => Promise<unknown>): Promise<unknown> } {
  const executing = new AsyncLocalStorage<boolean>();
  let operations: Promise<unknown> = Promise.resolve();
  return {
    runExclusive(operation) {
      if (executing.getStore()) {
        return Promise.reject(new Error('HMR transactions cannot be nested'));
      }
      const task = operations.then(() => executing.run(true, operation));
      operations = task.catch(() => undefined);
      return task;
    },
  };
}

/** 轮询直到条件成立，否则以始终未发生的事实判定测试失败。 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
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
