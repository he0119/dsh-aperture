/**
 * `fetchModelsListing` 与 `readEntries` 的端点、请求头、上限与拒绝路径。
 *
 * 这是插件唯一会因外部世界而出错的地方：端点拼错、请求头丢了、一个 5 MiB 的错误页
 * 被当成清单、或者一份不认识的响应体被静默读成空清单 —— 任何一种都会让「刷新」看
 * 起来成功，而空清单会覆盖掉一份可用的清单。所以这里钉住的是每条拒绝路径**说出的
 * 那句话**：端点必须出现在里面，上限与被拒绝的字节数必须同时出现。
 *
 * 每个用例都替换 `globalThis.fetch`，不发出任何真实请求。
 *
 * @module dsh-aperture/test/aperture
 */

import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { fetchModelsListing, readEntries } from '../src/aperture.ts';
import { apertureEntries } from './helpers.ts';

const ROOT = 'https://ai.example.ts.net';
const ENDPOINT = 'https://ai.example.ts.net/v1/models';
const LIMIT = 4 * 1024 * 1024;

/** 一次被抓到的调用。 */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/**
 * 把全局 `fetch` 换成一个受控的桩，并在本用例结束后恢复。
 *
 * @param t - 用例上下文，桩的恢复挂在这里。
 * @param respond - 按 URL 产生应答；返回一个不落定的 promise 即模拟一次挂起的请求。
 * @returns 按发生顺序记录的调用。
 */
function stubFetch(
  t: TestContext,
  respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    return await respond(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** 一个只实现 `fetchModelsListing` 真正读到的字段的应答。 */
function fakeResponse(fields: { headers?: Record<string, string>; text?: () => Promise<string> }): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(fields.headers),
    text: fields.text ?? (async (): Promise<string> => ''),
  } as unknown as Response;
}

/** 断言一个拒绝：错误是 Error，并且点名端点。 */
function endpointError(error: unknown): true {
  assert.ok(error instanceof Error, '拒绝的必须是 Error');
  assert.ok(error.message.includes(ENDPOINT), `错误里要点名端点：${error.message}`);
  return true;
}

describe('fetchModelsListing', () => {
  it('请求实例根的 /v1/models，并把条目按端点顺序交回', async (t) => {
    const entries = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];
    const calls = stubFetch(t, () => new Response(JSON.stringify({ data: entries }), { status: 200 }));
    const listing = await fetchModelsListing(ROOT);

    assert.deepEqual(
      calls.map((call) => call.url),
      [ENDPOINT],
      '端点由实例根推导，且只请求一次',
    );
    assert.equal(listing.endpoint, ENDPOINT);
    assert.deepEqual(listing.entries, entries, '顺序原样保留');
  });

  it('录下来的清单整份通过', async (t) => {
    const entries = apertureEntries();
    stubFetch(t, () => new Response(JSON.stringify({ data: entries }), { status: 200 }));
    const listing = await fetchModelsListing(ROOT);

    assert.equal(listing.entries.length, entries.length);
    assert.deepEqual(listing.entries[0], entries[0], '第一条也没有被改写');
    assert.deepEqual(listing.entries.at(-1), entries.at(-1));
  });

  it('只剥掉结尾的斜杠；结尾的 /v1 归调用方先归一化', async (t) => {
    stubFetch(t, () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    // `buildModelsEndpoint` 只做 `stripTrailingSlashes` 再拼 `/v1/models`：剥掉结尾
    // `/v1` 是 `normalizeBaseUrl` 的职责，所以这里钉住的契约是「参数已归一化」。
    assert.equal((await fetchModelsListing(`${ROOT}/`)).endpoint, ENDPOINT, '结尾斜杠被容忍');
    assert.equal(
      (await fetchModelsListing(`${ROOT}/v1`)).endpoint,
      'https://ai.example.ts.net/v1/v1/models',
      '本函数不会替调用方剥 /v1',
    );
  });

  it('带上 accept: application/json 与调用方的额外请求头', async (t) => {
    const calls = stubFetch(t, () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await fetchModelsListing(ROOT, { headers: { 'x-api-key': 'secret' } });
    assert.equal(calls[0]?.init?.method, 'GET');
    assert.deepEqual(calls[0]?.init?.headers, { accept: 'application/json', 'x-api-key': 'secret' });

    // 调用方的头写在展开之后，所以它们能盖住默认的 accept。
    await fetchModelsListing(ROOT, { headers: { accept: 'application/vnd.aperture+json' } });
    assert.equal(
      (calls[1]?.init?.headers as Record<string, string> | undefined)?.accept,
      'application/vnd.aperture+json',
    );
  });

  it('非 2xx 应答报出端点、状态与修剪过的正文摘要', async (t) => {
    let call = 0;
    stubFetch(t, () => {
      call += 1;
      return call === 1 ? new Response('  upstream exploded \n', { status: 500 }) : new Response('', { status: 503 });
    });

    await assert.rejects(() => fetchModelsListing(ROOT), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `${ENDPOINT} 应答 HTTP 500: upstream exploded`);
      return true;
    });
    await assert.rejects(() => fetchModelsListing(ROOT), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `${ENDPOINT} 应答 HTTP 503`, '正文为空时不留悬空的分隔符');
      return true;
    });
  });

  it('content-length 超出上限时在读取正文之前拒绝', async (t) => {
    let read = false;
    stubFetch(t, () =>
      fakeResponse({
        headers: { 'content-length': String(LIMIT + 1) },
        text: async () => {
          read = true;
          return 'x';
        },
      }),
    );

    await assert.rejects(() => fetchModelsListing(ROOT), (error: unknown) => {
      assert.ok(endpointError(error));
      assert.equal((error as Error).message, `${ENDPOINT} 应答了 ${LIMIT + 1} 字节，超出 ${LIMIT} 字节的清单上限`);
      return true;
    });
    assert.equal(read, false, '声明就超限时不必再把正文读进来');
  });

  it('正文超出上限时拒绝', async (t) => {
    const overlong = 'x'.repeat(LIMIT + 1);
    stubFetch(t, () => fakeResponse({ text: async () => overlong }));

    await assert.rejects(() => fetchModelsListing(ROOT), (error: unknown) => {
      assert.ok(endpointError(error));
      assert.equal((error as Error).message, `${ENDPOINT} 应答了 ${LIMIT + 1} 字节，超出 ${LIMIT} 字节的清单上限`);
      return true;
    });
  });

  it('正文不是 JSON 时拒绝', async (t) => {
    stubFetch(t, () => new Response('<html>proxy error</html>', { status: 200 }));
    await assert.rejects(() => fetchModelsListing(ROOT), (error: unknown) => {
      assert.ok(endpointError(error));
      assert.ok((error as Error).message.startsWith(`${ENDPOINT} 没有应答 JSON：`), '说明「不是 JSON」，而不是「没有条目」');
      return true;
    });
  });

  it('既没有 data 数组也没有 models 对象时拒绝', async (t) => {
    stubFetch(t, () => new Response(JSON.stringify({ object: 'list', models: 'nope' }), { status: 200 }));
    await assert.rejects(() => fetchModelsListing(ROOT), (error: unknown) => {
      assert.ok(endpointError(error));
      assert.ok(
        (error as Error).message.includes('既没有应答 "data" 数组，也没有应答 "models" 对象'),
        '不认识的形状必须报错，而不是当成空清单',
      );
      return true;
    });
  });

  it('请求被中止时错误里点名端点，并保留原因', async (t) => {
    // 桩从不落定，只在中止信号到达时拒绝 —— 这才是超时真正走的路径。
    stubFetch(
      t,
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === null || signal === undefined) {
            reject(new Error('桩没有收到中止信号'));
            return;
          }
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
          });
        }),
    );

    await assert.rejects(() => fetchModelsListing(ROOT, { timeoutMs: 5 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.startsWith(`${ENDPOINT} 无法访问：`), `错误里要点名端点：${error.message}`);
      assert.ok(error.cause !== undefined, '原始中止原因作为 cause 留下');
      return true;
    });
  });
});

describe('readEntries', () => {
  it('data 数组优先于 models 对象', () => {
    const data = [{ id: 'a' }];
    const body = { data, models: { b: { id: 'b' } } };
    assert.deepEqual(readEntries(body, ENDPOINT), data);
    assert.equal(readEntries(body, ENDPOINT), data, '交回的就是那个数组本身，不留拷贝');
    assert.deepEqual(readEntries({ data: [] }, ENDPOINT), [], '空数组是合法清单');
  });

  it('models 对象只保留值为对象的条目', () => {
    const kept = { id: 'a' };
    assert.deepEqual(
      readEntries({ models: { a: kept, b: 'text', c: null, d: [1, 2] } }, ENDPOINT),
      [kept],
      '字符串、null 与数组都不是模型条目',
    );
  });

  it('其他形状一律抛错，并点名端点', () => {
    for (const body of [null, 7, 'text', [], {}]) {
      assert.throws(
        () => readEntries(body, ENDPOINT),
        (error: unknown) => endpointError(error),
        `形状 ${JSON.stringify(body)} 必须被拒绝`,
      );
    }
  });
});
