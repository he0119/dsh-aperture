import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCatalogLookup } from '../src/metadata/modelsdev.ts';
import { catalogDocument } from './helpers.ts';

const lookup = buildCatalogLookup(catalogDocument());

describe('models.dev 查询', () => {
  it('载入录制下来的文档', () => {
    assert.ok(lookup !== undefined);
  });

  it('匹配一个被网关改过厂商前缀的 id', () => {
    const found = lookup?.({ id: 'x-ai/grok-4.5', provider: 'openrouter' });
    assert.equal(found?.reasoning, true);
    assert.deepEqual(found?.input, ['text', 'image']);
  });

  it('靠厂商前缀线索匹配裸 id', () => {
    const found = lookup?.({ id: 'mimo-v2.6-flash', provider: 'xiaomimimo' });
    assert.equal(found?.reasoning, true);
    assert.equal(found?.contextWindow, 1_048_576);
  });

  it('匹配只有大小写差异的 id', () => {
    assert.equal(lookup?.({ id: 'MiniMax-M3', provider: 'minimax' })?.reasoning, true);
    assert.equal(lookup?.({ id: 'LongCat-2.0', provider: 'longcat' })?.reasoning, true);
  });

  it('匹配带厂商前缀的 slug 形式 id', () => {
    assert.equal(lookup?.({ id: 'Qwen/Qwen3.6-35B-A3B', provider: 'siliconflow' })?.reasoning, true);
    assert.equal(lookup?.({ id: 'deepseek-ai/DeepSeek-V4-Flash', provider: 'siliconflow' })?.reasoning, true);
  });

  it('给出容量与输出上限', () => {
    const found = lookup?.({ id: 'deepseek-v4-pro', provider: 'deepseek' });
    assert.equal(found?.contextWindow, 1_000_000);
    assert.equal(found?.maxTokens, 384_000);
  });

  it('清单里没有的 id 一律不给答案', () => {
    // 网关给 DeepSeek flash 模型起的别名，正是打分跨不过去的那类偏差；
    // 部署要靠 `modelAliases` 才能跨过它。
    assert.equal(lookup?.({ id: 'deepseek-flash', provider: 'deepseek' }), undefined);
    assert.equal(lookup?.({ id: 'k3', provider: 'kimi-code' }), undefined);
  });

  it('没有可用条目的文档一律不给答案', () => {
    assert.equal(buildCatalogLookup({}), undefined);
    assert.equal(buildCatalogLookup(undefined), undefined);
    assert.equal(buildCatalogLookup({ providers: {} }), undefined);
  });

  it('也能读取以 provider 为键的文档', () => {
    const providerShaped = buildCatalogLookup({
      providers: {
        deepseek: { id: 'deepseek', name: 'DeepSeek', models: { 'deepseek-chat': { id: 'deepseek-chat', reasoning: true } } },
      },
    });
    assert.equal(providerShaped?.({ id: 'deepseek-chat' })?.reasoning, true);
  });
});
