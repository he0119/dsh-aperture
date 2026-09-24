/**
 * 假 Aperture 网关：没有真实实例时，用它把端到端验证跑完。
 *
 * `test/live.test.ts` 与 `scripts/inspect-live.mjs` 都要求一个可达的网关，而真实实例在
 * Tailscale 网络里——不在那张网里的机器（CI、别人的笔记本）因此一条都跑不了。这个脚本
 * 补上那段网络：`/v1/models` 返回一份与 `test/live.test.ts` 断言相符的载荷，字段名按
 * `src/metadata/extract.ts` 实际读取的写法给：
 *
 * - `display_name` / `context_window_tokens` / `max_output_tokens` / `reasoning`；
 * - `deepseek-flash` 与 `deepseek-v4-pro` 只宣告 `/v1/chat/completions`，因此归到 OpenAI
 *   兼容那条 `aperture` 路由；
 * - `MiniMax-M3` 只宣告 `/v1/messages`，因此归到 `aperture-anthropic`，且那条路由上恰好
 *   只有它一个模型。
 *
 * 它**不是**测试，也不进发布产物（`scripts/` 不在 `package.json` 的 `files` 里）：它不
 * 校验任何东西，只是把一份固定载荷喂给那两个脚本。
 *
 * ```sh
 * node scripts/fake-aperture-gateway.mjs 54117
 * DSH_APERTURE_LIVE_URL=http://127.0.0.1:54117 npm run test:live
 * ```
 *
 * @module dsh-aperture/scripts/fake-aperture-gateway
 */

import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? process.env.FAKE_APERTURE_PORT ?? 54117);

/** `/v1/models` 的载荷；每个数字都对着 `test/live.test.ts` 的断言。 */
const payload = {
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

const server = createServer((request, response) => {
  if (request.url?.startsWith('/v1/models')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
    return;
  }
  // 插件只请求清单；别的路径给它一个明确的 404，而不是挂住。
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake aperture gateway: http://127.0.0.1:${port}`);
});
