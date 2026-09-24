/**
 * 假 Aperture 网关的命令行外壳：手动走查时用它把端到端验证跑完。
 *
 * 网关本身在 `test/fake-gateway.ts`——那份载荷与 `test/live.test.ts` 的断言是一份契约，
 * 因此实现只有一处。本脚本只负责把端口从命令行交给它、把人该填的地址打印出来。
 *
 * `npm run test:live` 现在会自己起一个临时端口的网关（不填 `DSH_APERTURE_LIVE_URL` 时），
 * 所以这个脚本的用武之地是**手动**那两件事：想盯着一份固定端口跑，或者想配合
 * `scripts/inspect-live.mjs` 亲眼看生成的配置段。
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

import { startFakeGateway } from '../test/fake-gateway.ts';

const port = Number(process.argv[2] ?? process.env.FAKE_APERTURE_PORT ?? 54117);

const gateway = await startFakeGateway(port);
console.log(`fake aperture gateway: ${gateway.url}`);
