/**
 * End-to-end verification against a real gateway, in a real harness.
 *
 * This boots the actual stack a deployment runs — the file-backed settings
 * provider, `dsh-llm`, the `llm-pi-ai` adapter, and this plugin — against a
 * live Aperture instance, and then asserts what a user would see: the discovery
 * landed in `settings.yaml`, the adapter accepted it, and the routes now
 * resolve models through the LLM service.
 *
 * It is the only test that proves the *write* is legal rather than plausible,
 * so it is opt-in: it needs the network, a gateway, and the harness packages.
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

  it('publishes the OpenAI-compatible route into settings.yaml', async () => {
    const text = await readFile(settingsPath, 'utf8');
    assert.match(text, /llm-pi-ai:/);
    assert.match(text, /aperture:/);
    assert.match(text, new RegExp(`baseURL: ${INSTANCE?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/v1`));
  });

  it('registers both routes with the LLM service', () => {
    const providers = ctx.llm.listProviders().map((provider) => provider.id);
    assert.ok(providers.includes('aperture'), `expected aperture among ${providers.join(', ')}`);
    assert.ok(providers.includes('aperture-anthropic'), `expected aperture-anthropic among ${providers.join(', ')}`);
  });

  it('serves the discovered models through the LLM service', async () => {
    const models = await ctx.llm.listModels('aperture');
    assert.ok(models.length > 0, 'expected at least one OpenAI-compatible model');
    const ids = models.map((model) => model.id);
    assert.ok(ids.includes('deepseek-flash'), `expected deepseek-flash among ${ids.join(', ')}`);
  });

  it('sizes a discovered model from the gateway fields', async () => {
    const info = await ctx.llm.resolveModelInfo('aperture', 'deepseek-flash');
    assert.equal(info.context?.contextWindow, 1_048_576);
    assert.equal(info.defaultMaxTokens, 384_000);
    assert.equal(info.name, 'DeepSeek V4.1 Flash');
  });

  it('offers the reasoning levels the adapter will actually accept', async () => {
    const info = await ctx.llm.resolveModelInfo('aperture', 'deepseek-v4-pro');
    assert.deepEqual(
      info.reasoning?.efforts.map((effort) => String(effort.id)),
      ['off', 'high', 'max'],
    );
  });

  it('routes an Anthropic-only model to the Anthropic route', async () => {
    const models = await ctx.llm.listModels('aperture-anthropic');
    assert.deepEqual(
      models.map((model) => model.id),
      ['MiniMax-M3'],
    );
  });
});

/** Poll until a condition holds, or fail the test with what never happened. */
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
