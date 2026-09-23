import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractCapabilities,
  extractDisplayName,
  extractEndpoints,
  extractLimits,
  extractProvider,
} from '../src/metadata/extract.ts';

describe('extractLimits', () => {
  it('reads the spellings a live Aperture instance actually uses', () => {
    assert.deepEqual(extractLimits({ context_window_tokens: 1_048_576, max_output_tokens: 384_000 }), {
      contextWindow: 1_048_576,
      maxTokens: 384_000,
    });
  });

  it('reads the reference extension spellings', () => {
    assert.deepEqual(extractLimits({ max_input_tokens: 200_000, max_completion_tokens: 64_000 }), {
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
  });

  it('reads a nested limit block', () => {
    assert.deepEqual(extractLimits({ limit: { context: 128_000, output: 8_192 } }), {
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
  });

  it('reads a nested metadata block', () => {
    assert.deepEqual(extractLimits({ metadata: { limits: { context: 65_536 } } }), { contextWindow: 65_536 });
  });

  it('accepts the 128k / 1.5M spellings and rejects nonsense', () => {
    assert.deepEqual(extractLimits({ context_window: '128k', max_output_tokens: '1.5M' }), {
      contextWindow: 128_000,
      maxTokens: 1_500_000,
    });
    assert.equal(extractLimits({ context_window: 0, max_output_tokens: -5 }), undefined);
  });

  it('states nothing when the entry states nothing', () => {
    assert.equal(extractLimits({ id: 'x' }), undefined);
    assert.equal(extractLimits(undefined), undefined);
    assert.equal(extractLimits('not an object'), undefined);
  });
});

describe('extractCapabilities', () => {
  it('reads reasoning and tool calling from the top level', () => {
    assert.deepEqual(extractCapabilities({ reasoning: true, tool_call: false }), {
      reasoning: true,
      toolCalling: false,
    });
  });

  it('reads a nested capabilities block', () => {
    assert.deepEqual(extractCapabilities({ metadata: { capabilities: { thinking: true } } }), { reasoning: true });
  });

  it('reads input modalities from a list', () => {
    assert.deepEqual(extractCapabilities({ modalities: { input: ['text', 'image'] } }), {
      input: ['text', 'image'],
    });
  });

  it('turns a vision flag into modalities', () => {
    assert.deepEqual(extractCapabilities({ supports_vision: true }), { input: ['text', 'image'] });
  });

  it('states nothing when the entry is silent', () => {
    assert.equal(extractCapabilities({ id: 'x' }), undefined);
  });
});

describe('extractEndpoint / name / provider', () => {
  it('reads the advertised endpoints', () => {
    assert.deepEqual(extractEndpoints({ supported_endpoints: ['/v1/chat/completions'] }), ['/v1/chat/completions']);
    assert.deepEqual(extractEndpoints({ id: 'x' }), []);
    assert.deepEqual(extractEndpoints({ supported_endpoints: 'nope' }), []);
  });

  it('prefers the gateway display name', () => {
    assert.equal(extractDisplayName({ id: 'deepseek-flash', display_name: 'DeepSeek V4.1 Flash' }), 'DeepSeek V4.1 Flash');
  });

  it('reads the upstream provider identity', () => {
    assert.deepEqual(extractProvider({ metadata: { provider: { id: 'deepseek', name: 'DeepSeek' } } }), {
      id: 'deepseek',
      name: 'DeepSeek',
    });
    assert.deepEqual(extractProvider({ owned_by: 'ts-llm-proxy' }), { id: 'ts-llm-proxy' });
    assert.equal(extractProvider({ id: 'x' }), undefined);
  });
});
