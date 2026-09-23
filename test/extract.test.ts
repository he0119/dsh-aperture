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
  it('读取真实 Aperture 实例实际使用的写法', () => {
    assert.deepEqual(extractLimits({ context_window_tokens: 1_048_576, max_output_tokens: 384_000 }), {
      contextWindow: 1_048_576,
      maxTokens: 384_000,
    });
  });

  it('读取参考实现的写法', () => {
    assert.deepEqual(extractLimits({ max_input_tokens: 200_000, max_completion_tokens: 64_000 }), {
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
  });

  it('读取嵌套的 limit 块', () => {
    assert.deepEqual(extractLimits({ limit: { context: 128_000, output: 8_192 } }), {
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
  });

  it('读取嵌套的 metadata 块', () => {
    assert.deepEqual(extractLimits({ metadata: { limits: { context: 65_536 } } }), { contextWindow: 65_536 });
  });

  it('接受 128k / 1.5M 这类写法，并拒绝无意义的值', () => {
    assert.deepEqual(extractLimits({ context_window: '128k', max_output_tokens: '1.5M' }), {
      contextWindow: 128_000,
      maxTokens: 1_500_000,
    });
    assert.equal(extractLimits({ context_window: 0, max_output_tokens: -5 }), undefined);
  });

  it('条目什么都没说时，就什么都不下结论', () => {
    assert.equal(extractLimits({ id: 'x' }), undefined);
    assert.equal(extractLimits(undefined), undefined);
    assert.equal(extractLimits('not an object'), undefined);
  });
});

describe('extractCapabilities', () => {
  it('从顶层读取推理与工具调用', () => {
    assert.deepEqual(extractCapabilities({ reasoning: true, tool_call: false }), {
      reasoning: true,
      toolCalling: false,
    });
  });

  it('读取嵌套的 capabilities 块', () => {
    assert.deepEqual(extractCapabilities({ metadata: { capabilities: { thinking: true } } }), { reasoning: true });
  });

  it('从列表读取输入模态', () => {
    assert.deepEqual(extractCapabilities({ modalities: { input: ['text', 'image'] } }), {
      input: ['text', 'image'],
    });
  });

  it('把 vision 标志转成模态', () => {
    assert.deepEqual(extractCapabilities({ supports_vision: true }), { input: ['text', 'image'] });
  });

  it('条目沉默时，就什么都不下结论', () => {
    assert.equal(extractCapabilities({ id: 'x' }), undefined);
  });
});

describe('extractEndpoint / name / provider', () => {
  it('读取公布的端点', () => {
    assert.deepEqual(extractEndpoints({ supported_endpoints: ['/v1/chat/completions'] }), ['/v1/chat/completions']);
    assert.deepEqual(extractEndpoints({ id: 'x' }), []);
    assert.deepEqual(extractEndpoints({ supported_endpoints: 'nope' }), []);
  });

  it('优先使用网关给出的显示名', () => {
    assert.equal(extractDisplayName({ id: 'deepseek-flash', display_name: 'DeepSeek V4.1 Flash' }), 'DeepSeek V4.1 Flash');
  });

  it('读取上游 provider 身份', () => {
    assert.deepEqual(extractProvider({ metadata: { provider: { id: 'deepseek', name: 'DeepSeek' } } }), {
      id: 'deepseek',
      name: 'DeepSeek',
    });
    assert.deepEqual(extractProvider({ owned_by: 'ts-llm-proxy' }), { id: 'ts-llm-proxy' });
    assert.equal(extractProvider({ id: 'x' }), undefined);
  });
});
