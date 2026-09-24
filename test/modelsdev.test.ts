import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCatalogIndex, buildCatalogLookup, type ModelCatalogIndex } from '../src/metadata/modelsdev.ts';
import type { CatalogLookup } from '../src/types.ts';
import { catalogDocument } from './helpers.ts';

const lookup = buildCatalogLookup(catalogDocument());

/** 构建一份必定成功的索引，使测试只陈述自己要验证的事实。 */
function indexOf(document: unknown): ModelCatalogIndex {
  const index = buildCatalogIndex(document);
  if (index === undefined) {
    throw new Error('测试文档应当产出可用索引');
  }
  return index;
}

/** 同上，但返回面向网关模型的查找函数。 */
function lookupOf(document: unknown): CatalogLookup {
  const built = buildCatalogLookup(document);
  if (built === undefined) {
    throw new Error('测试文档应当产出可用查找');
  }
  return built;
}

describe('models.dev 查询', () => {
  it('匹配一个被网关改过厂商前缀的 id', () => {
    const found = lookup?.({ id: 'x-ai/grok-4.5', provider: 'openrouter' });
    assert.equal(found?.reasoning, true);
    assert.deepEqual(found?.input, ['text', 'image']);
  });

  it('provider 别名命中压过更高的键得分', () => {
    // 两条目录条目撞在同一个 slug 键 'gpt-5-2' 上：acme 条目的键与网关 id 的
    // 末段逐字相同（原始得分 120），openai 条目只能靠折叠标点命中（原始得分 110）。
    // 网关把上游报成 openai 时，200 分的别名加成必须让得分更低的那条胜出。
    // 网关自己的前缀（openrouter）不是任何条目的别名，否则它会替其中一条加分。
    const index = indexOf({
      'acme/gpt-5.2': { id: 'acme/gpt-5.2', contextWindow: 222, reasoning: false },
      'openai/gpt-5-2': { id: 'openai/gpt-5-2', contextWindow: 111, reasoning: true },
    });
    assert.equal(index.lookup('openrouter/gpt-5.2')?.contextWindow, 222, '没有 provider 线索时按原始键得分取 acme 条目');
    assert.equal(index.lookup('openrouter/gpt-5.2', ['openai'])?.contextWindow, 111, '别名命中应当反超原始键得分');
    assert.equal(index.lookup('openrouter/gpt-5.2', ['openai'])?.reasoning, true);
  });

  it('靠厂商前缀线索匹配裸 id', () => {
    // 注意：这里的裸 id 之所以解析得出来，是因为它本身就是条目键的一段，
    // 与线索无关；线索只在多个候选相撞时决定谁赢（见下面两个用例）。
    const found = lookup?.({ id: 'mimo-v2.6-flash', provider: 'xiaomimimo' });
    assert.equal(found?.reasoning, true);
    assert.equal(found?.contextWindow, 1_048_576);
  });

  it('键等值的裸 id 不靠 provider 线索也能解析', () => {
    // 文档正文声称裸别名只有被提示桥接后才解析得出来。评分只在「多个候选」
    // 之间比较，所以一个键等值的条目哪怕是唯一候选、provider 加成为 0 也会胜出；
    // 线索并不参与「能否命中」，只参与「命中若干条时选谁」。
    const index = indexOf({ 'xiaomi/mimo-9': { id: 'xiaomi/mimo-9', reasoning: true } });
    assert.equal(index.lookup('mimo-9')?.reasoning, true, '唯一候选不需要线索');
    assert.equal(index.lookup('mimo-9', ['xiaomi'])?.reasoning, true, '带线索时结果相同');
    assert.equal(lookup?.({ id: 'mimo-v2.6-flash' })?.contextWindow, 1_048_576, '录制文档里的裸 id 同样不需要线索');
  });

  it('同一键上的裸别名靠 provider 线索分辨', () => {
    const index = indexOf({
      providers: {
        alpha: { id: 'alpha', models: { turbo: { id: 'turbo', contextWindow: 111 } } },
        beta: { id: 'beta', models: { turbo: { id: 'turbo', contextWindow: 222 } } },
      },
    });
    assert.equal(index.size, 2);
    assert.equal(index.lookup('turbo', ['beta'])?.contextWindow, 222);
    assert.equal(index.lookup('turbo', ['alpha'])?.contextWindow, 111);
    assert.equal(index.lookup('turbo', ['gamma'])?.contextWindow, 111, '线索都不匹配时两候选同分，取先插入的条目');
  });

  it('匹配只有大小写差异的 id', () => {
    assert.equal(lookup?.({ id: 'MiniMax-M3', provider: 'minimax' })?.reasoning, true);
    assert.equal(lookup?.({ id: 'LongCat-2.0', provider: 'longcat' })?.reasoning, true);
  });

  it('匹配带厂商前缀的 slug 形式 id', () => {
    assert.equal(lookup?.({ id: 'Qwen/Qwen3.6-35B-A3B', provider: 'siliconflow' })?.reasoning, true);
    assert.equal(lookup?.({ id: 'deepseek-ai/DeepSeek-V4-Flash', provider: 'siliconflow' })?.reasoning, true);
  });

  it('标点与大小写折叠让同一模型的不同写法互相命中', () => {
    const index = indexOf({ 'MiniMax/M3': { id: 'MiniMax/M3', reasoning: true } });
    assert.equal(index.lookup('MiniMax-M3')?.reasoning, true, '连字符写法');
    assert.equal(index.lookup('minimax_m3')?.reasoning, true, '下划线写法');
    assert.equal(index.lookup('MINIMAX.M3')?.reasoning, true, '点号与大写写法');
  });

  it('扁平映射把完整 id、最后一段与模型 name 都索引为查询键', () => {
    const index = indexOf({
      'vendor/Fancy-Model-X': { name: 'Fancy Model X', reasoning: true },
      'bare-model': { id: 'bare-model', limit: { context: 4_096 } },
    });
    assert.equal(index.lookup('vendor/Fancy-Model-X')?.reasoning, true, '完整 id');
    assert.equal(index.lookup('Fancy-Model-X')?.reasoning, true, '最后一个 / 之后的分段');
    assert.equal(index.lookup('fancy model x')?.reasoning, true, 'name 也被索引');
    assert.equal(index.lookup('bare-model')?.contextWindow, 4_096, '条目缺 id 时以键为 id，且无 / 时没有 provider 别名');
  });

  it('也能读取顶层以 provider 为键、值携带 models 的文档', () => {
    const providerShaped = lookupOf({
      deepseek: {
        id: 'deepseek',
        models: { 'deepseek-chat': { id: 'deepseek-chat', reasoning: true, limit: { output: 8_192 } } },
      },
    });
    assert.equal(providerShaped({ id: 'deepseek-chat' })?.reasoning, true);
    assert.equal(providerShaped({ id: 'deepseek-chat' })?.maxTokens, 8_192);
  });

  it('也能读取以 provider 为键的文档', () => {
    const providerShaped = buildCatalogLookup({
      providers: {
        deepseek: { id: 'deepseek', name: 'DeepSeek', models: { 'deepseek-chat': { id: 'deepseek-chat', reasoning: true } } },
      },
    });
    assert.equal(providerShaped?.({ id: 'deepseek-chat' })?.reasoning, true);
  });

  it('也能读取 models 之下嵌套的映射', () => {
    const nested = lookupOf({ models: { 'deepseek/deepseek-chat': { reasoning: true } } });
    assert.equal(nested({ id: 'deepseek-chat' })?.reasoning, true, '按最后一段命中');
    assert.equal(nested({ id: 'deepseek/deepseek-chat' })?.reasoning, true, '按完整 id 命中');
  });

  it('models 之下嵌套的 provider 映射与 providers 之下同样读得出模型', () => {
    // 两种包装里装的都可能是 provider 映射，读法因此不分包装：按 provider 值有没有
    // `models` 判断，而不是按包装的名字判断。
    const nested = lookupOf({
      models: {
        openai: { id: 'openai', name: 'OpenAI', models: { gpt: { id: 'gpt', reasoning: true, limit: { context: 128_000 } } } },
      },
    });
    assert.equal(nested({ id: 'gpt' })?.reasoning, true);
    assert.equal(nested({ id: 'gpt', provider: 'openai' })?.contextWindow, 128_000);
  });

  it('没有可用条目的文档一律不给答案', () => {
    assert.equal(buildCatalogLookup({}), undefined);
    assert.equal(buildCatalogLookup(undefined), undefined);
    assert.equal(buildCatalogLookup({ providers: {} }), undefined);
    assert.equal(buildCatalogLookup({ models: [] }), undefined, 'models 不是对象');
  });

  it('整份文档都没有可用元数据时不给查找', () => {
    assert.equal(buildCatalogLookup({ 'vendor/model': { description: '只有描述' } }), undefined);
    assert.equal(buildCatalogLookup({ 'vendor/model': { reasoning: 'yes', input: 'image' } }), undefined, '非布尔 reasoning 与非数组 input 都不算元数据');
  });

  it('索引大小只数可用的条目', () => {
    const index = indexOf({
      'a/m': { reasoning: true },
      'b/m': { description: '没有可用字段' },
      'c/m': { name: '   ' },
    });
    assert.equal(index.size, 1, '没有元数据的条目不计数');

    const providerShaped = indexOf({
      providers: {
        alpha: { models: { a: { reasoning: true }, b: { description: '没有可用字段' } } },
        beta: { models: { c: { reasoning: false } } },
      },
    });
    assert.equal(providerShaped.size, 2, 'reasoning: false 也是有效声明');
  });

  it('给出容量与输出上限', () => {
    const found = lookup?.({ id: 'deepseek-v4-pro', provider: 'deepseek' });
    assert.equal(found?.contextWindow, 1_000_000);
    assert.equal(found?.maxTokens, 384_000);
  });

  it('上下文容量接受 limit.context、limit.input、context_length 与 max_input_tokens', () => {
    const index = indexOf({
      'p/limit-context': { limit: { context: 100_000 } },
      'p/limit-input': { limit: { input: 200_000 } },
      'p/context-length': { context_length: 300_000 },
      'p/max-input-tokens': { max_input_tokens: '1.5M' },
    });
    assert.equal(index.lookup('limit-context')?.contextWindow, 100_000);
    assert.equal(index.lookup('limit-input')?.contextWindow, 200_000);
    assert.equal(index.lookup('context-length')?.contextWindow, 300_000);
    assert.equal(index.lookup('max-input-tokens')?.contextWindow, 1_500_000, '接受 1.5M 这类字符串写法');
  });

  it('输出上限接受 limit.output、top_provider.max_completion_tokens、max_tokens 与 max_output_tokens', () => {
    const index = indexOf({
      'p/limit-output': { limit: { output: 8_192 } },
      'p/max-completion-tokens': { top_provider: { max_completion_tokens: 16_384 } },
      'p/max-tokens': { max_tokens: 32_768 },
      'p/max-output-tokens': { max_output_tokens: 65_536 },
    });
    assert.equal(index.lookup('limit-output')?.maxTokens, 8_192);
    assert.equal(index.lookup('max-completion-tokens')?.maxTokens, 16_384);
    assert.equal(index.lookup('max-tokens')?.maxTokens, 32_768);
    assert.equal(index.lookup('max-output-tokens')?.maxTokens, 65_536);
  });

  it('reasoning 只在严格布尔值时被采纳', () => {
    const index = indexOf({
      'p/string-reasoning': { reasoning: 'true', limit: { context: 1_000 } },
      'p/number-reasoning': { reasoning: 1 },
      'p/boolean-reasoning': { reasoning: false },
    });
    assert.deepEqual(index.lookup('string-reasoning'), { contextWindow: 1_000 }, '字符串 reasoning 不产生 reasoning 字段');
    assert.equal(index.lookup('number-reasoning'), undefined, '数字 reasoning 不是可用元数据');
    assert.equal(index.lookup('boolean-reasoning')?.reasoning, false, 'false 同样是有效声明');
  });

  it('输入模态取自 modalities.input 与顶层 input，vision 记为 image', () => {
    const index = indexOf({
      'p/nested': { modalities: { input: ['text', 'vision', 'audio'] } },
      'p/vision-only': { modalities: { input: ['vision'] } },
      'p/top-level': { input: ['image'] },
      'p/unknown-only': { input: ['audio'] },
    });
    assert.deepEqual(index.lookup('nested')?.input, ['text', 'image'], '未知标签被忽略');
    assert.deepEqual(index.lookup('vision-only')?.input, ['image'], 'vision 记为 image');
    assert.deepEqual(index.lookup('top-level')?.input, ['image'], '顶层 input 同样被读取');
    assert.equal(index.lookup('unknown-only'), undefined, '只含未知标签时该条目没有可用元数据');
  });

  it('清单里没有的 id 一律不给答案', () => {
    // 网关给 DeepSeek flash 模型起的别名，正是打分跨不过去的那类偏差；
    // 部署要靠 `modelAliases` 才能跨过它。
    assert.equal(lookup?.({ id: 'deepseek-flash', provider: 'deepseek' }), undefined);
    assert.equal(lookup?.({ id: 'k3', provider: 'kimi-code' }), undefined);
  });
});
