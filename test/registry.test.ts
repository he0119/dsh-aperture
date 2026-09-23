import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCatalogLookup } from '../src/metadata/modelsdev.ts';
import { buildRegistry, classifyProtocol } from '../src/registry.ts';
import { apertureEntries, catalogDocument, options } from './helpers.ts';

const lookup = buildCatalogLookup(catalogDocument());

/** The recorded listing, normalized with the given options. */
function registry(overrides: Parameters<typeof options>[0] = {}) {
  return buildRegistry(apertureEntries(), options(overrides), lookup);
}

describe('classifyProtocol', () => {
  it('routes chat/completions to the OpenAI-compatible route', () => {
    assert.equal(classifyProtocol(['/v1/chat/completions']), 'openai-completions');
  });

  it('routes /v1/messages to the Anthropic route', () => {
    assert.equal(classifyProtocol(['/v1/messages']), 'anthropic-messages');
  });

  it('refuses a model that only offers a transport no plugin can serve', () => {
    assert.equal(
      classifyProtocol(['/v1beta/models/{model}:generateContent', '/v1beta/models/{model}:streamGenerateContent']),
      undefined,
    );
  });

  it('prefers chat/completions when a model offers both', () => {
    assert.equal(classifyProtocol(['/v1/messages', '/v1/chat/completions']), 'openai-completions');
  });

  it('assumes OpenAI-compatible when a gateway advertises no endpoints at all', () => {
    assert.equal(classifyProtocol([]), 'openai-completions');
  });
});

describe('buildRegistry over a real Aperture listing', () => {
  it('normalizes every row', () => {
    assert.equal(registry().models.length, 16);
  });

  it('splits the catalog by the transports the gateway actually serves', () => {
    const { models, unserved } = registry();
    const openai = models.filter((model) => model.protocol === 'openai-completions');
    const anthropic = models.filter((model) => model.protocol === 'anthropic-messages');
    assert.equal(openai.length, 11);
    assert.equal(anthropic.length, 1);
    assert.equal(anthropic[0]?.id, 'MiniMax-M3');
    // The Gemini models are reachable only through the native generateContent
    // transport, and Aperture answers 404 for them on /v1/chat/completions.
    assert.deepEqual(
      unserved.map((model) => model.id),
      ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-3.1-flash-image-preview'],
    );
  });

  it('sizes models from the gateway fields the reference extension predates', () => {
    const flash = registry().models.find((model) => model.id === 'deepseek-flash');
    assert.equal(flash?.contextWindow, 1_048_576);
    assert.equal(flash?.maxTokens, 384_000);
    assert.equal(flash?.provenance.limits, 'aperture');
  });

  it('names models from the gateway display name', () => {
    const flash = registry().models.find((model) => model.id === 'deepseek-flash');
    assert.equal(flash?.name, 'DeepSeek V4.1 Flash');
    assert.equal(flash?.provenance.name, 'aperture');
  });

  it('enriches reasoning from the catalog', () => {
    const mimo = registry().models.find((model) => model.id === 'mimo-v2.6-flash');
    assert.equal(mimo?.reasoning, true);
    assert.equal(mimo?.provenance.reasoning, 'models.dev');
  });

  it('does not guess reasoning for an id the catalog cannot place', () => {
    const flash = registry().models.find((model) => model.id === 'deepseek-flash');
    assert.equal(flash?.reasoning, false);
    assert.equal(flash?.provenance.reasoning, 'default');
  });

  it('declares text-only unless image metadata is adopted', () => {
    assert.deepEqual(registry().models.find((model) => model.id === 'mimo-v2.6-flash')?.input, ['text']);
    assert.deepEqual(
      registry({ images: 'metadata' }).models.find((model) => model.id === 'mimo-v2.6-flash')?.input,
      ['text', 'image'],
    );
  });

  it('declares every model non-reasoning when reasoning is switched off', () => {
    assert.equal(
      registry({ reasoning: 'off' }).models.some((model) => model.reasoning),
      false,
    );
  });

  it('reports the upstream provider', () => {
    assert.equal(registry().models.find((model) => model.id === 'x-ai/grok-4.5')?.provider, 'openrouter');
  });
});

describe('buildRegistry configuration', () => {
  it('restricts the catalog to enabledModelIds', () => {
    const { models } = registry({ enabledModelIds: ['deepseek-flash', 'MiniMax-M3'] });
    assert.deepEqual(
      models.map((model) => model.id),
      ['deepseek-flash', 'MiniMax-M3'],
    );
  });

  it('still adds a configured model the gateway did not advertise', () => {
    const { models } = registry({
      enabledModelIds: ['deepseek-flash'],
      models: [{ id: 'hand-listed', api: 'openai-completions', contextWindow: 32_000, thinking: true }],
    });
    assert.deepEqual(
      models.map((model) => model.id),
      ['deepseek-flash', 'hand-listed'],
    );
    const extra = models[1];
    assert.equal(extra?.contextWindow, 32_000);
    assert.equal(extra?.provenance.limits, 'config');
    assert.equal(extra?.reasoning, true);
  });

  it('overrides only the fields a configured entry states', () => {
    const { models } = registry({ models: [{ id: 'deepseek-flash', name: 'Flash (pinned)' }] });
    const flash = models.find((model) => model.id === 'deepseek-flash');
    assert.equal(flash?.name, 'Flash (pinned)');
    assert.equal(flash?.provenance.name, 'config');
    // Untouched fields keep the gateway's own answer.
    assert.equal(flash?.contextWindow, 1_048_576);
    assert.equal(flash?.provenance.limits, 'aperture');
  });

  it('lets configuration serve a model the gateway only offers on an unserved transport', () => {
    const { unserved } = registry({ models: [{ id: 'gemini-2.5-pro', api: 'openai-completions' }] });
    assert.equal(
      unserved.some((model) => model.id === 'gemini-2.5-pro'),
      false,
    );
  });

  it('bridges an id the catalog spells differently', () => {
    const aliased = registry({
      modelAliases: { 'deepseek-flash': 'deepseek/deepseek-v4-flash', k3: 'moonshotai/kimi-k3' },
    });
    assert.equal(aliased.models.find((model) => model.id === 'deepseek-flash')?.reasoning, true);
    assert.equal(aliased.models.find((model) => model.id === 'k3')?.reasoning, true);
    assert.equal(aliased.models.find((model) => model.id === 'k3')?.name, 'Kimi K3');
  });

  it('invents no output cap, but always sizes the context', () => {
    const { models } = buildRegistry([{ id: 'bare' }], options(), undefined);
    assert.equal(models[0]?.contextWindow, 128_000);
    assert.equal(models[0]?.maxTokens, undefined);
  });
});
