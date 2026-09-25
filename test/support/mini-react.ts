/**
 * 一个只够跑本插件配置页的 React 替身。
 *
 * 配置页的逻辑几乎都在组件里：草稿与生效值的差异、按钮的可用性、动作按下之后把结果贴出来。
 * 这些没法靠「模块加载成功」证明，也没法在无浏览器、无 `react-dom` 的环境里用真 React 渲染
 * ——SSR 不跑 effect，因此只能看到加载态那一帧。这个替身实现 `createElement` + `jsx` / `jsxs` /
 * `Fragment`（automatic runtime）+ `useState` + `useEffect`，按提交循环驱动到稳定，于是
 * 「挂载 → 拉配置 → 改输入 → 按保存」这条路径可以在纯 Node 里走完。
 *
 * 它刻意带两件测试用能力：
 *
 * - **渲染次数**：注入面的身份每轮渲染都会变，把 effect 的依赖写成注入面就会每次渲染重跑
 *   effect、再触发渲染，无限循环。`renders` 让用例可以钉住「一轮交互只渲染少数几次」。
 * - **提交上限**：真出现自激循环时，抛错而不是把测试挂死。
 *
 * @module dsh-aperture/test/support/mini-react
 */

/** 宿主元素：`type` 是字符串标签名。 */
export interface HostElement {
  readonly type: string;
  readonly props: Record<string, unknown> & { children?: unknown };
}

/** 组件元素或宿主元素，以及被展开的文本。 */
export type Node = HostElement | string | number;

/** 待渲染的元素。 */
interface Element {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

/** 一个 hook 槽位。 */
interface HookSlot {
  initialized: boolean;
  value: unknown;
  deps?: readonly unknown[];
  cleanup?: (() => void) | undefined;
  pending?: (() => (() => void) | void) | undefined;
}

/** 一个组件实例。 */
interface Instance {
  readonly type: unknown;
  hooks: HookSlot[];
  cursor: number;
  resolved: unknown;
}

/** 一次提交最多重渲染几轮；超出即判定为自激循环。 */
const MAX_COMMITS = 40;

/** `jsx-runtime` 的 Fragment；替身只需要一个稳定的身份。 */
const FRAGMENT = Symbol.for('dsh-aperture.mini-react.fragment');

/** 渲染器：`createElement` 与两个 hook，加上驱动提交循环的 `flush`。 */
export class MiniReact {
  /** 组件函数被执行的次数。 */
  renders = 0;

  private readonly instances = new Map<unknown, Instance>();
  private readonly effects: Instance[] = [];
  /** 元素树（每轮提交的输入）与渲染结果，刻意分开两份。 */
  private element: unknown;
  private root: unknown;
  private current: Instance | null = null;
  private dirty = false;

  /** `React.createElement`。 */
  readonly createElement = (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): Element => ({
    type,
    props: { ...(props ?? {}), children },
  });

  /**
   * `react/jsx-runtime` 的 `jsx`。
   *
   * automatic runtime 把 `key` 单独当第三个参数交出来、把子节点塞进 `props.children`，而
   * `createElement` 收的是「props + 实参」。这里按同一套语义接上去，于是源码无论是 JSX 还是
   * `createElement`，替身这边都长成同一个元素形状。
   */
  readonly jsx = (type: unknown, props?: Record<string, unknown> | null, key?: unknown): Element => {
    const { children, ...rest } = props ?? {};
    const withKey = key === undefined ? rest : { ...rest, key };
    if (children === undefined) return this.createElement(type, withKey);
    return this.createElement(type, withKey, ...(Array.isArray(children) ? children : [children]));
  };

  /** `jsxs` 只是「子节点已知是数组」的提示，替身与 `jsx` 同处理。 */
  readonly jsxs = this.jsx;

  /** `react/jsx-runtime` 的 `Fragment`；`evaluate` 把它渲染成它的子节点。 */
  readonly Fragment = FRAGMENT;

  /** `React.useState`。 */
  readonly useState = <T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] => {
    const instance = this.requireCurrent('useState');
    const slot = this.slot(instance);
    if (!slot.initialized) {
      slot.initialized = true;
      slot.value = typeof initial === 'function' ? (initial as () => T)() : initial;
    }
    const set = (next: T | ((prev: T) => T)): void => {
      const value = typeof next === 'function' ? (next as (prev: T) => T)(slot.value as T) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      this.dirty = true;
    };
    return [slot.value as T, set];
  };

  /** `React.useEffect`（依赖数组按 `Object.is` 比较）。 */
  readonly useEffect = (callback: () => (() => void) | void, deps?: readonly unknown[]): void => {
    const instance = this.requireCurrent('useEffect');
    const slot = this.slot(instance);
    const previous = slot.deps;
    const changed = deps === undefined || previous === undefined
      || deps.length !== previous.length
      || deps.some((dep, index) => !Object.is(dep, previous[index]));
    if (changed) {
      slot.deps = deps === undefined ? undefined : [...deps];
      slot.pending = callback;
    }
  };

  /**
   * 挂载一棵树。
   *
   * 元素树与渲染结果是两份东西，必须分开存：把渲染结果当成下一轮的输入，组件就再也不会
   * 被重新执行了。
   *
   * @param element - 根元素。
   */
  mount(element: unknown): void {
    this.element = element;
    this.commit();
  }

  /**
   * 驱动到稳定：反复让挂起的微任务全部落地、执行待跑的 effect、重渲染脏组件。
   *
   * 每一轮都等一个宏任务，因为动作链（点击 → 端点 → `.then`）全是微任务：只等一个
   * `Promise.resolve()` 会在链还没走完时就误判成「已经稳定」。
   *
   * @returns 稳定后的渲染结果。
   */
  async flush(): Promise<void> {
    for (let pass = 0; pass < MAX_COMMITS; pass += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!this.dirty) return;
      this.commit();
    }
    throw new Error(`组件在 ${MAX_COMMITS} 轮提交后仍未稳定：effect 依赖里多半放了每轮都变的注入面`);
  }

  /** 当前渲染出来的树。 */
  tree(): unknown {
    return this.root;
  }

  /**
   * 每个 hook 槽位记下的依赖数组（测试用）。
   *
   * 用来直接钉住那条容易写错、写错就要命的规矩：effect 的依赖里不能出现每轮渲染都会重建的
   * 对象（例如注入面），否则 effect 每轮重跑、每轮又触发渲染。
   *
   * @returns 各槽位的依赖，未使用依赖的槽位为 `undefined`。
   */
  hookDeps(): Array<readonly unknown[] | undefined> {
    const deps: Array<readonly unknown[] | undefined> = [];
    for (const instance of this.instances.values()) {
      for (const slot of instance.hooks) deps.push(slot.deps);
    }
    return deps;
  }

  /** 一次提交：重渲染、跑 effect。 */
  private commit(): void {
    this.dirty = false;
    this.effects.length = 0;
    this.root = this.evaluate(this.element);
    for (const instance of this.effects) {
      for (const slot of instance.hooks) {
        if (slot.pending === undefined) continue;
        const callback = slot.pending;
        slot.pending = undefined;
        slot.cleanup?.();
        const cleanup = callback();
        slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      }
    }
  }

  private evaluate(node: unknown): unknown {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (Array.isArray(node)) {
      return node.map((child) => this.evaluate(child)).filter((child) => child !== null);
    }
    if (typeof node !== 'object') return node;
    const element = node as Element;
    const children = this.evaluate(element.props.children);
    // Fragment 不产生节点，只是把子节点原地展开。
    if (element.type === FRAGMENT) return children;
    if (typeof element.type === 'function') {
      const instance = this.instanceFor(element.type);
      this.current = instance;
      instance.cursor = 0;
      this.renders += 1;
      let rendered: unknown;
      try {
        rendered = (element.type as (props: Record<string, unknown>) => unknown)(element.props);
      } finally {
        this.current = null;
      }
      instance.resolved = this.evaluate(rendered);
      return instance.resolved;
    }
    if (typeof element.type === 'string') {
      return { type: element.type, props: { ...element.props, children } };
    }
    return node;
  }

  private instanceFor(type: unknown): Instance {
    let instance = this.instances.get(type);
    if (instance === undefined) {
      instance = { type, hooks: [], cursor: 0, resolved: null };
      this.instances.set(type, instance);
    }
    this.effects.push(instance);
    return instance;
  }

  private requireCurrent(hook: string): Instance {
    if (this.current === null) throw new Error(`${hook} 只能在渲染期间调用`);
    return this.current;
  }

  private slot(instance: Instance): HookSlot {
    const index = instance.cursor;
    instance.cursor += 1;
    const existing = instance.hooks[index];
    if (existing !== undefined) return existing;
    const created: HookSlot = { initialized: false, value: undefined };
    instance.hooks[index] = created;
    return created;
  }
}

/** 深度优先收集元素。 */
export function findAll(node: unknown, predicate: (element: HostElement) => boolean): HostElement[] {
  const found: HostElement[] = [];
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    const element = current as HostElement;
    if (typeof element.type === 'string' && predicate(element)) found.push(element);
    walk(element.props.children);
  };
  walk(node);
  return found;
}

/** 按 `id` 找元素。 */
export function findById(node: unknown, id: string): HostElement {
  const [found] = findAll(node, (element) => element.props.id === id);
  if (found === undefined) throw new Error(`找不到 id=${id} 的元素`);
  return found;
}

/** 按按钮文字找按钮。 */
export function findButton(node: unknown, label: string): HostElement {
  const [found] = findAll(node, (element) => element.type === 'button' && text(element).includes(label));
  if (found === undefined) throw new Error(`找不到写着「${label}」的按钮`);
  return found;
}

/** 一个元素子树的文本。 */
export function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map((child) => text(child)).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  const element = node as HostElement;
  return text(element.props.children);
}

/** 触发一个元素的 `onClick`。 */
export function click(element: HostElement): void {
  const handler = element.props.onClick;
  if (typeof handler !== 'function') throw new Error(`<${element.type}> 没有 onClick`);
  (handler as () => void)();
}

/** 触发输入框的 `onChange`。 */
export function change(element: HostElement, value: string): void {
  const handler = element.props.onChange;
  if (typeof handler !== 'function') throw new Error(`<${element.type}> 没有 onChange`);
  (handler as (event: unknown) => void)({ target: { value } });
}

/** 触发复选框的 `onChange`。 */
export function toggle(element: HostElement, checked: boolean): void {
  const handler = element.props.onChange;
  if (typeof handler !== 'function') throw new Error(`<${element.type}> 没有 onChange`);
  (handler as (event: unknown) => void)({ target: { checked } });
}

/** 触发输入框的 `onBlur`（没有就不做任何事：多数输入框本来就不听这个事件）。 */
export function blur(element: HostElement): void {
  const handler = element.props.onBlur;
  if (typeof handler === 'function') (handler as () => void)();
}
