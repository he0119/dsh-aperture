/**
 * `ModelCatalog` 的加载、索引与缓存。
 *
 * 这个类是 models.dev 这一可选第二来源的入口，而这次抓取在任何意义上都是可选的：
 * 每种失败都必须变成一条诊断，而不是一次失败的刷新。因此这里钉住的是失败路径的
 * 形状（`{ entries: 0, reason }` 且没有 `lookup`）与进程生命周期内那个**单槽位**缓存
 * 的实际取舍 —— 同一个 URL 不重抓、失败的加载同样被记住、换 URL 就直接覆盖。
 *
 * 每个用例都替换 `globalThis.fetch`，不发出任何真实请求。
 *
 * @module dsh-aperture/test/catalog
 */

import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { ModelCatalog } from '../src/catalog.ts';
import { catalogDocument } from './helpers.ts';

const URL = 'https://catalog.example/models.json';

/** 一次被抓到的调用。 */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/**
 * 把全局 `fetch` 换成一个受控的桩，并在本用例结束后恢复。
 *
 * @param t - 用例上下文，桩的恢复挂在这里。
 * @param respond - 按 URL 产生应答；抛错即模拟抓取本身失败。
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

/** 一个只实现 `fetchCatalog` 真正读到的字段的应答。 */
function fakeResponse(fields: { ok: boolean; status?: number; text: () => Promise<string> }): Response {
  return { ok: fields.ok, status: fields.status ?? 200, text: fields.text } as unknown as Response;
}

/** 一份能索引出条目的小文档：一个模型键，值为携带 `reasoning` 的条目。 */
function flatDocument(id: string, reasoning: boolean): Record<string, unknown> {
  return { [id]: { id, reasoning } };
}

describe('ModelCatalog', () => {
  it('空 URL 不是一次请求', async (t) => {
    const calls = stubFetch(t, () => {
      throw new Error('URL 为空时不该有人碰网络');
    });
    const result = await new ModelCatalog().load('', 1_000);
    assert.deepEqual(result, { entries: 0, reason: '未配置清单 URL' });
    assert.equal(calls.length, 0);
  });

  it('成功时索引文档并报告条目数', async (t) => {
    const document = catalogDocument();
    const calls = stubFetch(t, () => new Response(JSON.stringify(document), { status: 200 }));
    const result = await new ModelCatalog().load(URL, 5_000);

    assert.equal(result.reason, undefined, '成功时没有原因');
    assert.equal(
      result.entries,
      Object.keys(document as Record<string, unknown>).length,
      '扁平文档的条目数就是它的顶层键数',
    );
    // 索引真的可用，而不只是「存在」：这条查询在 modelsdev.test.ts 里也钉过。
    assert.equal(result.lookup?.({ id: 'mimo-v2.6-flash', provider: 'xiaomimimo' })?.reasoning, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.init?.headers, { accept: 'application/json' }, '清单请求也只要 JSON');
  });

  it('providers 包装文档的条目数数的是 provider，不是模型', async (t) => {
    stubFetch(
      t,
      () =>
        new Response(
          JSON.stringify({
            providers: {
              deepseek: { id: 'deepseek', models: { 'deepseek-chat': { id: 'deepseek-chat', reasoning: true } } },
              xai: { id: 'xai', models: { 'grok-4.5': { id: 'grok-4.5', reasoning: true } } },
            },
          }),
          { status: 200 },
        ),
    );
    const result = await new ModelCatalog().load(URL, 5_000);
    assert.equal(result.entries, 2, 'countEntries 数的是 providers 的键');
    assert.equal(result.lookup?.({ id: 'deepseek-chat' })?.reasoning, true);
  });

  it('models 包装文档的条目数数的是模型', async (t) => {
    stubFetch(
      t,
      () =>
        new Response(JSON.stringify({ models: { m1: { reasoning: true }, m2: { context_window: 4_096 } } }), {
          status: 200,
        }),
    );
    const result = await new ModelCatalog().load(URL, 5_000);
    assert.equal(result.entries, 2);
    assert.equal(result.lookup?.({ id: 'm2' })?.contextWindow, 4_096);
  });

  it('同一个 URL 只抓一次', async (t) => {
    const calls = stubFetch(t, () => new Response(JSON.stringify(flatDocument('a/x', true)), { status: 200 }));
    const catalog = new ModelCatalog();
    const first = await catalog.load(URL, 5_000);
    const second = await catalog.load(URL, 5_000);

    assert.equal(calls.length, 1, '第二次加载没有发出第二个请求');
    assert.equal(second, first, '第二次拿回的是同一个结果对象');
    assert.equal(second.entries, 1);
  });

  it('换一个 URL 会重新抓取并替换掉缓存', async (t) => {
    const other = 'https://catalog.example/other.json';
    const calls = stubFetch(
      t,
      (url) =>
        new Response(
          JSON.stringify(
            url === URL ? flatDocument('a/x', true) : { models: { m1: { reasoning: true }, m2: { reasoning: false } } },
          ),
          { status: 200 },
        ),
    );
    const catalog = new ModelCatalog();
    assert.equal((await catalog.load(URL, 5_000)).entries, 1);
    assert.equal((await catalog.load(other, 5_000)).entries, 2);
    assert.equal((await catalog.load(URL, 5_000)).entries, 1, '缓存只有一个槽位：换回来要重新抓');
    assert.deepEqual(
      calls.map((call) => call.url),
      [URL, other, URL],
    );
  });

  it('失败的加载也会被缓存', async (t) => {
    const calls = stubFetch(t, () => new Response('gateway down', { status: 502 }));
    const catalog = new ModelCatalog();
    const first = await catalog.load(URL, 5_000);
    const second = await catalog.load(URL, 5_000);

    assert.equal(calls.length, 1, '这次失败被记住了，第二次不再抓');
    assert.equal(second, first);
    assert.match(first.reason ?? '', /HTTP 502/u);
  });

  it('非 2xx 应答给出原因，且没有查找器', async (t) => {
    stubFetch(t, () => new Response('nope', { status: 503 }));
    const result = await new ModelCatalog().load(URL, 5_000);
    assert.equal(result.entries, 0);
    assert.equal(result.lookup, undefined);
    assert.equal(result.reason, `${URL} 应答 HTTP 503`);
  });

  it('读不出正文时给出原因', async (t) => {
    stubFetch(t, () =>
      fakeResponse({
        ok: true,
        text: async () => {
          throw new Error('socket hang up');
        },
      }),
    );
    const result = await new ModelCatalog().load(URL, 5_000);
    assert.equal(result.entries, 0);
    assert.equal(result.lookup, undefined);
    assert.equal(result.reason, `${URL} 无法读取：socket hang up`);
  });

  it('正文不是 JSON 时给出原因', async (t) => {
    stubFetch(t, () => new Response('<html>proxy error</html>', { status: 200 }));
    const result = await new ModelCatalog().load(URL, 5_000);
    assert.equal(result.entries, 0);
    assert.equal(result.lookup, undefined);
    assert.match(result.reason ?? '', new RegExp(`^${URL} 无法读取：`, 'u'));
  });

  it('文档没有可用条目时不给查找器', async (t) => {
    const bodies = ['{}', '{"providers":{}}', '{"models":{"m1":"不是对象"}}'];
    let index = 0;
    stubFetch(t, () => new Response(bodies[index++] ?? '{}', { status: 200 }));
    const catalog = new ModelCatalog();
    for (const [position, body] of bodies.entries()) {
      const result = await catalog.load(`${URL}?${position}`, 5_000);
      assert.equal(result.lookup, undefined, `没有可用条目：${body}`);
      assert.equal(result.entries, 0);
      assert.equal(result.reason, `${URL}?${position} 中没有可用的模型元数据`);
    }
  });

  it('抓取抛错时 load 不抛，而是给出原因', async (t) => {
    stubFetch(t, () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await new ModelCatalog().load(URL, 5_000);
    assert.equal(result.entries, 0);
    assert.equal(result.lookup, undefined);
    assert.equal(result.reason, `${URL} 无法读取：ECONNREFUSED`);
  });

  it('抓取抛出非 Error 时也能给出原因', async (t) => {
    // 宿主或某个 polyfill 完全可以抛出字符串；`load` 的「从不抛出」承诺也包括它。
    stubFetch(t, () => {
      throw 'boom';
    });
    const result = await new ModelCatalog().load(URL, 5_000);
    assert.equal(result.entries, 0);
    assert.equal(result.lookup, undefined);
    assert.equal(result.reason, `${URL} 无法读取：boom`);
  });
});
