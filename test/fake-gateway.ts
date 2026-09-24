/**
 * 假 Aperture 网关：端到端验证里不依赖 Tailscale 网络的那一段。
 *
 * `test/live.test.ts` 要一个**可达**的网关，而真实实例在 Tailscale 网络里——不在那张网里的
 * 机器（CI、别人的笔记本）因此一条都跑不了。这个网关把那段网络补上：`/v1/models` 返回一份与
 * 那份用例的断言相符的载荷，字段名按 `src/metadata/extract.ts` 实际读取的写法给：
 *
 * - `display_name` / `context_window_tokens` / `max_output_tokens` / `reasoning`；
 * - `deepseek-flash` 与 `deepseek-v4-pro` 只宣告 `/v1/chat/completions`，因此归到 OpenAI
 *   兼容那条 `aperture` 路由；
 * - `MiniMax-M3` 只宣告 `/v1/messages`，因此归到 `aperture-anthropic`，且那条路由上恰好
 *   只有它一个模型。
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

import { createServer } from 'node:http';
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
      id: 'MiniMax-M3',
      display_name: 'MiniMax M3',
      context_window_tokens: 1_000_000,
      max_output_tokens: 65_536,
      supported_endpoints: ['/v1/messages'],
    },
  ],
};

/** 一个正在跑的假网关。 */
export interface FakeGateway {
  /** 插件该填进 `baseUrl` 的地址：`http://127.0.0.1:<实际端口>`。 */
  readonly url: string;
  /** `/v1/models` 至今被请求过几次（用来断言「这一轮真的去问了」）。 */
  readonly requests: () => number;
  /** 关掉并等端口释放。 */
  close(): Promise<void>;
}

/**
 * 起一个假网关。
 *
 * @param port - 监听端口；默认 `0`，即由内核给一个空闲端口，用完在 `url` 里报出来。
 * @returns 地址、请求计数与关闭函数。
 */
export async function startFakeGateway(port = 0): Promise<FakeGateway> {
  let served = 0;

  const server = createServer((request, response) => {
    if (request.url?.startsWith('/v1/models')) {
      served += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(PAYLOAD));
      return;
    }
    // 插件只请求清单；别的路径给它一个明确的 404，而不是挂住。
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
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
    close: async () => new Promise<void>((done, fail) => {
      server.close((error) => {
        if (error) fail(error);
        else done();
      });
    }),
  };
}
