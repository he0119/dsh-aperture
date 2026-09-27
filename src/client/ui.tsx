/**
 * 本插件自己的控件：官方原语包（`@deepseek-ai/dsh-client-ui-primitives`）里这一页真正用到的那几个，
 * 按本仓库的类名前缀抄一份。
 *
 * **为什么不直接 require 官方那一个包**（这也是官方插件指南 `cordis-plugin-development` 的
 * `references/practices.md` 那一条）：它是随 Harness 走的 Client 包，改版不打招呼；纯 JS 插件没有
 * 类型检查，抄的那份与装的那份错位了也没人告诉你；而且它一抛，槽位条目就被渲染器的错误边界换成
 * 一个空 div（`data-slot-error`），用户只看到少了一块。抄进自己包里之后，唯一还与宿主共享的东西
 * 只剩主题 token——token 改名只会掉外观，不会炸渲染（见 [ui.css](./ui.css)）。
 *
 * 抄的规矩（与官方指南一致）：
 *
 * - 标记、类名结构、行为逐条照抄，类名换成 `dap-ui-` 前缀，选择器全部收在 `[data-dsh-aperture]` 下。
 * - 组件名与官方保持一致，方便日后对着上游同名文件逐行比对；来源是**运行中那一份**的产物
 *   （`@deepseek-ai/dsh-client-ui-primitives@0.1.7-rc.2` 的 `lib/index.js` 与 `lib/**\/*.module.css`，
 *   深色/浅色下的几何与官方插件页当场看到的一致）。rc.1 → rc.2 之间这些控件的圆角、内边距与焦点环
 *   已经全变过一遍（18px 定值→token、3px→4px、`2px solid`→`focus-ring-*` token），这正是不能把
 *   控件借给上游的理由。
 * - 只抄这一页用得到的那部分：`Button` 去掉没人用的 `toolbar` 变体，`Tag` 只留 `neutral` /
 *   `info` / `warning` 三种 tone，`StateDot` 去掉需要动画的 `ongoing`（这一页没有「正在进行中」的
 *   受观察对象，报告是整页取一次），`SegmentedControl` 保留键盘行走与 `role="tab"` 语义。
 * - 两个上游引用了**主题里并不存在**的 token，这里换成了真实存在的那个（见 ui.css 末尾的说明）：
 *   `--dsw-alias-label-error` 与 `--dsw-alias-bg-layer-4` 在主题的 395 个定义里都找不到。
 *
 * @module dsh-aperture/client/ui
 */

import * as React from 'react';

import type { SettingsFormShell } from './forms.ts';

/** 条件类名拼接（上游用 `clsx`；本插件只有这几处，不必为它引一个依赖）。 */
function cx(...parts: ReadonlyArray<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ------------------------------------------------------------------ 图标

/**
 * 右向尖角，官方 `IconChevronRightOutlineRegular` 的同一份 artwork（1px 描边）。
 *
 * @param {object} props - `size` 为边长（默认 14）。
 * @returns {object} 图标元素。
 */
export function IconChevronRightOutlineRegular({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <path d="M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4" stroke="currentColor" />
    </svg>
  );
}

/**
 * 刷新的箭头环，官方 `IconRefreshOutlineRegular` 的同一份 artwork（1px 描边）。
 *
 * @param {object} props - `size` 为边长（默认 16）。
 * @returns {object} 图标元素。
 */
export function IconRefreshOutlineRegular({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <path
        d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1"
        stroke="currentColor"
      />
      <path d="M14.4999 1.5V5.1H10.8999" stroke="currentColor" />
    </svg>
  );
}

/**
 * 信息圆点，官方 `IconInfoOutlineRegular` 的同一份 artwork（实心路径，无描边）。
 *
 * @param {object} props - `size` 为边长（默认 14）。
 * @returns {object} 图标元素。
 */
export function IconInfoOutlineRegular({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M12.5757 7.00012C12.5757 3.92085 10.0794 1.42463 7.00012 1.42456C3.9208 1.42456 1.42456 3.9208 1.42456 7.00012C1.42463 10.0794 3.92085 12.5757 7.00012 12.5757C10.0793 12.5756 12.5756 10.0793 12.5757 7.00012ZM13.8002 7.00012C13.8001 10.7559 10.7559 13.8001 7.00012 13.8002C3.2443 13.8002 0.199291 10.7559 0.199219 7.00012C0.199219 3.24426 3.24426 0.199219 7.00012 0.199219C10.7559 0.199291 13.8002 3.2443 13.8002 7.00012Z"
        fill="currentColor"
      />
      <path d="M7.6127 3.18921V4.55986H6.38735V3.18921H7.6127Z" fill="currentColor" />
      <path d="M7.6127 5.68921V10.8109H6.38735V5.68921H7.6127Z" fill="currentColor" />
    </svg>
  );
}

// ------------------------------------------------------------------ 控件

/** 按钮的视觉家族；三种都由 `--dsw-alias-button-*` / `interactive-bg-*` token 撑起来。 */
export type ButtonVariant = 'primary' | 'ghost' | 'outline';

/** {@link Button} 的入参；原生按钮属性原样透传。 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉家族（默认 `ghost`）。 */
  variant?: ButtonVariant;
  /** `md` 是 36px 控件、`sm` 是 28px 紧凑控件。 */
  size?: 'md' | 'sm';
  /** 前置图标（官方按 16px 的槽位摆）。 */
  icon?: React.ReactNode;
}

/**
 * 一颗按钮。
 *
 * @param {object} props - 视觉家族、尺寸、图标与原生按钮属性。
 * @param {object} ref - 原生按钮，供焦点管理与浮层锚点使用。
 * @returns {object} 按钮元素。
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', icon, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx('dap-ui-button', `dap-ui-button-${variant}`, `dap-ui-button-${size}`, className)}
      {...rest}
    >
      {icon == null ? null : <span className="dap-ui-buttonIcon">{icon}</span>}
      {children}
    </button>
  );
});

/**
 * 一个开关。
 *
 * 开合状态挂在 `aria-checked` 上而不是另一个并行类名，因此看到的样子与读屏软件读到的东西不会分家。
 *
 * @param {object} props - 当前状态、变化回调、无障碍名字与禁用状态。
 * @returns {object} 开关元素。
 */
export function Switch(props: {
  /** 当前状态；这个控件是完全受控的。 */
  checked: boolean;
  /** 点击请求的目标状态。 */
  onChange: (next: boolean) => void;
  /** 本地化的无障碍名字，由渲染点持有。 */
  label: string;
  /** 是否拒绝输入；写入在飞时调用方也要置上，不只是部署锁死时。 */
  disabled?: boolean;
  /** 本地化的悬停说明，通常是「为什么这颗开关按不动」。 */
  title?: string;
  /** 排版用的额外类名。 */
  className?: string;
}) {
  const { checked, onChange, label, disabled = false, title, className } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      className={cx('dap-ui-switch', className)}
      onClick={() => {
        onChange(!checked);
      }}
    >
      <span className="dap-ui-switch-thumb" />
    </button>
  );
}

/**
 * 一个带标签的复选框：可见的标签与无障碍名字是同一个，语义交给原生控件。
 *
 * @param {object} props - 当前状态、变化回调、标签与禁用状态。
 * @returns {object} 包着复选框的 `label`。
 */
export function Checkbox(props: {
  /** 当前勾选状态。 */
  checked: boolean;
  /** 收到的目标勾选状态。 */
  onChange: (next: boolean) => void;
  /** 本地化的可见标签，同时也是无障碍名字。 */
  label: string;
  /** 是否拒绝改动。 */
  disabled?: boolean;
  /** 可选的本地化悬停说明。 */
  title?: string;
  /** 标签排版用的额外类名。 */
  className?: string;
}) {
  const { checked, onChange, label, disabled = false, title, className } = props;
  return (
    <label className={cx('dap-ui-checkbox', className)} title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * 一枚只读标签。
 *
 * 胶囊几何固定：标签在哪儿都是同一个尺寸，只有配色随 `tone` 变。本插件只用到三种 tone
 * （`neutral` 无褒贬的事实、`info` 分类、`warning` 需要注意），上游另外几种这一页没有落点。
 *
 * @param {object} props - tone 与内容。
 * @returns {object} 标签元素。
 */
export function Tag(props: {
  /** 配色；默认 `outline`。 */
  tone?: 'outline' | 'neutral' | 'info' | 'warning';
  /** 排版用的额外类名。 */
  className?: string;
  /** 本地化文案，由渲染点持有。 */
  children?: React.ReactNode;
}) {
  const { tone = 'outline', className, children } = props;
  return (
    <span className={cx('dap-ui-tag', className)} data-tone={tone}>
      {children}
    </span>
  );
}

/** 状态点要表达的那几种语义；`ongoing` 需要动画，这一页没有落点，因此没有抄。 */
export type StateDotState = 'done' | 'warning' | 'error' | 'idle';

/**
 * 一颗状态点。
 *
 * @param {object} props - 状态、直径与排版类名。
 * @returns {object} 点元素（`aria-hidden`；说法由渲染点用文字给出）。
 */
export function StateDot(props: {
  /** 显示哪一种语义。 */
  state: StateDotState;
  /** 外径像素；默认 10。 */
  size?: number;
  /** 排版用的额外类名。 */
  className?: string;
}) {
  const { state, size = 10, className } = props;
  return (
    <span
      className={cx('dap-ui-dot', className)}
      data-state={state}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/** 分段控件的一段；那三段推理模式就是它的三个值。 */
export interface SegmentedControlOption<Value extends string> {
  /** 选中这一段时调用方收到的值。 */
  value: Value;
  /** 本地化段文案。 */
  label: string;
  /** 这一段是否拒绝选择。 */
  disabled?: boolean;
  /** 本地化的悬停说明，通常是「为什么这一段锁着」。 */
  title?: string;
}

/** 方向键与 Home / End。 */
function isWalkKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
    || key === 'Home' || key === 'End';
}

/**
 * 一个行走键从当前选中段落到的那一段：方向键找最近的一段可用邻居并绕回，Home / End 跳到首尾。
 *
 * @param {ReadonlyArray<object>} options - 全部段。
 * @param {number} from - 当前选中段的下标。
 * @param {string} key - 按下的键。
 * @returns {object|undefined} 目标段（没有可用的就什么都没有）。
 */
function walk<Value extends string>(
  options: readonly SegmentedControlOption<Value>[],
  from: number,
  key: string,
): SegmentedControlOption<Value> | undefined {
  const enabled = options.filter((option) => option.disabled !== true);
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled[enabled.length - 1];
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
  const count = options.length;
  for (let offset = 1; offset < count; offset += 1) {
    const candidate = options[((from + step * offset) % count + count) % count];
    if (candidate !== undefined && candidate.disabled !== true) return candidate;
  }
  return undefined;
}

/**
 * 一个分段控件。
 *
 * 段是等宽的网格列，宽度按最宽的那段撑开——因此那颗滑动的指示块可以**算**出来而不必去量 DOM：
 * 根节点带着段数与当前下标两个自定义属性，指示块的宽度与位移都从它们推导。
 *
 * @param {object} props - 基准 id、当前值、全部段与选择回调。
 * @returns {object} `tablist` 元素。
 */
export function SegmentedControl<Value extends string>(props: {
  /** 调用方的基准 id：每一段是 `<id>-<value>`，并把 `<id>-<value>-panel` 认作它控制的面板。 */
  id: string;
  /** 选中项的值；这个控件是完全受控的。 */
  value: Value;
  /** 按显示顺序排列的段，至少两段。 */
  options: readonly SegmentedControlOption<Value>[];
  /** 点击或行走键请求的值；已经是选中项时不会被叫。 */
  onChange: (next: Value) => void;
  /** 本地化的 tablist 无障碍名字。 */
  label: string;
  /** 锁住每一段，通常是当前面板上有写入或取数在飞、切走会把它们丢在半路。 */
  disabled?: boolean;
  /** 排版用的额外类名。 */
  className?: string;
}) {
  const { id, value, options, onChange, label, disabled = false, className } = props;
  const list = React.useRef<HTMLDivElement>(null);
  const selected = options.findIndex((option) => option.value === value);

  React.useEffect(() => {
    const root = list.current;
    if (root === null) return;
    // 只有焦点本来就在这个控件里时才把焦点搬到新选中的那一段：点选不该抢走别处输入的焦点。
    if (!root.contains(document.activeElement)) return;
    root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [value]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!isWalkKey(event.key)) return;
    event.preventDefault();
    const target = walk(options, selected, event.key);
    if (target !== undefined && target.value !== value) onChange(target.value);
  };

  const indicator = {
    '--dsh-segment-count': String(options.length),
    '--dsh-segment-index': String(selected),
  } as React.CSSProperties;

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className={cx('dap-ui-segments', className)}
      style={indicator}
    >
      <span aria-hidden="true" className="dap-ui-segments-indicator" />
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            id={`${id}-${option.value}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`${id}-${option.value}-panel`}
            tabIndex={active ? 0 : -1}
            disabled={disabled || option.disabled === true}
            title={option.title}
            className="dap-ui-segments-tab"
            onClick={() => {
              if (!active) onChange(option.value);
            }}
            onKeyDown={onKeyDown}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ 设置表单

/** 设置表单外壳要渲染的那几句文案，来自本插件自己的字典。 */
export interface SettingsFormLabels {
  /** 命名空间没有被服务时，顶在控件位置上的那一句。 */
  unavailable: string;
  /** 文档只读时压在控件上面的那一句。 */
  readOnly: string;
  /** 宿主没有接受这次保存时，贴在保存按钮旁边的那一句。 */
  saveFailed: string;
  /** 保存控件。 */
  save: string;
  /** 保存正在过线时那颗保存控件。 */
  saving: string;
}

/** {@link SettingsForm} 的入参。 */
export interface SettingsFormProps {
  /** 外壳的文案。 */
  labels: SettingsFormLabels;
  /** 表单状态：可用性、可写性与这一按会写下什么。 */
  state: SettingsFormShell;
  /** 把每一份落下的草稿都写下去。 */
  onSave: () => void;
  /** 丢掉每一份落下的草稿；离开这一页时表单自己会叫它。 */
  onDiscard: () => void;
  /** 插件自己的控件。 */
  children: React.ReactNode;
}

/**
 * 一份插件设置表单的外壳：只读时的提示、插件自己的控件，以及「写下去」那一颗按钮。
 *
 * 只有保存会写。离开这一页就丢掉所有落下的草稿，因此这个外壳在卸载时自己 discard，不另给一颗
 * 「放弃」按钮。命名空间不再被服务时，它在控件的位置上说明这件事，而不是摆一堆没人接的字段。
 *
 * @param {object} props - 文案、状态、控件与保存 / 放弃两个动作。
 * @returns {object} 表单，或者命名空间没被服务时的那一句话。
 */
export function SettingsForm(props: SettingsFormProps) {
  const { state, labels } = props;
  // 卸载时要叫的是**最新**那一份 discard（渲染器每轮都会重造注入面），因此用 ref 兜住。
  const discard = React.useRef(props.onDiscard);
  discard.current = props.onDiscard;
  React.useEffect(() => () => {
    discard.current();
  }, []);

  if (!state.available) {
    return <p className="dap-ui-form-unavailable" role="status">{labels.unavailable}</p>;
  }

  const blocked = !state.dirty || state.invalid || state.saving;
  return (
    <div className="dap-ui-form">
      {state.writable
        ? null
        : <p className="dap-ui-form-readOnly" role="status">{labels.readOnly}</p>}
      {props.children}
      <div className="dap-ui-form-footer">
        {state.failed
          ? <p className="dap-ui-form-failed" role="status">{labels.saveFailed}</p>
          : null}
        <button
          type="button"
          className="dap-ui-form-save"
          disabled={blocked}
          onClick={props.onSave}
        >
          {state.saving ? labels.saving : labels.save}
        </button>
      </div>
    </div>
  );
}

/**
 * 一个落草稿的文本字段：标签、草稿文本、「保存会不会留下覆盖」的徽章，以及那一颗把字段交还给
 * 组合层的「恢复默认」。
 *
 * `numeric` 只是把数字键盘请出来，**不**决定这个字段接受什么——那由字段自己的规格决定，因此控件
 * 从不悄悄改写用户敲进去的东西。
 *
 * @param {object} props - 字段文案、草稿文本与读写动作。
 * @returns {object} 带标签的控件。
 */
export function SettingsValueField(props: {
  /** 把标签与控件关联起来的稳定 id。 */
  id: string;
  /** 可见标签。 */
  label: string;
  /** 控件下面那一行说明。 */
  hint?: string;
  /** 由标签旁那颗信息按钮披露的规则。 */
  help?: { label: string; content: React.ReactNode };
  /** 只提示数字键盘，不缩小这个控件接受的范围。 */
  numeric?: boolean;
  /** 草稿为空时显示的占位符。 */
  placeholder?: string;
  /** 这个控件渲染的草稿文本。 */
  text: string;
  /** 保存会不会为这个字段留下一份用户层条目。 */
  overridden: boolean;
  /** 草稿不是这个字段接受的值。 */
  invalid: boolean;
  /** 「已覆盖」徽章的文案。 */
  overriddenLabel: string;
  /** 「恢复默认」那颗控件的文案。 */
  resetLabel: string;
  /** 草稿非法时顶掉 hint 的那句话。 */
  invalidLabel: string;
  /** 禁用全部控件（文档只读，或命名空间不可用）。 */
  disabled: boolean;
  /** 落下草稿文本。 */
  onEdit: (text: string) => void;
  /** 落下一份「清空」，好让保存之后这个字段重新继承组合层。 */
  onReset: () => void;
}) {
  const [helpOpen, setHelpOpen] = React.useState(false);
  const helpId = `${props.id}-help`;
  const messageId = `${props.id}-message`;
  const hasMessage = props.invalid || Boolean(props.hint);
  const description = [hasMessage ? messageId : '', helpOpen ? helpId : ''].filter(Boolean).join(' ');

  return (
    <div className="dap-ui-field">
      <div className="dap-ui-field-head">
        <div className="dap-ui-field-labelGroup">
          <label className="dap-ui-field-label" htmlFor={props.id}>{props.label}</label>
          {props.help === undefined
            ? null
            : (
              <button
                type="button"
                className="dap-ui-field-helpButton"
                aria-label={props.help.label}
                aria-expanded={helpOpen}
                aria-controls={helpId}
                onClick={() => {
                  setHelpOpen(!helpOpen);
                }}
              >
                <IconInfoOutlineRegular size={12} />
              </button>
            )}
        </div>
        {props.overridden
          ? (
            <span className="dap-ui-field-badges">
              <Tag tone="neutral">{props.overriddenLabel}</Tag>
              <button
                type="button"
                className="dap-ui-field-reset"
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <input
        id={props.id}
        className="dap-ui-field-input"
        type="text"
        {...(props.numeric === true ? { inputMode: 'numeric' as const } : {})}
        {...(props.invalid ? { 'aria-invalid': true } : {})}
        aria-describedby={description || undefined}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => {
          props.onEdit(event.target.value);
        }}
      />
      {hasMessage
        ? (
          <p id={messageId} className={props.invalid ? 'dap-ui-field-invalid' : 'dap-ui-field-hint'}>
            {props.invalid ? props.invalidLabel : props.hint}
          </p>
        )
        : null}
      {props.help !== undefined && helpOpen
        ? (
          <div
            id={helpId}
            className="dap-ui-field-help"
            role="region"
            aria-label={props.help.label}
          >
            {props.help.content}
          </div>
        )
        : null}
    </div>
  );
}
