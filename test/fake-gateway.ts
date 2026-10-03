/**
 * 假 Aperture 网关：端到端验证里不依赖 Tailscale 网络的那一段。
 *
 * `test/live.test.ts` 要一个**可达**的网关，而真实实例在 Tailscale 网络里——不在那张网里的
 * 机器（CI、别人的笔记本）因此一条都跑不了。这个网关把那段网络补上，并且补上三件事：
 *
 * 1. `/v1/models` 返回一份与那份用例的断言相符的载荷，字段名按 `src/metadata/extract.ts`
 *    实际读取的写法给（`display_name` / `context_window_tokens` / `max_output_tokens` /
 *    `reasoning`）。三个模型分别只宣告一条端点，于是三条路由各有一个模型：
 *    `deepseek-flash` 与 `deepseek-v4-pro` 走 `/v1/chat/completions`，
 *    `deepseek-v4-codex` 走 `/v1/responses`，`MiniMax-M3` 走 `/v1/messages`。
 * 2. 三条推理端点各自**真的按线缆协议流式**回答：OpenAI Chat Completions 的
 *    `chat.completion.chunk`、OpenAI Responses 的 `response.*` 事件、Anthropic Messages 的
 *    `message_start` / `content_block_delta` / `message_stop`。因此用例断言的是「模型确实通过
 *    本插件注册的路由说出了话」，而不只是「设置里出现了一条看起来合理的路由」。
 * 3. 每一次推理请求的**完整请求体**都被记下来（`calls()`），于是「推理档位、模型 id、输出上限
 *    到底以什么形式发到了线上」是可断言的——那正是本插件与网关之间唯一的实质契约。
 *
 * Anthropic 那一条还会发一个带签名的思考块，用来验证多轮重放：签名必须原样回到第二次请求里。
 *
 * **载荷与用例是一份契约**：这里的每个数字都被 `test/live.test.ts` 断言着，改这里就要改那里。
 * 换端口用 `startFakeGateway(0)` 要一个临时端口，别写死——同一台机器上并行跑两份用例时，
 * 写死的端口是它们互相打断的唯一原因。
 *
 * `scripts/fake-aperture-gateway.mjs` 是它的命令行外壳（手动走查时用），
 * `scripts/inspect-live.mjs` 与它无关，只认 `DSH_APERTURE_LIVE_URL`。
 *
 * @module dsh-aperture/test/fake-gateway
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** `/v1/models` 的载荷；每个数字都对着 `test/live.test.ts` 的断言。 */
const PAYLOAD = {
  data: [
    {
      id: 'deepseek-flash',
      display_name: 'DeepSeek V4.1 Flash',
      context_window_tokens: 1_048_576,
      max_output_tokens: 384_000,
      reasoning: true,
      supported_endpoints: ['/v1/chat/completions'],
    },
    {
      id: 'deepseek-v4-pro',
      display_name: 'DeepSeek V4.1 Pro',
      context_window_tokens: 1_048_576,
      max_output_tokens: 384_000,
      reasoning: true,
      supported_endpoints: ['/v1/chat/completions'],
    },
    {
      id: 'deepseek-v4-codex',
      display_name: 'DeepSeek V4.1 Codex',
      context_window_tokens: 400_000,
      max_output_tokens: 128_000,
      reasoning: true,
      supported_endpoints: ['/v1/responses'],
    },
    {
      id: 'MiniMax-M3',
      display_name: 'MiniMax M3',
      context_window_tokens: 1_000_000,
      max_output_tokens: 65_536,
      supported_endpoints: ['/v1/messages'],
    },
  ],
};

/** 流式回答里那段可见文本；用例按它断言「模型真的说了话」。 */
const REPLY = 'pong';

/** Anthropic 思考块的签名；用例断言它原样回到第二次请求。 */
const THINKING_SIGNATURE = 'sig-fake-1';

/** 一次被网关记下来的推理请求。 */
export interface GatewayCall {
  /** 请求路径，例如 `/v1/chat/completions`。 */
  readonly path: string;
  /** 解析后的请求体；解析不了时为空对象。 */
  readonly body: Record<string, unknown>;
  /** 请求头（Node 原样给出，可能带数组值）。 */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** 一个正在跑的假网关。 */
export interface FakeGateway {
  /** 插件该填进 `baseUrl` 的地址：`http://127.0.0.1:<实际端口>`。 */
  readonly url: string;
  /** `/v1/models` 至今被请求过几次（用来断言「这一轮真的去问了」）。 */
  readonly requests: () => number;
  /** 至今收到的推理请求，按到达顺序。 */
  readonly calls: () => readonly GatewayCall[];
  /** 关掉并等端口释放。 */
  close(): Promise<void>;
}

/**
 * 起一个假网关。
 *
 * @param port - 监听端口；默认 `0`，即由内核给一个空闲端口，用完在 `url` 里报出来。
 * @returns 地址、清单请求计数、推理请求记录与关闭函数。
 */
export async function startFakeGateway(port = 0): Promise<FakeGateway> {
  let served = 0;
  const calls: GatewayCall[] = [];

  const server = createServer((request, response) => {
    const path = request.url ?? '';
    if (path.startsWith('/v1/models')) {
      served += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(PAYLOAD));
      return;
    }

    void readBody(request).then((body) => {
      calls.push({ path, body, headers: request.headers });
      const model = typeof body.model === 'string' ? body.model : '';
      if (path.startsWith('/v1/chat/completions')) {
        completions(response, model);
        return;
      }
      if (path.startsWith('/v1/responses')) {
        responses(response, model);
        return;
      }
      if (path.startsWith('/v1/messages')) {
        messages(response, model);
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    });
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      done();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => served,
    calls: () => calls,
    close: async () => new Promise<void>((done, fail) => {
      server.close((error) => {
        if (error) fail(error);
        else done();
      });
    }),
  };
}

/** 读完一个请求体并解析成对象；读不动或不是对象时给空对象。 */
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 按 SSE 写一串事件并收尾。 */
function stream(response: ServerResponse, events: readonly unknown[], terminated = true): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const event of events) {
    const type = typeof (event as { type?: unknown }).type === 'string'
      ? String((event as { type: string }).type)
      : '';
    // Anthropic 的 SDK 按 `event:` 行分派；OpenAI 的两条 SDK 只读 `data:` 里的 `type`。
    // 两条都写，于是同一份流对两边都成立。
    if (type.length > 0) response.write(`event: ${type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  if (terminated) response.write('data: [DONE]\n\n');
  response.end();
}

/** OpenAI Chat Completions 的流式回答。 */
function completions(response: ServerResponse, model: string): void {
  const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model };
  stream(response, [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: REPLY }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    // 用量块：pi-ai 会带上 `stream_options.include_usage`，真实端点因此在最后多发一块空 choices。
    { ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } },
  ]);
}

/** OpenAI Responses 的流式回答。 */
function responses(response: ServerResponse, model: string): void {
  const item = {
    type: 'message',
    id: 'msg-fake',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: REPLY, annotations: [] }],
  };
  stream(response, [
    { type: 'response.created', response: { id: 'resp-fake', model, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg-fake', delta: REPLY },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp-fake',
        model,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      },
    },
  ]);
}

/** Anthropic Messages 的流式回答：先一个带签名的思考块，再一段文本。 */
function messages(response: ServerResponse, model: string): void {
  stream(response, [
    {
      type: 'message_start',
      message: {
        id: 'msg-fake',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 9, output_tokens: 1 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '想一想' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: THINKING_SIGNATURE },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: REPLY } },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: 'message_stop' },
  ], false);
}

/** 用例读得到的那个思考签名。 */
export const FAKE_THINKING_SIGNATURE = THINKING_SIGNATURE;
