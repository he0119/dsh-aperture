/**
 * 把工作搬到 HMR 事务之外去跑的一条通道。
 *
 * `loader/volatile-update` 是在**已经打开的事务里**同步发出来的：设置写入自己就是那个事务
 * （`dsh-config-editor` 把整次写入包在 `hmr.runExclusive()` 里），而事务的印记是一条
 * AsyncLocalStorage —— 从事件处理器里起的 promise 链会一直带着它，事件那一轮早跑完了也不掉。
 * 于是那条链上任何一次「再写设置」都被 HMR 判成事务嵌套而拒绝（`HMR transactions cannot be
 * nested`），而本插件发现完就要写设置：保存地址之后那一轮发现永远写不进去（配置页上说的是
 * 「没写（HMR transactions cannot be nested）」）。
 *
 * 因此工作不挂在事件处理器那条链上，而是交给这里。通道在**模块作用域**被拉起（模块求值不在任何
 * 事务里），事务里只负责把「有活干了」这件事叫醒它；作业在通道自己的上下文里启动，整轮刷新于是
 * 从头到尾都在事务之外，调用方拿到的仍是那个作业的结果。
 *
 * 通道按模块持有而不是按插件实例：源码热重载会在事务里重建插件（`hmr` 的 `partialReload`），
 * 实例里拉起的通道会跟着带上事务的印记；本模块通常留在模块缓存里，那条通道因此仍然是干净的。
 * 代价是连本模块一起重载时通道会跟着重建——那一代实例要等下次重启才写得进去。
 *
 * @module dsh-aperture/relay
 */

/** 待在通道上跑的作业。作业自己把结果交给调用方，因此这里不需要返回值。 */
type Job = () => void;

/** 通道的邮箱：待跑的作业，与「通道正睡着」时叫醒它的那一下。 */
interface Mailbox {
  readonly jobs: Job[];
  wake: (() => void) | undefined;
}

/** 邮箱本身在模块求值时就建好，因此不在任何事务里。 */
const mailbox: Mailbox = { jobs: [], wake: undefined };

/** 叫醒通道。叫醒动作本身可以发生在事务里：它只是 resolve 一个 promise。 */
function wake(): void {
  const resume = mailbox.wake;
  mailbox.wake = undefined;
  resume?.();
}

/**
 * 通道：有活就起一个，起完立刻回来看还有没有。
 *
 * 作业之间互不相干，因此起而不等——等着前一个只会把「同一刻该跑的那几轮」串成一条队列，而
 * `ApertureRuntime` 的单飞判定本来就是用来合并它们的。
 */
async function drain(): Promise<void> {
  for (;;) {
    if (mailbox.jobs.length === 0) {
      // 这个 `await` 的续体注册在通道自己的上下文里，因此通道醒来时仍在事务之外：事务那边
      // 做的事只是 resolve，而 promise 的续体是在哪儿注册就在哪儿跑。
      await new Promise<void>((resolve) => {
        mailbox.wake = resolve;
      });
    }
    for (const job of mailbox.jobs.splice(0)) job();
  }
}

void drain();

/**
 * 在 HMR 事务之外跑一件事。
 *
 * @param job - 要跑的工作；它以及它引发的全部异步续体都在事务之外执行。
 * @returns 该工作的结果。
 */
export function outside<T>(job: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    mailbox.jobs.push(() => {
      // 这一步在通道里注册：作业因此是通道的孩子，而不是事务里那个调用方的孩子。
      void Promise.resolve().then(job).then(resolve, reject);
    });
    wake();
  });
}
