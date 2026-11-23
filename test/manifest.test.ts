/**
 * 声明的兼容范围：`package.json` 里那一份就是宿主预检读的那一份。
 *
 * dsh 的预检先读包自己的 `engines.dsh`，它单独决定结果、忽略 DSH 的 peer 范围；只有缺
 * `engines.dsh` 时才回退到 peer。拒绝记录里那一格的键因此是 `engines.dsh`，或是具体某个
 * peer 包名。这里不重写一遍 semver，而是直接问宿主自己的判定函数：
 *
 * - `devDependencies` 里那一整批 DSH 包必须停在同一条版本线上（漏升一个也算坏）；
 * - `engines.dsh` 必须接受那条版本线，正是「装了但没反应」那个静默失败的反面；
 * - 把 `engines` 清空、只留 peer 时也必须接受同一条版本线，否则两份声明各说各的；
 * - 支持线只有一条：0.2.2、0.1.7 与还不存在的 0.3 都要在预检处被挡下。
 *
 * 运行时版本取 `@deepseek-ai/dsh-app-boot` 自己报的那个（本仓库的 devDependencies 之一），
 * 因此这份断言跟着装的包走，不会留下一份手抄的版本号。
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
  type PluginCompatibility,
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

/** 同一份清单，去掉 `engines`，让预检走 peer 那条回退路径。 */
const PEERS_ONLY: Manifest = { ...MANIFEST, engines: {} };

/** 已经没有的宿主：支持线之外的版本都必须被预检挡下。 */
const OUTSIDE = ['0.2.2-rc.5', '0.1.7-rc.1', '0.1.5-rc.3', '0.3.0-rc.1'] as const;

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

/** 预检不接受的部分：键是 `engines.dsh` 或 peer 包名，值是声明出去的范围。 */
function deniedRequirements(
  manifest: Manifest,
  runtimeVersion: string,
): PluginCompatibility['requirements'] {
  const issue = evaluatePluginCompatibility(manifest, {}, runtimeVersion);
  return issue === undefined ? {} : issue.requirements;
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

  it('engines.dsh 接受装着的那条版本线', () => {
    assert.deepEqual(deniedRequirements(MANIFEST, DEV_RUNTIME), {}, denialDetail(DEV_RUNTIME));
  });

  it('engines 缺席时，peer 范围也接受同一条版本线', () => {
    assert.deepEqual(deniedRequirements(PEERS_ONLY, DEV_RUNTIME), {}, 'peer 范围与 engines.dsh 说的不是同一件事');
  });

  it('支持线之外的所有宿主在预检处就被挡下', () => {
    for (const version of OUTSIDE) {
      assert.deepEqual(
        Object.keys(deniedRequirements(MANIFEST, version)),
        ['engines.dsh'],
        `${version} 应当被 engines.dsh 挡下`,
      );
      assert.deepEqual(
        Object.keys(deniedRequirements(PEERS_ONLY, version)).sort(),
        [
          '@deepseek-ai/dsh-attachment',
          '@deepseek-ai/dsh-client-ui-primitives',
          '@deepseek-ai/dsh-client-ui-settings-models',
          '@deepseek-ai/dsh-llm',
          '@deepseek-ai/dsh-settings',
          '@deepseek-ai/dsh-timeout',
          '@deepseek-ai/dsh-typert-protocol',
        ],
        `${version} 应当被每一个 DSH peer 挡下`,
      );
    }
  });

  it('engines.dsh 与 peer 范围说的是同一件事', () => {
    const declared = MANIFEST.engines['dsh'];
    assert.equal(typeof declared, 'string', 'engines.dsh 要写出来，它是给人看的那一份');
    // 把 engines.dsh 换到 peer 的位置上，借同一个判定函数解析一次范围，省得手抄 semver。
    const probe = {
      name: MANIFEST.name,
      version: MANIFEST.version,
      peerDependencies: { '@deepseek-ai/dsh': declared },
    };
    const denied = (runtimeVersion: string): boolean =>
      evaluatePluginCompatibility(probe, {}, runtimeVersion) !== undefined;
    assert.equal(denied(DEV_RUNTIME), false, `engines.dsh（${declared}）不接受 ${DEV_RUNTIME}`);
    for (const version of OUTSIDE) {
      assert.equal(denied(version), true, `engines.dsh（${declared}）把 ${version} 也放进来了`);
    }
  });
});
