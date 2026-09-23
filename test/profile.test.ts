import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCatalogLookup } from '../src/metadata/modelsdev.ts';
import { buildProfilePlan, type ProfileOptions } from '../src/profile.ts';
import { buildRegistry } from '../src/registry.ts';
import { apertureEntries, catalogDocument, options } from './helpers.ts';

const ROOT = 'https://ai.long-antares.ts.net';

/** 录制清单所产生的计划。 */
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

/** 按 provider 键找到一条路由。 */
function route(result: ReturnType<typeof plan>, provider: string) {
  return result.routes.find((candidate) => candidate.provider === provider);
}

/** 按 id 找到一个模型条目。 */
function entry(result: ReturnType<typeof plan>, provider: string, id: string) {
  return route(result, provider)?.profile.models?.find((model) => model.id === id);
}

describe('buildProfilePlan', () => {
  it('每种可服务的协议发布一条路由，且不发布空路由', () => {
    const result = plan();
    assert.deepEqual(
      result.routes.map((candidate) => candidate.provider),
      ['aperture', 'aperture-anthropic'],
    );
    assert.deepEqual(result.ownedRoutes, ['aperture', 'aperture-anthropic']);
    assert.equal(result.unserved.length, 4);
  });

  it('给每条路由它所属协议期望的 baseURL', () => {
    assert.equal(route(plan(), 'aperture')?.profile.baseURL, `${ROOT}/v1`);
    assert.equal(route(plan(), 'aperture-anthropic')?.profile.baseURL, ROOT);
  });

  it('按协议发送 pi-ai 坚持要的占位请求头', () => {
    assert.deepEqual(route(plan(), 'aperture')?.profile.headers, { authorization: 'Bearer dsh-aperture' });
    assert.deepEqual(route(plan(), 'aperture-anthropic')?.profile.headers, { 'x-api-key': 'dsh-aperture' });
  });

  it('配置了凭据引用之后就去掉占位凭据', () => {
    const result = plan({ apiKeyEnv: 'APERTURE_API_KEY', placeholderCredential: '' });
    assert.equal(route(result, 'aperture')?.profile.apiKeyEnv, 'APERTURE_API_KEY');
    assert.equal(route(result, 'aperture')?.profile.headers, undefined);
  });

  it('允许配置的请求头替换占位凭据', () => {
    const result = plan({ headers: { authorization: 'Bearer real-token' }, placeholderCredential: '' });
    assert.deepEqual(route(result, 'aperture')?.profile.headers, { authorization: 'Bearer real-token' });
  });

  it('为 DeepSeek 模型描述 DeepSeek 的思考方言', () => {
    const model = entry(plan(), 'aperture', 'deepseek-v4-pro');
    assert.deepEqual(model?.reasoningEfforts, { off: 'disabled', high: 'high', max: 'max' });
    assert.deepEqual(model?.compat, { supportsReasoningEffort: true, thinkingFormat: 'deepseek' });
  });

  it('为其它推理模型提供普遍接受的档位', () => {
    const model = entry(plan(), 'aperture', 'mimo-v2.6-flash');
    assert.deepEqual(model?.reasoningEfforts, { off: null, high: 'high' });
    assert.deepEqual(model?.compat, { supportsReasoningEffort: true });
  });

  it('没有任何来源声称会推理的模型，就不写推理', () => {
    const model = entry(plan(), 'aperture', 'deepseek-flash');
    assert.equal(model?.reasoningEfforts, undefined);
    assert.equal(model?.compat, undefined);
  });

  it('空的 reasoningEfforts 等于没声明，不当成「没有任何档位」发出去', () => {
    // `llm-pi-ai` 会以「reasoningEfforts 是空的」为由拒绝整段写入，于是三条路由一条都发布不
    // 出去。适配器自己的建议是「省略这个字段以沿用已安装清单的能力」，这里就照它办：空字典落
    // 回按模型推导出来的档位，而不是把一个空对象原样递过去。
    const reasoning = options({ models: [{ id: 'deepseek-v4-pro', reasoningEfforts: {} }] });
    assert.deepEqual(
      entry(plan({}, reasoning), 'aperture', 'deepseek-v4-pro')?.reasoningEfforts,
      { off: 'disabled', high: 'high', max: 'max' },
    );
    const plain = options({ models: [{ id: 'deepseek-flash', reasoningEfforts: {} }] });
    assert.equal(entry(plan({}, plain), 'aperture', 'deepseek-flash')?.reasoningEfforts, undefined);
  });

  it('让发现的 Anthropic 模型保持不推理，因为档位不是它的旋钮', () => {
    const model = entry(plan(), 'aperture-anthropic', 'MiniMax-M3');
    assert.equal(model?.reasoningEfforts, undefined);
  });

  it('尊重显式提出的 Anthropic 推理请求', () => {
    const build = options({ models: [{ id: 'MiniMax-M3', thinking: true }] });
    const model = entry(plan({}, build), 'aperture-anthropic', 'MiniMax-M3');
    assert.deepEqual(model?.reasoningEfforts, { off: null, high: 'high' });
    // Anthropic 协议没有 reasoning_effort 这个开关可以声明。
    assert.equal(model?.compat, undefined);
  });

  it('带上它拿到的容量与模态', () => {
    const model = entry(plan(), 'aperture', 'deepseek-flash');
    assert.equal(model?.name, 'DeepSeek V4.1 Flash');
    assert.equal(model?.contextWindow, 1_048_576);
    assert.equal(model?.maxTokens, 384_000);
    assert.deepEqual(model?.input, ['text']);
  });

  it('绝不发布模型列表为空的路由', () => {
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
