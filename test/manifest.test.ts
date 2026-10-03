/**
 * 声明的兼容范围：`package.json` 里那一份就是宿主预检读的那一份。
 *
 * dsh 0.2.0 起，组合层在挂载前会拿**每个** `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 范围
 * 去比运行时版本（`evaluatePluginCompatibility`），不满足的那一行整行被拒——界面上什么也不出现，
 * 只有一行诊断。也就是说 `devDependencies` 升级、`peerDependencies` 忘了跟，插件在真机上就是
 * 「装了但没反应」，而单元测试与类型检查都照样全绿。
 *
 * 这里因此不重写一遍 semver，而是直接问宿主自己的那个判定函数：
 *
 * - `devDependencies` 里那一整批 DSH 包必须停在同一条版本线上（漏升一个也算坏）；
 * - 声明的 peer 范围必须接受那条版本线——正是上面那个静默失败的反面；
 * - 范围也不能放宽成通行证（比 0.1.7 更早的宿主没有本插件依赖的设置与 LLM 接缝，必须在预检处就被挡下）；
 *   本插件自己用到的每一个 `@deepseek-ai/dsh*` 包都写进 peer，于是「0.1.7 也在范围内」这句话在预检处
 *   逐包核对过——那些 API 在 0.1.7-rc.1 上确实存在（核对方式是读那一版发布的类型）；
 * - 0.1.7 那一版宿主是**有意**继续支持的：`latest` 停在那里，而 0.2.0 只在 `next`。丢掉它要连同
 *   这一条用例一起改，那正是「有意的破坏性升级」该有的仪式。
 *
 * 运行时版本取 `@deepseek-ai/dsh-app-boot` 自己报的那个（本仓库的 devDependencies 之一），因此这份
 * 断言跟着装的包走，不会留下一份手抄的版本号。
 *
 * @module dsh-aperture/test/manifest
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  evaluatePluginCompatibility,
  getDshRuntimeVersion,
  pluginCompatibilityWarning,
} from '@deepseek-ai/dsh-app-boot';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** `package.json` 里这份断言读得到的那几个字段。 */
interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly engines: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

const MANIFEST = JSON.parse(
  readFileSync(join(HERE, '..', 'package.json'), 'utf8'),
) as Manifest;

/** 本仓库构建与测试所对准的 dsh 版本。 */
const DEV_RUNTIME = getDshRuntimeVersion();

/** 本仓库直接装的 DSH 包名，按字母序。 */
const DEV_DSH_PACKAGES = Object.keys(MANIFEST.devDependencies)
  .filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  .sort();

/** 某个包实际装着的版本。 */
function installedVersion(name: string): string {
  const manifest = require(`${name}/package.json`) as { version: string };
  return manifest.version;
}

/** 拿某个运行时版本去走一遍宿主的预检，返回被拒的 peer（没有就是空表）。 */
function deniedPeers(runtimeVersion: string): Readonly<Record<string, string>> {
  const issue = evaluatePluginCompatibility(MANIFEST, {}, runtimeVersion);
  return issue === undefined ? {} : issue.peers;
}

/** 预检拒绝时的诊断，用来在断言消息里说清楚缺哪一项。 */
function denialDetail(runtimeVersion: string): string {
  const issue = evaluatePluginCompatibility(MANIFEST, {}, runtimeVersion);
  return issue === undefined ? '（没有拒绝）' : pluginCompatibilityWarning(issue);
}

describe('声明的兼容范围', () => {
  it('devDependencies 里那一整批 DSH 包停在同一条版本线上', () => {
    assert.ok(DEV_DSH_PACKAGES.length > 5, `应当直接装着好几个 DSH 包，实际 ${String(DEV_DSH_PACKAGES.length)} 个`);
    const versions = new Map(DEV_DSH_PACKAGES.map((name) => [name, installedVersion(name)]));
    const distinct = [...new Set(versions.values())].sort();
    assert.deepEqual(distinct, [DEV_RUNTIME], `DSH 包版本不齐：${JSON.stringify(Object.fromEntries(versions))}`);
  });

  it('peer 范围接受装着的那条版本线', () => {
    assert.deepEqual(deniedPeers(DEV_RUNTIME), {}, denialDetail(DEV_RUNTIME));
  });

  it('0.1.7 那一版宿主仍然在范围内', () => {
    assert.deepEqual(deniedPeers('0.1.7-rc.1'), {}, denialDetail('0.1.7-rc.1'));
  });

  it('更早的宿主在预检处就被挡下，范围没有放宽成通行证', () => {
    const denied = deniedPeers('0.1.5-rc.3');
    assert.notDeepEqual(denied, {}, '0.1.5 之前的宿主没有本插件依赖的设置接缝，不该被放进来');
    assert.deepEqual(
      Object.keys(denied).sort(),
      [
        '@deepseek-ai/dsh-attachment',
        '@deepseek-ai/dsh-client-ui-primitives',
        '@deepseek-ai/dsh-client-ui-settings-models',
        '@deepseek-ai/dsh-credentials',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-settings',
        '@deepseek-ai/dsh-timeout',
        '@deepseek-ai/dsh-typert-protocol',
      ],
      '被拒的应当是那几个带 0.1.7 下界的 DSH peer，而不是别的什么',
    );
  });

  it('engines.dsh 与 peer 范围说的是同一件事', () => {
    const declared = MANIFEST.engines['dsh'];
    assert.equal(typeof declared, 'string', 'engines.dsh 要写出来，它是给人看的那一份');
    // 同一个判定函数只认 `@deepseek-ai/dsh*` 的 **peer** 名，因此把 engines.dsh 换到那个位置上
    // 借它解析一次范围——省得在这里手抄一遍 semver 的语义。
    const probe = {
      name: MANIFEST.name,
      version: MANIFEST.version,
      peerDependencies: { '@deepseek-ai/dsh': declared },
    };
    const denied = (runtimeVersion: string): boolean =>
      evaluatePluginCompatibility(probe, {}, runtimeVersion) !== undefined;
    assert.equal(denied(DEV_RUNTIME), false, `engines.dsh（${declared}）不接受 ${DEV_RUNTIME}`);
    assert.equal(denied('0.1.7-rc.1'), false, `engines.dsh（${declared}）不接受 0.1.7-rc.1`);
    assert.equal(denied('0.1.5-rc.3'), true, `engines.dsh（${declared}）把 0.1.5 也放进来了`);
    assert.equal(denied('0.3.0-rc.1'), true, `engines.dsh（${declared}）把还没有的 0.3 也放进来了`);
  });
});
