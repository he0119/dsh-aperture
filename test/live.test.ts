/**
 * 在真实 harness 中针对真实网关的端到端验证。
 *
 * 本测试会启动部署实际运行的整套栈 —— 基于文件的设置 provider、`dsh-llm`、
 * `llm-pi-ai` 适配器以及本插件 —— 并连到一个真实的 Aperture 实例，随后断言用户
 * 会看到的结果：发现结果落入 `settings.yaml`，适配器接受了它，且路由现在能通过
 * LLM 服务解析出模型。
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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file';
import * as AperturePlugin from '../src/index.ts';

const INSTANCE = process.env.DSH_APERTURE_LIVE_URL;

describe('live Aperture discovery', { skip: INSTANCE === undefined ? 'set DSH_APERTURE_LIVE_URL' : false }, () => {
  let directory: string;
  let settingsPath: string;
  let ctx: Context;
  const fibers: Array<{ dispose(): Promise<void> }> = [];

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-aperture-live-'));
    settingsPath = join(directory, 'settings.yaml');

    ctx = new Context();
    fibers.push(ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false }));
    fibers.push(ctx.plugin(LlmRuntime));
    fibers.push(ctx.plugin(PiAi, {}));
    fibers.push(
      ctx.plugin(AperturePlugin, {
        baseUrl: INSTANCE,
        refreshIntervalMinutes: 0,
      }),
    );

    await waitFor(async () => (await readFile(settingsPath, 'utf8').catch(() => '')).includes('aperture'));
  });

  after(async () => {
    for (const fiber of fibers.reverse()) {
      await fiber.dispose().catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  });

  it('把 OpenAI 兼容路由发布到 settings.yaml', async () => {
    const text = await readFile(settingsPath, 'utf8');
    assert.match(text, /llm-pi-ai:/);
    assert.match(text, /aperture:/);
    assert.match(text, new RegExp(`baseURL: ${INSTANCE?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/v1`));
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
    await ctx.settings.update('aperture', { enabledModelIds: ['deepseek-flash'] });

    await waitFor(async () => publishedModelIds(ctx).join(',') === 'deepseek-flash');
    assert.deepEqual(publishedModelIds(ctx), ['deepseek-flash']);
  });
});

/** 插件在其 OpenAI 兼容路由上已发布的 id。 */
function publishedModelIds(context: Context): string[] {
  const section = context.settings.get('llm-pi-ai') as
    | { providers?: Record<string, { models?: Array<{ id?: string }> }> }
    | undefined;
  return (section?.providers?.aperture?.models ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string');
}

/** 轮询直到条件成立，否则以始终未发生的事实判定测试失败。 */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for discovery to reach settings.yaml');
}
