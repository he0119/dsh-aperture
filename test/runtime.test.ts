/**
 * 运行时的单飞，以及「等一轮读过新配置的刷新」。
 *
 * 设置界面写完配置立刻重读报告，靠的是 `refresh` 的那条承诺：返回的那一轮读的是**此刻**的
 * 配置。正在跑的那一轮读的是更早的配置时，调用方必须等它收尾后另起一轮，而不是并进它——并
 * 进去等于拿回一份过期报告，界面于是「保存了却没变」。
 *
 * 这里用一个会卡住的清单加载把刷新停在半路：配置段的**对象身份**一变就是新版本（与
 * `memoizedConfig` 的那份约定配套），因此不必真的发请求也能看清谁并进了谁。
 *
 * @module dsh-aperture/test/runtime
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SettingsForms } from '@deepseek-ai/dsh-settings';
import type { ModelCatalog } from '../src/catalog.ts';
import { memoizedConfig, type Config } from '../src/config.ts';
import { ApertureRuntime, type RuntimeLogger } from '../src/runtime.ts';

/** 什么都不输出的 logger。 */
const quiet: RuntimeLogger = { error() {}, info() {}, warn() {}, debug() {} };

/** 一份能解析出 `instanceRoot` 的配置段。 */
function section(baseUrl = 'https://ai.example.ts.net'): Config {
  return { baseUrl, route: 'aperture' };
}

/**
 * 一个会卡住的清单加载。
 *
 * 每轮刷新都停在这里，`release()` 之后统一失败——刷新因此可以停在半路，而整条路径不必真的
 * 发请求（清单加载在 `execute` 里排在发现之前）。
 *
 * @returns 清单替身、放行函数与「加载被调用了几次」。
 */
function gatedCatalog() {
  let open: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let loads = 0;
  const catalog = {
    load: () => {
      loads += 1;
      return gate.then(() => {
        throw new Error('清单不可用');
      });
    },
  };
  return {
    catalog: catalog as unknown as ModelCatalog,
    release: () => open?.(),
    loads: () => loads,
  };
}

/** 组装一个真的运行时；`source` 是可变的那份配置段（换对象 = 新版本）。 */
function makeRuntime(source: () => Config, catalog: ModelCatalog): ApertureRuntime {
  return new ApertureRuntime({
    config: memoizedConfig(source),
    settings: {} as SettingsForms,
    logger: quiet,
    catalog,
  });
}

describe('ApertureRuntime.refresh', () => {
  it('正在跑的那一轮读的就是此刻配置时，调用方并进它', async () => {
    const { catalog, release, loads } = gatedCatalog();
    const current = section();
    const runtime = makeRuntime(() => current, catalog);

    const first = runtime.refresh('第一次');
    const second = runtime.refresh('第二次');
    release();

    assert.equal((await first).trigger, '第一次');
    assert.equal((await second).trigger, '第一次', '配置没变，正在跑的那一轮够新');
    assert.equal(loads(), 1, '并进同一轮，而不是多跑一轮');
  });

  it('正在跑的那一轮读的是旧配置时，调用方等它收尾后另起一轮', async () => {
    const { catalog, release, loads } = gatedCatalog();
    let current = section();
    const runtime = makeRuntime(() => current, catalog);

    const first = runtime.refresh('第一次');
    // 刷新途中保存了新地址：设置服务换了一份解析结果，身份因此变了。
    current = section('https://new.example.ts.net');
    const second = runtime.refresh('第二次');
    release();

    assert.equal((await first).trigger, '第一次');
    assert.equal((await second).trigger, '第二次', '等到的必须是读过新配置的那一轮');
    assert.equal(loads(), 2);
  });

  it('多个排队者共享排上的那一轮', async () => {
    const { catalog, release, loads } = gatedCatalog();
    let current = section();
    const runtime = makeRuntime(() => current, catalog);

    const first = runtime.refresh('第一次');
    current = section('https://new.example.ts.net');
    const waiting = ['第二次', '第三次', '第四次'].map((trigger) => runtime.refresh(trigger));
    release();

    assert.deepEqual(
      (await Promise.all(waiting)).map((outcome) => outcome.trigger),
      ['第二次', '第二次', '第二次'],
      '先醒来的那个起一轮，其余并进它',
    );
    await first;
    assert.equal(loads(), 2, '第一轮 + 排上的那一轮');
  });
});
