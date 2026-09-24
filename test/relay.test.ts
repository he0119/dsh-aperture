/**
 * 通道：工作要落在调用方的事务之外。
 *
 * 这一份钉住的是机制本身，而不是它在某条路上的结果：`outside()` 回来的续体在哪条
 * AsyncLocalStorage 上下文里跑、作业之间会不会互相等、失败怎么回到调用方。为什么需要它
 * （HMR 的事务印记会跟着事件处理器那条链走）见 `src/relay.ts`；「保存配置之后清单真的写进去了」
 * 由 `test/live.test.ts` 在真实 Loader 上证明。
 *
 * @module dsh-aperture/test/relay
 */

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it } from 'node:test';
import { outside } from '../src/relay.ts';

/** 一个只有「在不在事务里」这一件事的上下文。 */
const transaction = new AsyncLocalStorage<boolean>();

describe('把工作搬到事务之外', () => {
  it('作业在事务之外跑，结果照原样回到事务里的调用方', async () => {
    const seen = await transaction.run(true, async () => {
      assert.equal(transaction.getStore(), true, '调用方确实在事务里');
      // 作业里再分几跳也还是事务之外：印记只跟到「从哪儿起」为止。
      return outside(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return transaction.getStore() ?? '无事务';
      });
    });

    assert.equal(seen, '无事务', '作业整条链都在事务之外，而不只是开头那一瞬');
    assert.equal(transaction.getStore(), undefined, '通道的上下文没有反向漏回调用方');
  });

  it('作业抛出的错误原样交给调用方', async () => {
    const failure = new Error('作业失败');
    await assert.rejects(
      transaction.run(true, () => outside(() => Promise.reject(failure))),
      (error: unknown) => error === failure,
    );
  });

  it('作业之间不互相等：后起的作业不必等前一个收尾', async () => {
    // 两个作业都从**事务里**发起，且都停在原地，直到测试自己放行。串行的话第二个根本起不来，
    // 因此这一条同时也是「通道不会把两轮刷新串成队列」的保证——本插件的单飞判定要看见它们，
    // 才有机会合成同一轮。
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const stuck = (name: string): Promise<void> =>
      outside(() => {
        started.push(name);
        return new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      });
    const first = transaction.run(true, () => stuck('第一个'));
    const second = transaction.run(true, () => stuck('第二个'));

    // 两跳足够：通道被叫醒是微任务，而作业在通道里当场就起。
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['第一个', '第二个'], '两个作业都起了，而不是一个等着另一个');

    for (const release of releases) release();
    await Promise.all([first, second]);
  });
});
