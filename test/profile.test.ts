import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCatalogLookup } from '../src/metadata/modelsdev.ts';
import { buildProfilePlan, type ProfileOptions } from '../src/profile.ts';
import { buildRegistry } from '../src/registry.ts';
import { apertureEntries, catalogDocument, options } from './helpers.ts';

const ROOT = 'https://ai.long-antares.ts.net';

/** The plan the recorded listing produces. */
function plan(overrides: Partial<ProfileOptions> = {}, build = options()) {
  const registry = buildRegistry(apertureEntries(), build, buildCatalogLookup(catalogDocument()));
  return buildProfilePlan(registry.models, {
    instanceRoot: ROOT,
    route: 'aperture',
    anthropicRoute: 'aperture-anthropic',
    displayName: 'Aperture',
    anthropicDisplayName: 'Aperture (Anthropic)',
    headers: {},
    placeholderCredential: 'dsh-aperture',
    configured: build.models,
    ...overrides,
  });
}

/** Find one route by provider key. */
function route(result: ReturnType<typeof plan>, provider: string) {
  return result.routes.find((candidate) => candidate.provider === provider);
}

/** Find one model entry by id. */
function entry(result: ReturnType<typeof plan>, provider: string, id: string) {
  return route(result, provider)?.profile.models?.find((model) => model.id === id);
}

describe('buildProfilePlan', () => {
  it('publishes one route per served protocol and no empty route', () => {
    const result = plan();
    assert.deepEqual(
      result.routes.map((candidate) => candidate.provider),
      ['aperture', 'aperture-anthropic'],
    );
    assert.deepEqual(result.ownedRoutes, ['aperture', 'aperture-anthropic']);
    assert.equal(result.unserved.length, 4);
  });

  it('gives each route the baseURL its protocol expects', () => {
    assert.equal(route(plan(), 'aperture')?.profile.baseURL, `${ROOT}/v1`);
    assert.equal(route(plan(), 'aperture-anthropic')?.profile.baseURL, ROOT);
  });

  it('sends the placeholder header pi-ai insists on, per protocol', () => {
    assert.deepEqual(route(plan(), 'aperture')?.profile.headers, { authorization: 'Bearer dsh-aperture' });
    assert.deepEqual(route(plan(), 'aperture-anthropic')?.profile.headers, { 'x-api-key': 'dsh-aperture' });
  });

  it('drops the placeholder once a credential reference is configured', () => {
    const result = plan({ apiKeyEnv: 'APERTURE_API_KEY', placeholderCredential: '' });
    assert.equal(route(result, 'aperture')?.profile.apiKeyEnv, 'APERTURE_API_KEY');
    assert.equal(route(result, 'aperture')?.profile.headers, undefined);
  });

  it('lets a configured header replace the placeholder', () => {
    const result = plan({ headers: { authorization: 'Bearer real-token' }, placeholderCredential: '' });
    assert.deepEqual(route(result, 'aperture')?.profile.headers, { authorization: 'Bearer real-token' });
  });

  it('describes the DeepSeek thinking dialect for DeepSeek models', () => {
    const model = entry(plan(), 'aperture', 'deepseek-v4-pro');
    assert.deepEqual(model?.reasoningEfforts, { off: 'disabled', high: 'high', max: 'max' });
    assert.deepEqual(model?.compat, { supportsReasoningEffort: true, thinkingFormat: 'deepseek' });
  });

  it('offers the widely accepted levels for every other reasoning model', () => {
    const model = entry(plan(), 'aperture', 'mimo-v2.6-flash');
    assert.deepEqual(model?.reasoningEfforts, { off: null, high: 'high' });
    assert.deepEqual(model?.compat, { supportsReasoningEffort: true });
  });

  it('states no reasoning for a model nothing claims reasons', () => {
    const model = entry(plan(), 'aperture', 'deepseek-flash');
    assert.equal(model?.reasoningEfforts, undefined);
    assert.equal(model?.compat, undefined);
  });

  it('leaves a discovered Anthropic model non-reasoning, because effort is not its dial', () => {
    const model = entry(plan(), 'aperture-anthropic', 'MiniMax-M3');
    assert.equal(model?.reasoningEfforts, undefined);
  });

  it('honours an explicit Anthropic reasoning request', () => {
    const build = options({ models: [{ id: 'MiniMax-M3', thinking: true }] });
    const model = entry(plan({}, build), 'aperture-anthropic', 'MiniMax-M3');
    assert.deepEqual(model?.reasoningEfforts, { off: null, high: 'high' });
    // The Anthropic protocol has no reasoning_effort switch to declare.
    assert.equal(model?.compat, undefined);
  });

  it('carries the sizes and modalities it was given', () => {
    const model = entry(plan(), 'aperture', 'deepseek-flash');
    assert.equal(model?.name, 'DeepSeek V4.1 Flash');
    assert.equal(model?.contextWindow, 1_048_576);
    assert.equal(model?.maxTokens, 384_000);
    assert.deepEqual(model?.input, ['text']);
  });

  it('never publishes a route with an empty model list', () => {
    const registry = buildRegistry(
      [{ id: 'only-anthropic', supported_endpoints: ['/v1/messages'] }],
      options(),
      undefined,
    );
    const result = buildProfilePlan(registry.models, {
      instanceRoot: ROOT,
      route: 'aperture',
      anthropicRoute: 'aperture-anthropic',
      displayName: 'Aperture',
      anthropicDisplayName: 'Aperture (Anthropic)',
      headers: {},
      placeholderCredential: 'dsh-aperture',
      configured: [],
    });
    assert.deepEqual(
      result.routes.map((candidate) => candidate.provider),
      ['aperture-anthropic'],
    );
    assert.deepEqual(result.ownedRoutes, ['aperture', 'aperture-anthropic']);
  });
});
