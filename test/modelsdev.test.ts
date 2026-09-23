import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCatalogLookup } from '../src/metadata/modelsdev.ts';
import { catalogDocument } from './helpers.ts';

const lookup = buildCatalogLookup(catalogDocument());

describe('models.dev lookup', () => {
  it('loads the recorded document', () => {
    assert.ok(lookup !== undefined);
  });

  it('matches an id whose vendor prefix the gateway renamed', () => {
    const found = lookup?.({ id: 'x-ai/grok-4.5', provider: 'openrouter' });
    assert.equal(found?.reasoning, true);
    assert.deepEqual(found?.input, ['text', 'image']);
  });

  it('matches a bare id by its vendor prefix hint', () => {
    const found = lookup?.({ id: 'mimo-v2.6-flash', provider: 'xiaomimimo' });
    assert.equal(found?.reasoning, true);
    assert.equal(found?.contextWindow, 1_048_576);
  });

  it('matches a casing-only difference', () => {
    assert.equal(lookup?.({ id: 'MiniMax-M3', provider: 'minimax' })?.reasoning, true);
    assert.equal(lookup?.({ id: 'LongCat-2.0', provider: 'longcat' })?.reasoning, true);
  });

  it('matches a slugged id with a vendor prefix', () => {
    assert.equal(lookup?.({ id: 'Qwen/Qwen3.6-35B-A3B', provider: 'siliconflow' })?.reasoning, true);
    assert.equal(lookup?.({ id: 'deepseek-ai/DeepSeek-V4-Flash', provider: 'siliconflow' })?.reasoning, true);
  });

  it('reports a capacity and an output cap', () => {
    const found = lookup?.({ id: 'deepseek-v4-pro', provider: 'deepseek' });
    assert.equal(found?.contextWindow, 1_000_000);
    assert.equal(found?.maxTokens, 384_000);
  });

  it('answers nothing for an id the catalog does not carry', () => {
    // The gateway's alias for DeepSeek's flash model is exactly the kind of
    // drift scoring cannot bridge; `modelAliases` is how a deployment bridges it.
    assert.equal(lookup?.({ id: 'deepseek-flash', provider: 'deepseek' }), undefined);
    assert.equal(lookup?.({ id: 'k3', provider: 'kimi-code' }), undefined);
  });

  it('answers nothing for a document with no usable entries', () => {
    assert.equal(buildCatalogLookup({}), undefined);
    assert.equal(buildCatalogLookup(undefined), undefined);
    assert.equal(buildCatalogLookup({ providers: {} }), undefined);
  });

  it('reads a provider-keyed document too', () => {
    const providerShaped = buildCatalogLookup({
      providers: {
        deepseek: { id: 'deepseek', name: 'DeepSeek', models: { 'deepseek-chat': { id: 'deepseek-chat', reasoning: true } } },
      },
    });
    assert.equal(providerShaped?.({ id: 'deepseek-chat' })?.reasoning, true);
  });
});
