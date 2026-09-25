/**
 * 一行模型的草稿，以及它到「一笔稀疏补丁」的换算。
 *
 * 草稿是**文本形态**（容量写成 `1M` / `384K` 或空串），与设置文档里的数值不是一回事；两个方向的
 * 换算由 `formatCapacity` / `parseCapacity` 负责。这里没有 React、也没有画出来的东西：输入框与
 * 开关长什么样在组件里（[ModelRow.tsx](./ModelRow.tsx) / [ModelEditor.tsx](./ModelEditor.tsx)），
 * 这一份只管「改了哪几项、该发什么出去」——行与编辑器都要问同一个问题，答案因此只能有一处。
 *
 * @module dsh-aperture/client/draft
 */

import type { PanelModelPatch } from '../panel.ts';
import type { PanelModel } from '../report.ts';
import type { Modality } from '../types.ts';
import { formatCapacity, parseCapacity } from './format.ts';
import type { LocaleKey, PanelTranslate } from './locales.ts';

/**
 * 界面能编辑的覆盖键。
 *
 * 列表以外的键（例如 `reasoningEfforts`）一旦出现在用户层里，这一行就只能整条撤：只清认得
 * 的那几项，它在报告里仍然是「已覆盖」，那颗标签会按不下去。
 */
export const EDITABLE_KEYS = Object.freeze(['name', 'api', 'contextWindow', 'maxTokens', 'input', 'thinking', 'alias']);

/**
 * 一个模型这一行的草稿：输入框里的文本与开关。
 *
 * 文本字段一律是**文本形态**（容量是 `1M` / `384K` 或空串），与设置文档里的数值不是一回事；
 * 两个方向的换算由 `parseCapacity` / `formatCapacity` 负责。
 */
export interface RowDraft {
  name: string;
  alias: string;
  contextWindow: string;
  maxTokens: string;
  text: boolean;
  image: boolean;
  reasoning: 'auto' | 'on' | 'off';
  api: string;
}

/** 文本类覆盖字段能取的那几个键；协议是有限枚举，单独使用下拉框。 */
export type TextFieldKey = 'name' | 'alias' | 'contextWindow' | 'maxTokens';

/** `PanelModelPatch` 的可写形态：这一页是逐字段攒出一份稀疏补丁的。 */
export type RowPatch = { -readonly [K in keyof PanelModelPatch]: PanelModelPatch[K] };

/**
 * `patchOf` 的结果：要发出去的补丁，与读不出数值的字段名。
 *
 * 字段名是**字典键**而不是拼好的句子——这里没有语言，按语言说出来是调用方的事（`t(bad)`）。
 */
export interface RowPatchResult {
  patch: RowPatch;
  bad: LocaleKey[];
}

/** 一行草稿表（模型 id → 草稿）。 */
export type RowDrafts = Record<string, RowDraft>;

/** 一行的展开状态（模型 id → 是否展开）。 */
export type RowOpened = Record<string, boolean>;

/**
 * 一个模型此刻在表单里长什么样。
 *
 * 取的都是**生效值**，输入框里显示的永远是此刻真正在用的东西；提交时逐字段与这份快照比较，
 * 只有改动过的字段才会发出去，因此界面不编辑的 `reasoningEfforts` 之类不会被顺手抹掉。
 *
 * @param {object} model - 报告里的一个模型。
 * @returns {object} 这一行的初始草稿。
 */
export function initialOf(model: PanelModel): RowDraft {
  return {
    name: model.name,
    alias: model.alias ?? '',
    // 容量回写成能原样读回来的最短写法（`1M`、`384K`），与官方「模型」页同一套词汇。
    contextWindow: formatCapacity(model.contextWindow),
    maxTokens: formatCapacity(model.maxTokens),
    text: model.input.includes('text'),
    image: model.input.includes('image'),
    // 「跟随发现」= 用户层里没写过这个键。写过了，生效值就是用户写的那个值。
    reasoning: declaredIn(model, 'thinking') ? (model.reasoning ? 'on' : 'off') : 'auto',
    api: declaredIn(model, 'api') ? (model.protocol ?? '') : '',
  };
}

/**
 * 用户层里写没写过这个键——这就是「覆盖」的判据。
 *
 * 报告里的 `overrideKeys` 直接来自用户层，不必拿生效值和默认值比：比出来的答案既会漏（写了与
 * 默认相同的值），也会多（schema 补出来的空值）。
 *
 * @param {object} model - 报告里的一个模型。
 * @param {string} key - 覆盖键。
 * @returns {boolean} 用户层里写过没有。
 */
export function declaredIn(model: PanelModel, key: string): boolean {
  return (model.overrideKeys ?? []).includes(key);
}

/**
 * 改动的字段 → 补丁；没变的不进补丁，非法值只报字段名。补丁里的空值就是「这一项不覆盖」：
 * 文本字段用空串或 `null`（别名用空串），模态用 `null`，推理用 `null` 表示回落到发现。
 *
 * @param {object} draft - 此刻的草稿。
 * @param {object} initial - 这一行的生效值（`initialOf`）。
 * @returns {object} 补丁与读不出数值的字段名（字典键）。
 */
export function patchOf(draft: RowDraft, initial: RowDraft): RowPatchResult {
  const patch: RowPatch = {};
  const bad: LocaleKey[] = [];

  // 前后空白不算改动：只把 `  名字  ` 的空格去掉不算换过值，否则会凭空写下一笔覆盖。
  const name = draft.name.trim();
  if (name !== initial.name) patch.name = name === '' ? null : name;

  const alias = draft.alias.trim();
  if (alias !== initial.alias) patch.alias = alias;

  for (const [field, label] of [['contextWindow', 'editContextWindow'], ['maxTokens', 'editMaxTokens']] as const) {
    if (draft[field] === initial[field]) continue;
    // 容量认 `1M`、`100K` 这种写法（官方「模型」页同一套）；空串是「这一项不覆盖」。
    const value = parseCapacity(draft[field]);
    if (capacityBad(draft[field])) bad.push(label);
    else if (value === undefined) patch[field] = null;
    // 换一种写法写同一个数（`100k` 对 `100K`）不是改动：写下去只会多一笔没人改过的覆盖。
    else if (value !== parseCapacity(initial[field])) patch[field] = value;
  }

  if (draft.api !== initial.api) patch.api = draft.api === '' ? null : draft.api;
  if (draft.reasoning !== initial.reasoning) {
    patch.thinking = draft.reasoning === 'auto' ? null : draft.reasoning === 'on';
  }

  const wanted = [draft.text ? 'text' : undefined, draft.image ? 'image' : undefined]
    .filter((item): item is Modality => item !== undefined);
  const before = [initial.text ? 'text' : undefined, initial.image ? 'image' : undefined]
    .filter((item): item is Modality => item !== undefined);
  if (wanted.join('+') !== before.join('+')) patch.input = wanted.length === 0 ? null : wanted;

  return { patch, bad };
}

/**
 * 容量那一项的本地判定，输入框与保存走同一条规矩：空串不是非法，是「这一项不覆盖」；其余必须
 * 是不小于 1 的整数——面板只收这种值，放过去只会换来一次没必要的往返。`1G`、`1.5`、`0` 都在
 * 这里被挡下。
 *
 * @param {string} text - 输入框里的文本。
 * @returns {boolean} 读不出来或者读出来不是正整数。
 */
export function capacityBad(text: string): boolean {
  const value = parseCapacity(text);
  return value !== undefined && (!Number.isInteger(value) || value < 1);
}

/**
 * 这一行有哪几项还没写下去。
 *
 * 行首那颗「有未保存的改动」与编辑器底部那句「有 N 项改动还没写下去」问的是同一件事，因此走的
 * 也是同一个数——两处说法不会打架。
 *
 * @param {object} model - 报告里的这一行。
 * @param {object} draft - 这一行此刻的草稿。
 * @returns {number} 改动过的字段数。
 */
export function pendingChanges(model: PanelModel, draft: RowDraft): number {
  return Object.keys(patchOf(draft, initialOf(model)).patch).length;
}

/** 覆盖键在界面上的名字；界面不编辑的键（`reasoningEfforts`）另给一个词条。 */
const OVERRIDE_NAMES: Readonly<Record<string, LocaleKey>> = {
  name: 'editName',
  api: 'editApi',
  contextWindow: 'editContextWindow',
  maxTokens: 'editMaxTokens',
  input: 'editInput',
  thinking: 'editReasoning',
  alias: 'editAlias',
  reasoningEfforts: 'keyReasoningEfforts',
};

/**
 * 把覆盖键翻成给人看的一句话：界面认得的键都有字段，认不得的只有这里说得出名字。
 *
 * @param {readonly string[]} keys - 覆盖键。
 * @param {Function} t - 字典。
 * @returns {string} 用列表分隔符连起来的一句话。
 */
export function overrideKeyNames(keys: readonly string[], t: PanelTranslate): string {
  return keys
    .map((key) => (OVERRIDE_NAMES[key] === undefined ? key : t(OVERRIDE_NAMES[key])))
    .join(t('listSeparator'));
}
