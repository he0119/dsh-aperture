/**
 * 设置表单的模型：把用户敲进去的东西先**落成草稿**，只有按保存那一下才写成一次带版本围栏的写入。
 *
 * 这是官方原语包里 `SettingsFormModel` / `settingsTextField` 的那一份语义，按本插件用到的部分自己
 * 实现一遍——理由与 [ui.tsx](./ui.tsx) 开头那段相同（那是随 Harness 走的 Client 包，改版不打招呼）。
 * 因此这里的**形状**刻意与宿主 `ctx.configForms.get(命名空间)` 交出来的那一份保持一致：读快照、
 * 订阅、以及一次原子的 `mutate` 就是全部接口，`SettingsFormScope` 那条形状与官方 `SettingsFormScope`
 * 一样窄，宿主那个控制器因此仍然直接可传。
 *
 * 为什么必须落草稿而不能一改就写：每一次设置写入都是一次**持久、带 revision 围栏**的文档改动，
 * 跟着输入框直接提交等于把一次编辑变成一次用户没要求、也预览不了的写入；落成草稿之后，屏幕上写着
 * 的就是保存会存下的。
 *
 * 一个字段显示的是**生效值**（用户层盖在组合层之上、再盖在 schema 默认之上），以及用户层里到底
 * 有没有这一项。标记「已覆盖」靠的是**这一项在不在**，不是值跟谁相等：与组合层默认值相等的覆盖，
 * 仍然是覆盖。
 *
 * @module dsh-aperture/client/forms
 */

// ------------------------------------------------------------ 宿主那一面的形状

/**
 * 模型读到的、宿主某个条目表单的那一份快照。
 *
 * 字段含义与官方 `SettingsFormScopeSnapshot` 一致——它是宿主与客户端之间那一份接缝的说明。
 */
export interface SettingsFormScopeSnapshot<T> {
  /** 宿主还在向这个客户端服务这个条目时是 `ready`；否则表单什么都不渲染。 */
  status: 'loading' | 'ready' | 'unavailable';
  /** 最近被接受的那份、已经过 schema 解析的 section；第一次接受之前是 undefined。 */
  value: T | undefined;
  /** 生效值所盖的组合层：清空之后一个字段回落到的就是它。 */
  base: unknown;
  /** 按存储原样读到的用户层；一个字段**在不在**这里，就是它算不算覆盖。 */
  user: unknown;
  /** 宿主这份文档是否接受写入。 */
  writable: boolean;
  /** 读到这份快照时的 revision；保存用它当围栏。 */
  revision: number | undefined;
}

/** 一次保存要发出去的一条路径改动，与宿主 `mutate` 接受的那份一致。 */
export type SettingsFormPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] };

/** 一份表单落草稿所依据的那个面：一个命名空间的读与一次原子写入。 */
export interface SettingsFormScope<T> {
  /** @returns 当前的同步快照。 */
  getSnapshot(): SettingsFormScopeSnapshot<T>;
  /**
   * 观察快照的替换。
   * @param {Function} listener - 每次快照变化之后被叫。
   * @returns {Function} 摘掉这个监听者的 disposer。
   */
  subscribe(listener: () => void): () => void;
  /**
   * 把有序的字段改动作为一次带 revision 围栏的写入发出去。
   * @param {ReadonlyArray<object>} ops - 按落下顺序排好的改动。
   * @param {number} [expectedRevision] - 草稿落下时读到的那份 revision（知道的话）。
   * @returns {Promise<boolean>} 宿主接受为 true、回绝为 false。
   */
  mutate(ops: readonly SettingsFormPathOp[], expectedRevision?: number): Promise<boolean>;
}

// ------------------------------------------------------------ 一个字段的读写规格

/** 一次字段写入：写成某个值，或者清掉这一项。 */
export type SettingsFieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' };

/** 一个 section 字段怎么在「存下的值」与「草稿文本」之间换算。 */
export interface SettingsFieldSpec {
  /** section 里的字段名。 */
  field: string;
  /** 把存下的值写回草稿文本；这一项没有值时是空串。 */
  format: (value: unknown) => string;
  /**
   * 这份草稿文本要落成的写入；文本不是这个字段接受的值得话是 undefined——那会**挡住保存**，
   * 而不是把这份编辑悄悄丢掉。
   */
  parse: (text: string) => SettingsFieldWrite | undefined;
}

/**
 * 一个自由文本字段：草稿为空就是清掉这一项，因此「清空再保存」与「恢复默认」是同一个手势。
 *
 * @param {string} field - section 里的字段名。
 * @returns {object} 这个字段的读写规格。
 */
export function settingsTextField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      const trimmed = text.trim();
      return trimmed === ''
        ? { kind: 'clear' }
        : { kind: 'set', value: trimmed };
    },
  };
}

// ------------------------------------------------------------ 表单状态与动作

/** 一个字段在控件上长什么样。 */
export interface SettingsFieldState {
  /** 控件渲染的草稿文本。 */
  text: string;
  /**
   * 保存会不会为这个字段留下一份用户层条目。落过草稿就由草稿自己回答，因此徽章预览的是**这次
   * 保存的结果**，而不是一个已经被待写编辑否定的旧状态。
   */
  overridden: boolean;
  /** 这份草稿不是这个字段接受的值；它会挡住保存。 */
  invalid: boolean;
}

/** 每一份插件设置表单共有的状态。 */
export interface SettingsFormShell {
  /** 命名空间没有被服务给这个客户端时为 false；此时这一页什么都不画。 */
  available: boolean;
  /** 宿主这份文档是否接受写入。 */
  writable: boolean;
  /** 表单里有没有一次保存会写下去的改动。 */
  dirty: boolean;
  /** 有没有哪份草稿是非法值——它会挡住保存。 */
  invalid: boolean;
  /** 有没有一次保存在过线。 */
  saving: boolean;
  /** 上一次保存有没有按落下的样子写成；下一次编辑或保存会清掉它。 */
  failed: boolean;
}

/** 每一份插件设置表单的槽位条目注进去的那几个写动作。 */
export interface SettingsFormActions {
  /** 为一个字段落下草稿文本。 */
  edit: (field: string, text: string) => void;
  /** 落下一份「清空」，好让保存之后这个字段重新继承组合层。 */
  resetField: (field: string) => void;
  /** 把每一份落下的草稿写下去，然后按宿主接受的那份重新播种。 */
  save: () => void;
  /** 丢掉每一份落下的草稿。 */
  discard: () => void;
}

// ------------------------------------------------------------ 选择器 store

/** 一个可观察的快照源——渲染器把注入面里的 `hooks` 条目按这个形状绑成选择器钩子。 */
export interface ObservableSnapshot<T> {
  /** @returns 当前投影；没有变化时必须是同一个引用。 */
  getSnapshot(): T;
  /**
   * 订阅投影的替换。
   * @param {Function} listener - 每次投影变化之后被叫。
   * @returns {Function} 摘掉这个监听者的 disposer。
   */
  subscribe(listener: () => void): () => void;
}

/**
 * 造一个选择器 store。
 *
 * `getSnapshot` 返回的是**存下来的那个引用**，只有 `set` 会换掉它——渲染器那一侧的钩子靠这一点
 * 认「变了没有」，每次调用都新造一个对象会让它自激。
 *
 * @param {object} init - 初始投影。
 * @returns {object} 读写这个投影的 store。
 */
function createSnapshotStore<T>(init: T): ObservableSnapshot<T> & { set: (next: T) => void } {
  let current = init;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      current = next;
      // 复制一份再叫：监听者里可能有人当场退订（组件卸载）。
      for (const listener of [...listeners]) listener();
    },
  };
}

// ------------------------------------------------------------ 模型本体

/**
 * 一份插件设置页背后的那个落草稿的模型。
 *
 * 投影走一个选择器 store，因为槽位组件是从快照上选着读的，而它底下同时有两样东西在变——宿主那份
 * scope 与本地的草稿——因此每一份投影都从这两样一起重建。
 */
export class SettingsFormModel<T extends Record<string, unknown>> {
  /** 宿主那一份读与原子写入的面。 */
  private readonly scope: SettingsFormScope<T>;
  /** 这份表单编辑的 section 字段。 */
  private readonly specs: ReadonlyMap<string, SettingsFieldSpec>;
  /** 落下的草稿：`clear` 是「恢复默认」那一路。 */
  private readonly staged = new Map<string, { readonly text: string; readonly clear: boolean }>();
  /** 每一份绑出去的投影在这一点上重建。 */
  private readonly listeners = new Set<() => void>();
  /** 第一次落草稿时读到的快照；写入的 revision 围栏取自它。 */
  private baseline: SettingsFormScopeSnapshot<T> | undefined;
  private readonly unsubscribe: () => void;
  private saving = false;
  private failed = false;

  /**
   * @param {object} scope - 这个命名空间共用的那份配置表单。
   * @param {ReadonlyArray<object>} specs - 这份表单编辑的 section 字段。
   */
  constructor(scope: SettingsFormScope<T>, specs: SettingsFieldSpec[]) {
    this.scope = scope;
    this.specs = new Map(specs.map((spec) => [spec.field, spec]));
    this.unsubscribe = scope.subscribe(() => {
      this.publish();
    });
  }

  /**
   * 发布这个表单的一份投影；scope 或某份草稿一变，它就会被重建。
   *
   * @param {Function} project - 从表单此刻的读数里造出这一页的状态。
   * @returns {object} 这一页组件用它那个绑好的选择器去读的 store。
   */
  bind<S>(project: () => S): ObservableSnapshot<S> {
    const store = createSnapshotStore(project());
    this.listeners.add(() => {
      store.set(project());
    });
    return store;
  }

  /**
   * 读表单这一层的状态：宿主服务的是什么，以及这一次保存会写下什么。
   *
   * @returns {object} 每一份表单共有的状态。
   */
  shell(): SettingsFormShell {
    const snapshot = this.scope.getSnapshot();
    const plan = this.plan();
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some((item) => item.op === undefined),
      saving: this.saving,
      failed: this.failed,
    };
  }

  /**
   * 读一个控件的状态。
   *
   * @param {string} field - section 字段名。
   * @returns {object} 草稿文本、保存会不会留下覆盖、以及它是不是非法值。
   */
  field(field: string): SettingsFieldState {
    const spec = this.spec(field);
    const staged = this.staged.get(field);
    if (staged === undefined) {
      return {
        text: spec.format(this.sectionValue(field)),
        overridden: this.stored(field),
        invalid: false,
      };
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text);
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === undefined,
    };
  }

  /**
   * 造出绑在这份表单上的编辑、恢复默认、保存与放弃四个动作。
   *
   * @returns {object} 槽位条目注进去的那份动作面。
   */
  actions(): SettingsFormActions {
    return {
      edit: (field, text) => {
        this.stage(field, { text, clear: false });
      },
      resetField: (field) => {
        // 「恢复默认」也是一份草稿：输入框回到用户层之下的那个值，落笔仍然要等保存那一下。
        this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true });
      },
      save: () => {
        void this.save();
      },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return;
        this.staged.clear();
        this.baseline = undefined;
        this.failed = false;
        this.publish();
      },
    };
  }

  /**
   * 把每一份落下的草稿写下去，然后按宿主接受的那份重新播种。
   *
   * 值有没有被接受只有宿主说了算——它的校验器管着 schema 说不出来的那些约束——因此结果是**读回来
   * 的**，不是这里猜的。没写成的保存会留着草稿，好让用户改一改，而不是重敲一遍。
   *
   * @returns {Promise<void>} 每一次写入与那次回读都落定之后。
   */
  async save(): Promise<void> {
    const plan = this.plan();
    // 官方的围栏：没有要写的改动、正在保存、文档只读、草稿里有非法值，四样里占一样就直接返回。
    if (
      plan.length === 0
      || this.saving
      || !this.scope.getSnapshot().writable
      || plan.some((item) => item.op === undefined)
    ) return;

    this.saving = true;
    this.failed = false;
    this.publish();
    try {
      const ops = plan.flatMap((item) => (item.op === undefined ? [] : [item.op]));
      const landed = ops.length === 0 || await this.scope.mutate(ops, this.baseline?.revision);
      if (!landed) {
        this.failed = true;
        return;
      }
      this.staged.clear();
      this.baseline = undefined;
      this.failed = false;
    } catch {
      this.failed = true;
    } finally {
      this.saving = false;
      this.publish();
    }
  }

  /** 摘掉这份表单对宿主快照的订阅。 */
  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  /**
   * 一次保存会写下的每一份改动。草稿不是这个字段接受的值的那些条目写的是一份**空计划**：表单
   * 仍然是「有改动」，而保存会回绝，不会把那份编辑丢掉。
   *
   * @returns {ReadonlyArray<object>} 按字段落草稿顺序排好的写入计划。
   */
  private plan(): Array<{ field: string; op?: SettingsFormPathOp }> {
    const plan: Array<{ field: string; op?: SettingsFormPathOp }> = [];
    for (const [field, staged] of this.staged) {
      const spec = this.spec(field);
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, op: { op: 'unset' as const, path: [field] } });
        continue;
      }
      // 草稿与生效值逐字相同：没有任何东西要写。
      if (staged.text === spec.format(this.sectionValue(field))) continue;
      const write = spec.parse(staged.text);
      if (write === undefined) plan.push({ field });
      else if (write.kind === 'clear') plan.push({ field, op: { op: 'unset' as const, path: [field] } });
      else plan.push({ field, op: { op: 'set' as const, path: [field], value: write.value } });
    }
    return plan;
  }

  /** 落一份草稿；围栏取第一次落草稿那一刻读到的快照。 */
  private stage(field: string, edit: { readonly text: string; readonly clear: boolean }): void {
    this.baseline ??= this.scope.getSnapshot();
    this.staged.set(field, edit);
    this.failed = false;
    this.publish();
  }

  /** 这个字段的读写规格；没有就是调用方与这份表单对不上。 */
  private spec(field: string): SettingsFieldSpec {
    const spec = this.specs.get(field);
    if (spec === undefined) throw new Error(`插件设置表单里没有字段 ${field}`);
    return spec;
  }

  /** 此刻宿主那一份快照。 */
  private snapshot(): SettingsFormScopeSnapshot<T> {
    return this.scope.getSnapshot();
  }

  /** 这个字段的生效值（组合层 + 用户层 + schema 默认之后）。 */
  private sectionValue(field: string): unknown {
    return this.snapshot().value?.[field];
  }

  /** 这个字段在用户层之下的那个值：清空之后回落到的就是它。 */
  private baseValue(field: string): unknown {
    const base = this.snapshot().base;
    return base === null || typeof base !== 'object' ? undefined : (base as Record<string, unknown>)[field];
  }

  /** 用户层里到底有没有这一项——这才是「已覆盖」，不是值跟谁相等。 */
  private stored(field: string): boolean {
    const user = this.snapshot().user;
    return user !== null && typeof user === 'object' && Object.hasOwn(user, field);
  }

  /** 叫醒每一份绑出去的投影。 */
  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
