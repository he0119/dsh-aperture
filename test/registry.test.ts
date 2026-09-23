import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCatalogLookup } from '../src/metadata/modelsdev.ts';
import { buildRegistry, classifyProtocol } from '../src/registry.ts';
import { apertureEntries, catalogDocument, options } from './helpers.ts';

const lookup = buildCatalogLookup(catalogDocument());

/** 录制下来的清单，按给定选项归一化。 */
function registry(overrides: Parameters<typeof options>[0] = {}) {
  return buildRegistry(apertureEntries(), options(overrides), lookup);
}

describe('classifyProtocol', () => {
  it('把 chat/completions 归到 OpenAI 兼容路由', () => {
    assert.equal(classifyProtocol(['/v1/chat/completions']), 'openai-completions');
  });

  it('把 /v1/messages 归到 Anthropic 路由', () => {
    assert.equal(classifyProtocol(['/v1/messages']), 'anthropic-messages');
  });

  it('拒绝只提供无人可服务传输方式的模型', () => {
    assert.equal(
      classifyProtocol(['/v1beta/models/{model}:generateContent', '/v1beta/models/{model}:streamGenerateContent']),
      undefined,
    );
  });

  it('模型两者都提供时，优先 chat/completions', () => {
    assert.equal(classifyProtocol(['/v1/messages', '/v1/chat/completions']), 'openai-completions');
  });

  it('网关完全不公布端点时，按 OpenAI 兼容假定', () => {
    assert.equal(classifyProtocol([]), 'openai-completions');
  });
});

describe('在真实 Aperture 清单上运行 buildRegistry', () => {
  it('归一化每一行', () => {
    assert.equal(registry().models.length, 16);
  });

  it('按网关实际提供的传输方式拆分模型清单', () => {
    const { models, unserved } = registry();
    const openai = models.filter((model) => model.protocol === 'openai-completions');
    const anthropic = models.filter((model) => model.protocol === 'anthropic-messages');
    assert.equal(openai.length, 11);
    assert.equal(anthropic.length, 1);
    assert.equal(anthropic[0]?.id, 'MiniMax-M3');
    // Gemini 模型只能通过原生的 generateContent 传输方式访问，
    // 而 Aperture 在 /v1/chat/completions 上对它们返回 404。
    assert.deepEqual(
      unserved.map((model) => model.id),
      ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-3.1-flash-image-preview'],
    );
  });

  it('用参考实现尚未覆盖的网关字段为模型定容量', () => {
    const flash = registry().models.find((model) => model.id === 'deepseek-flash');
    assert.equal(flash?.contextWindow, 1_048_576);
    assert.equal(flash?.maxTokens, 384_000);
    assert.equal(flash?.provenance.limits, 'aperture');
  });

  it('用网关的显示名给模型命名', () => {
    const flash = registry().models.find((model) => model.id === 'deepseek-flash');
    assert.equal(flash?.name, 'DeepSeek V4.1 Flash');
    assert.equal(flash?.provenance.name, 'aperture');
  });

  it('从清单补齐推理能力', () => {
    const mimo = registry().models.find((model) => model.id === 'mimo-v2.6-flash');
    assert.equal(mimo?.reasoning, true);
    assert.equal(mimo?.provenance.reasoning, 'models.dev');
  });

  it('清单无法归位的 id 不猜推理能力', () => {
    const flash = registry().models.find((model) => model.id === 'deepseek-flash');
    assert.equal(flash?.reasoning, false);
    assert.equal(flash?.provenance.reasoning, 'default');
  });

  it('除非接受图片元数据，否则声明为纯文本', () => {
    assert.deepEqual(registry().models.find((model) => model.id === 'mimo-v2.6-flash')?.input, ['text']);
    assert.deepEqual(
      registry({ images: 'metadata' }).models.find((model) => model.id === 'mimo-v2.6-flash')?.input,
      ['text', 'image'],
    );
  });

  it('关闭推理时，声明所有模型都不推理', () => {
    assert.equal(
      registry({ reasoning: 'off' }).models.some((model) => model.reasoning),
      false,
    );
  });

  it('报告上游 provider', () => {
    assert.equal(registry().models.find((model) => model.id === 'x-ai/grok-4.5')?.provider, 'openrouter');
  });
});

describe('buildRegistry 的配置行为', () => {
  it('把清单限制在 enabledModelIds 之内', () => {
    const { models } = registry({ enabledModelIds: ['deepseek-flash', 'MiniMax-M3'] });
    assert.deepEqual(
      models.map((model) => model.id),
      ['deepseek-flash', 'MiniMax-M3'],
    );
  });

  it('仍然加入网关没有公布的配置模型', () => {
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

  it('只覆盖配置条目声明了的字段', () => {
    const { models } = registry({ models: [{ id: 'deepseek-flash', name: 'Flash (pinned)' }] });
    const flash = models.find((model) => model.id === 'deepseek-flash');
    assert.equal(flash?.name, 'Flash (pinned)');
    assert.equal(flash?.provenance.name, 'config');
    // 未触及的字段保留网关自己的答案。
    assert.equal(flash?.contextWindow, 1_048_576);
    assert.equal(flash?.provenance.limits, 'aperture');
  });

  it('让配置为一个只在不可服务传输上提供的模型兜底', () => {
    const { unserved } = registry({ models: [{ id: 'gemini-2.5-pro', api: 'openai-completions' }] });
    assert.equal(
      unserved.some((model) => model.id === 'gemini-2.5-pro'),
      false,
    );
  });

  it('跨过清单里写法不同的 id', () => {
    const aliased = registry({
      modelAliases: { 'deepseek-flash': 'deepseek/deepseek-v4-flash', k3: 'moonshotai/kimi-k3' },
    });
    assert.equal(aliased.models.find((model) => model.id === 'deepseek-flash')?.reasoning, true);
    assert.equal(aliased.models.find((model) => model.id === 'k3')?.reasoning, true);
    assert.equal(aliased.models.find((model) => model.id === 'k3')?.name, 'Kimi K3');
  });

  it('不臆造输出上限，但总要给出上下文容量', () => {
    const { models } = buildRegistry([{ id: 'bare' }], options(), undefined);
    assert.equal(models[0]?.contextWindow, 128_000);
    assert.equal(models[0]?.maxTokens, undefined);
  });
});
