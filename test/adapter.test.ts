/**
 * 适配器：模型描述符的构造、元数据查询、以及 pi-ai 事件流到宿主块的转换。
 *
 * 这些是端到端那一份（`test/live.test.ts`）证明不了的细节：一条被钉死的推理档位表长什么样、
 * 缺省输出上限只活在 pi-ai 侧这一条边界、以及**失败**路径——pi-ai 把失败当作流里的终态事件，
 * 而宿主的重试策略按机器码判断该不该重试。端到端那一条只跑得通正常路径，失败路径只能在这里钉。
 *
 * 这里一次网络请求都不发：模型描述符是纯数据，事件流是自造的，而快照那一条打到一个没人监听的
 * 本地端口（连接被立刻拒绝，正是「已经走到传输层」的证据）。
 *
 * @module dsh-aperture/test/adapter
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { ApertureAdapter } from '../src/adapter/index.ts';
import { buildModel, supportedEfforts } from '../src/adapter/route.ts';
import { toStreamChunks } from '../src/adapter/stream.ts';
import { DEFAULT_CONTEXT_WINDOW } from '../src/config.ts';
import type { ModelProfile, RoutePlan, RouteProfile } from '../src/profile.ts';
import type { RuntimeLogger } from '../src/runtime.ts';
import type { DiscoveredModel } from '../src/types.ts';

/** 什么都不输出的 logger。 */
const quiet: RuntimeLogger = { error() {}, info() {}, warn() {}, debug() {} };

/** 一条路由。 */
function route(overrides: Partial<RouteProfile> = {}, provider = 'aperture'): RoutePlan {
  const profile: RouteProfile = {
    displayName: 'Aperture',
    api: 'openai-completions',
    baseURL: 'https://ai.example.ts.net/v1',
    models: [],
    ...overrides,
  };
  return { provider, profile, models: profile.models.map(discovered) };
}

/** 报告侧的那个模型，与 profile 里的条目同 id。 */
function discovered(model: ModelProfile): DiscoveredModel {
  return {
    id: model.id,
    name: model.name,
    protocol: 'openai-completions',
    endpoints: ['/v1/chat/completions'],
    input: [...model.input],
    reasoning: model.reasoningEfforts !== undefined,
    provenance: { limits: 'aperture', reasoning: 'aperture', input: 'config', name: 'aperture' },
  };
}

/** 一个模型条目。 */
function model(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return { id: 'm', name: 'M', input: ['text'], ...overrides };
}

/** 一个服务一份固定路由集合的适配器。 */
function adapter(plans: readonly RoutePlan[]): ApertureAdapter {
  return new ApertureAdapter({
    routes: () => plans,
    resolveApiKey: () => Promise.resolve(undefined),
    attachments: () => undefined,
    logger: quiet,
  });
}

/** 一个 pi-ai 助手消息，字段取事件流里真正会出现的那些。 */
function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'aperture',
    model: 'm',
    usage: {
      input: 11,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 14,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

/** 把一串事件当流递给转换器。 */
async function* events(...list: readonly AssistantMessageEvent[]): AsyncIterable<AssistantMessageEvent> {
  for (const event of list) yield event;
}

/** 收下一个流式转换的全部块。 */
async function chunks(
  stream: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
): Promise<Array<Record<string, unknown>>> {
  const collected: Array<Record<string, unknown>> = [];
  for await (const chunk of toStreamChunks(stream, {
    provider: 'aperture',
    model: 'm',
    ...(contextWindow === undefined ? {} : { contextWindow }),
  })) {
    collected.push(chunk as unknown as Record<string, unknown>);
  }
  return collected;
}

describe('buildModel', () => {
  it('把缺省容量补成 pi-ai 坚持要的字段，同时不改变「没声明过」这件事', () => {
    const built = buildModel('aperture', route().profile, model());
    assert.equal(built.contextWindow, DEFAULT_CONTEXT_WINDOW);
    assert.equal(built.maxTokens, 32_768);
    assert.equal(built.reasoning, false);
    assert.equal(built.baseUrl, 'https://ai.example.ts.net/v1');
    assert.equal(built.provider, 'aperture');
    assert.deepEqual(built.input, ['text']);
  });

  it('把未声明的档位钉成不支持，只放行声明过的那些', () => {
    const built = buildModel('aperture', route().profile, model({
      reasoningEfforts: { off: 'disabled', high: 'high', max: 'max' },
    }));
    assert.equal(built.reasoning, true);
    assert.deepEqual(built.thinkingLevelMap, {
      minimal: null,
      low: null,
      medium: null,
      xhigh: null,
      off: 'disabled',
      high: 'high',
      max: 'max',
    });
    assert.deepEqual([...supportedEfforts(built)], ['off', 'high', 'max']);
  });

  it('把「off 没有线缆写法」表达成「支持，但什么都不发」', () => {
    const built = buildModel('aperture', route().profile, model({
      reasoningEfforts: { off: null, high: 'high' },
    }));
    // 关键差别：这个键**不在**表里（而不是 null）。pi-ai 把缺键读作「支持、发空」，
    // 把 null 读作「不支持」——两者在线上正是「不发思考参数」与「拒绝该档位」的差别。
    assert.equal('off' in (built.thinkingLevelMap ?? {}), false);
    assert.deepEqual([...supportedEfforts(built)], ['off', 'high']);
  });

  it('随协议带上兼容开关', () => {
    const completions = buildModel('aperture', route().profile, model({
      reasoningEfforts: { off: null, high: 'high' },
      compat: { supportsReasoningEffort: true, thinkingFormat: 'deepseek' },
    }));
    assert.deepEqual(completions.compat, { supportsReasoningEffort: true, thinkingFormat: 'deepseek' });
  });
});

describe('适配器的元数据', () => {
  it('按路由报出显示名与模型清单', async () => {
    const plan = route({ models: [model({ id: 'a' }), model({ id: 'b', input: ['text', 'image'] })] });
    const built = adapter([plan]);

    assert.deepEqual(built.providerInfo('aperture'), { id: 'aperture', name: 'Aperture' });
    assert.deepEqual(await built.listModels('aperture'), [
      { provider: 'aperture', id: 'a', name: 'M', inputModalities: ['text'] },
      { provider: 'aperture', id: 'b', name: 'M', inputModalities: ['text', 'image'] },
    ]);
    assert.deepEqual(await built.listModels('nobody'), [], '不服务的路由给空清单，而不是抛');
  });

  it('只在模型自己声明过输出上限时才把它当默认值交出去', async () => {
    const declared = adapter([route({ models: [model({ id: 'a', maxTokens: 4096 })] })]);
    assert.equal((await declared.resolveModel('aperture', 'a')).defaultMaxTokens, 4096);

    // 没声明过上限的模型不该被本插件钉上一个凭空的默认：缺省上限只活在 pi-ai 侧的请求上。
    const undeclared = adapter([route({ models: [model({ id: 'a' })] })]);
    assert.equal('defaultMaxTokens' in (await undeclared.resolveModel('aperture', 'a')), false);
  });

  it('只在模型提供了档位时才报推理档位', async () => {
    const built = adapter([route({
      models: [
        model({ id: 'thinking', reasoningEfforts: { off: null, high: 'high' } }),
        model({ id: 'plain' }),
      ],
    })]);
    const thinking = await built.resolveModel('aperture', 'thinking');
    assert.deepEqual(thinking.reasoning?.efforts.map((effort) => String(effort.id)), ['off', 'high']);
    assert.equal((await built.resolveModel('aperture', 'plain')).reasoning, undefined);
  });

  it('不认识的模型只回显身份，而不是编造容量', async () => {
    const built = adapter([route({ models: [model()] })]);
    assert.deepEqual(await built.resolveModel('aperture', 'ghost'), {
      provider: 'aperture',
      id: 'ghost',
      name: 'ghost',
    });
  });
});

describe('适配器的派发边界', () => {
  it('拒绝不支持的推理档位，而不是把它悄悄丢掉', async () => {
    const built = adapter([route({ models: [model({ reasoningEfforts: { off: null, high: 'high' } })] })]);
    await assert.rejects(
      () => drain(built.stream({
        provider: 'aperture',
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        reasoningEffort: 'max' as never,
      })),
      /不支持推理档位 "max"/u,
    );
  });

  it('拒绝 stop 序列：pi-ai 没有这条路，装作支持只会静默丢掉它', async () => {
    const built = adapter([route({ models: [model()] })]);
    await assert.rejects(
      () => drain(built.stream({
        provider: 'aperture',
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        stop: ['###'],
      })),
      /不支持 GenerateOptions.stop/u,
    );
  });

  it('不服务的路由在派发时响亮抛出', async () => {
    const built = adapter([route({ models: [model()] })]);
    await assert.rejects(
      () => drain(built.stream({
        provider: 'nobody',
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })),
      /路由 "nobody" 上没有模型 "m"/u,
    );
  });

  it('prepareCall 把派发绑在那一代路由上：之后的刷新不会换掉端点', async () => {
    let plans: RoutePlan[] = [route({
      baseURL: 'http://127.0.0.1:1/v1',
      models: [model({ id: 'only-here' })],
    })];
    const built = new ApertureAdapter({
      routes: () => plans,
      resolveApiKey: () => Promise.resolve(undefined),
      attachments: () => undefined,
      logger: quiet,
    });

    const prepared = await built.prepareCall('aperture', 'only-here');
    assert.equal(prepared.model.id, 'only-here');

    // 刷新把整份路由换掉：这个模型在新一代里不存在。
    plans = [route({ models: [model({ id: 'something-else' })] })];

    // 直接派发走的是新一代，因此这个模型不认识。
    await assert.rejects(
      () => drain(built.stream({
        provider: 'aperture',
        model: 'only-here',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })),
      /路由 "aperture" 上没有模型 "only-here"/u,
    );

    // 而准备好的那一代照旧往前走：它已经走到传输层（127.0.0.1:1 没人监听），
    // 而不是在模型解析处停下——这正是「能力与端点属于同一代」的证据。
    const errorChunk = await lastFinish(prepared.stream({
      provider: 'aperture',
      model: 'only-here',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }));
    assert.equal(errorChunk?.['kind'], 'error');
    assert.notEqual(errorChunk?.['failure'], undefined);
  });
});

/** 收完一条流并返回它的终止原因。 */
async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // 读完即弃。
  }
}

/** 收完一条流并返回 `finish` 块里的原因。 */
async function lastFinish(stream: AsyncIterable<unknown>): Promise<Record<string, unknown> | undefined> {
  let reason: Record<string, unknown> | undefined;
  for await (const chunk of stream) {
    const record = chunk as Record<string, unknown>;
    if (record.type === 'finish') reason = record.reason as Record<string, unknown>;
  }
  return reason;
}

describe('pi-ai 事件流的转换', () => {
  it('块的开闭、增量和文本内容按流序给出', async () => {
    const converted = await chunks(events(
      { type: 'start', partial: assistant([]) },
      { type: 'text_start', contentIndex: 0, partial: assistant([]) },
      { type: 'text_delta', contentIndex: 0, delta: 'po', partial: assistant([]) },
      { type: 'text_delta', contentIndex: 0, delta: 'ng', partial: assistant([]) },
      { type: 'text_end', contentIndex: 0, content: 'pong', partial: assistant([]) },
      { type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: 'pong' }]) },
    ));
    assert.deepEqual(converted.map((chunk) => chunk.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish']);
    assert.deepEqual(converted[3]?.['block'], { type: 'text', text: 'pong' });
    assert.deepEqual(converted[4]?.['usage'], { inputTokens: 11, outputTokens: 3, totalTokens: 14 });
    assert.deepEqual(converted[5]?.['reason'], { kind: 'stop' });
  });

  it('工具参数的片段原样转发，收尾时把对象重新串化成字符串', async () => {
    const converted = await chunks(events(
      { type: 'start', partial: assistant([]) },
      // pi-ai 在开块那一刻可能还没把 id 写进块里：片段事件因此允许 id 为空、名字缺失。
      { type: 'toolcall_start', contentIndex: 0, partial: assistant([{ type: 'toolCall', id: '', name: '', arguments: {} }]) },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"a":', partial: assistant([]) },
      { type: 'toolcall_delta', contentIndex: 0, delta: '1}', partial: assistant([]) },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'call-1', name: 'read', arguments: { a: 1 } },
        partial: assistant([]),
      },
      { type: 'done', reason: 'toolUse', message: assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { a: 1 } }], 'toolUse') },
    ));

    assert.deepEqual(converted.map((chunk) => chunk.type), [
      'block-start',
      'tool-call-delta',
      'tool-call-delta',
      'block-end',
      'usage',
      'finish',
    ]);
    assert.deepEqual(converted[0], { type: 'block-start', index: 0, blockType: 'tool-call' });
    assert.deepEqual(converted[1], { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{"a":' });
    assert.deepEqual(converted[3]?.['block'], { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"a":1}' });
    assert.deepEqual(converted.at(-1)?.['reason'], { kind: 'tool-calls' });
  });

  it('没有内容却正常结束，是按错误上报的（否则整轮对话会安静地什么都不产生）', async () => {
    const converted = await chunks(events(
      { type: 'start', partial: assistant([]) },
      { type: 'done', reason: 'stop', message: assistant([]) },
    ));
    assert.deepEqual(converted.at(-1)?.['reason'], {
      kind: 'error',
      failure: { message: 'dsh-aperture: 模型 "m" 正常结束却没有产出任何内容', code: 'EMPTY_RESPONSE' },
    });
  });

  it('长度截断是 max-tokens，而不是错误', async () => {
    const converted = await chunks(events(
      { type: 'start', partial: assistant([]) },
      { type: 'done', reason: 'length', message: assistant([{ type: 'text', text: 'x' }], 'length') },
    ));
    assert.deepEqual(converted.at(-1)?.['reason'], { kind: 'max-tokens' });
  });

  it('把失败事件翻成带机器码的 error 终止，并按文本分类', async () => {
    const failed = assistant([], 'error');
    const converted = await chunks(events(
      { type: 'start', partial: assistant([]) },
      {
        type: 'error',
        reason: 'error',
        error: { ...failed, errorMessage: 'OpenAI API error 429: rate limit reached' },
      },
    ));
    assert.deepEqual(converted.map((chunk) => chunk.type), ['usage', 'finish']);
    assert.deepEqual(converted[1]?.['reason'], {
      kind: 'error',
      failure: { message: 'OpenAI API error 429: rate limit reached', code: 'RATE_LIMIT' },
    });
  });

  it('调用方已经中止时，终态错误说成中止', async () => {
    const controller = new AbortController();
    controller.abort();
    const collected: Array<Record<string, unknown>> = [];
    for await (const chunk of toStreamChunks(events(
      { type: 'start', partial: assistant([]) },
      { type: 'error', reason: 'error', error: { ...assistant([], 'error'), errorMessage: 'socket hang up' } },
    ), { provider: 'aperture', model: 'm', signal: controller.signal })) {
      collected.push(chunk as unknown as Record<string, unknown>);
    }
    assert.equal((collected.at(-1)?.['reason'] as Record<string, unknown>)['kind'], 'aborted');
  });

  it('把上下文溢出认出来，包括「成功返回却超出容量」这种静默溢出', async () => {
    const explicit = await chunks(events(
      { type: 'start', partial: assistant([]) },
      {
        type: 'error',
        reason: 'error',
        error: { ...assistant([], 'error'), errorMessage: 'This model\'s maximum context length is 4096 tokens' },
      },
    ));
    assert.equal(((explicit.at(-1)?.['reason'] as Record<string, unknown>)['failure'] as Record<string, unknown>)['code'], 'CONTEXT_WINDOW_EXCEEDED');

    // 静默溢出：请求被接受并且正常结束，只能靠用量比出容量。
    const silent = await chunks(events(
      { type: 'start', partial: assistant([]) },
      {
        type: 'done',
        reason: 'stop',
        message: {
          ...assistant([{ type: 'text', text: 'ok' }]),
          usage: { ...assistant([]).usage, input: 5000, output: 1, totalTokens: 5001 },
        },
      },
    ), 4096);
    assert.equal(((silent.at(-1)?.['reason'] as Record<string, unknown>)['failure'] as Record<string, unknown>)['code'], 'CONTEXT_WINDOW_EXCEEDED');
  });

  it('事件流没有终态事件时抛出，而不是当成一次空回答', async () => {
    await assert.rejects(
      () => chunks(events(
        { type: 'start', partial: assistant([]) },
        { type: 'text_start', contentIndex: 0, partial: assistant([]) },
        { type: 'text_delta', contentIndex: 0, delta: 'po', partial: assistant([]) },
      )),
      /没有以 done\/error 收尾/u,
    );
  });

  it('重放信封按块首次出现的顺序对齐，并且只在本插件自己的响应上出现', async () => {
    const message: AssistantMessage = {
      ...assistant([
        { type: 'thinking', thinking: '想', thinkingSignature: 'sig-1' },
        { type: 'text', text: 'pong', textSignature: 'txt-1' },
      ]),
      responseId: 'resp-1',
    };
    const converted = await chunks(events(
      { type: 'start', partial: assistant([]) },
      { type: 'thinking_start', contentIndex: 0, partial: assistant([]) },
      { type: 'thinking_delta', contentIndex: 0, delta: '想', partial: assistant([]) },
      { type: 'thinking_end', contentIndex: 0, content: '想', partial: assistant([]) },
      { type: 'text_start', contentIndex: 1, partial: assistant([]) },
      { type: 'text_delta', contentIndex: 1, delta: 'pong', partial: assistant([]) },
      { type: 'text_end', contentIndex: 1, content: 'pong', partial: assistant([]) },
      { type: 'done', reason: 'stop', message },
    ));

    const finish = converted.at(-1);
    assert.deepEqual(finish?.['replayState'], {
      response: {
        kind: 'aperture',
        version: 1,
        api: 'openai-completions',
        provider: 'aperture',
        model: 'm',
        responseId: 'resp-1',
        stopReason: 'stop',
      },
      blocks: [{ thinkingSignature: 'sig-1' }, { textSignature: 'txt-1' }],
    });
  });
});
