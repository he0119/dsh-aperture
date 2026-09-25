/**
 * 配置页：插件列表里本插件那个包页上的设置页（实例地址、同步开关，以及逐模型的覆盖）。
 *
 * 页面只交内容，控件用官方原语，**没有卡片**——标题与面包屑由页主画。表单状态读注入面里的
 * `useApertureCard`（官方 `SettingsFormModel` 的投影），报告、提示语与每行草稿是这一页的局部
 * 状态；报告里的事实（`panel.status` 那一份结构化数据）只是不再整块摊开给用户看。
 *
 * @module dsh-aperture/client/AperturePanel
 */

import * as React from 'react';
import {
  Button,
  Checkbox,
  IconChevronRightOutlineRegular,
  IconRefreshOutlineRegular,
  SegmentedControl,
  SettingsForm,
  SettingsValueField,
  StateDot,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  SettingsFieldState,
  SettingsFormActions,
  SettingsFormShell,
  StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client';
import type { PanelAction, PanelModelPatch } from '../panel.ts';
import type { PanelModel, PanelReport } from '../report.ts';
import type { FactSource, Modality } from '../types.ts';
import { formatCapacity, formatCount, parseCapacity } from './format.ts';
import { NS, interpolate, zhDict, type LocaleKey } from './locales.ts';

/**
 * 界面能编辑的覆盖键。
 *
 * 列表以外的键（例如 `reasoningEfforts`）一旦出现在用户层里，这一行就只能整条撤：只清认得
 * 的那几项，它在报告里仍然是「已覆盖」，那颗标签会按不下去。
 */
const EDITABLE_KEYS = Object.freeze(['name', 'api', 'contextWindow', 'maxTokens', 'input', 'thinking', 'alias']);

/** 一个错误的人话形式。 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 事实来源 → 字典键；未知来源原样显示。 */
const SOURCE_KEYS: Readonly<Record<string, LocaleKey>> = {
  aperture: 'sourceAperture',
  'models.dev': 'sourceModelsDev',
  config: 'sourceConfig',
  default: 'sourceDefault',
};

/**
 * 一个模型这一行的草稿：输入框里的文本与开关。
 *
 * 文本字段一律是**文本形态**（容量是 `1M` / `384K` 或空串），与设置文档里的数值不是一回事；
 * 两个方向的换算由 `parseCapacity` / `formatCapacity` 负责。
 */
interface RowDraft {
  name: string;
  alias: string;
  contextWindow: string;
  maxTokens: string;
  text: boolean;
  image: boolean;
  reasoning: 'auto' | 'on' | 'off';
  api: string;
}

/** 文本类覆盖字段能取的那几个键（`textField` 只服务它们）。 */
type TextFieldKey = 'name' | 'alias' | 'api' | 'contextWindow' | 'maxTokens';

/** `PanelModelPatch` 的可写形态：这一页是逐字段攒出一份稀疏补丁的。 */
type RowPatch = { -readonly [K in keyof PanelModelPatch]: PanelModelPatch[K] };

/** `patchOf` 的结果：要发出去的补丁，与读不出数值的字段名（给人看）。 */
interface RowPatchResult {
  patch: RowPatch;
  bad: string[];
}

/** 一行草稿表（模型 id → 草稿）。 */
type RowDrafts = Record<string, RowDraft>;

/** 一行的展开状态（模型 id → 是否展开）。 */
type RowOpened = Record<string, boolean>;

/** 顶栏那条提示。 */
interface Notice {
  ok: boolean;
  text: string;
}

/** 一个文本类覆盖字段的读写词汇与说明。 */
interface TextFieldCopy {
  /** 字段名的字典键。 */
  label: LocaleKey;
  /** 长解释的字典键（官方那个「i」按钮）。 */
  hint: LocaleKey;
  /** 这一项的事实来源怎么取。 */
  source: (model: PanelModel) => FactSource;
  /** 「恢复默认」落到草稿里的值。 */
  cleared: string;
  /** 容量那两项：认 `1M` / `384K`，读不出来的挡住保存。 */
  numeric?: boolean;
  /** 这一项不覆盖时回落到的值，摆在占位符里。 */
  placeholder?: (model: PanelModel) => string;
}

/** 报告与两个写端点（走 `aperturePanel` Remote）。 */
export interface PanelFace {
  status(): Promise<PanelReport>;
  refresh(): Promise<PanelAction>;
  writeModel(id: string, patch: PanelModelPatch | null): Promise<PanelAction>;
}

/** 注入面里 `useApertureCard` 交给组件的快照：官方表单外壳加上这一页那两个字段。 */
type ApertureCardSnapshot = SettingsFormShell & {
  baseUrl: SettingsFieldState;
  sync: SettingsFieldState;
};

/**
 * 配置页组件拿到的注入面：注册时 `inject` 返回什么，这里就要求什么；渲染器另外把
 * `locale: NS` 绑成 `t`、把 `hooks.apertureCard` 变成 `useApertureCard` 选择器钩子。
 */
export interface AperturePanelProps {
  /** 字典（注册时声明了 `locale: NS`）；没有时用内置中文兜底（测试与首次渲染）。 */
  t?: TranslateNS<typeof NS>;
  /** 表单投影的选择器钩子。 */
  useApertureCard: <T>(select: (snapshot: ApertureCardSnapshot) => T) => T;
  /** 报告与两个写端点。 */
  panel: PanelFace;
  /** 官方表单模型的动作（`save` 用的是可等待的那一个，见下）。 */
  edit: SettingsFormActions['edit'];
  resetField: SettingsFormActions['resetField'];
  discard: SettingsFormActions['discard'];
  /** 保存所有草稿，等它落盘。 */
  save: () => Promise<void>;
  /** 这一轮的保存是否被拒。 */
  failed: () => boolean;
}

/**
 * 一个模型此刻在表单里长什么样。
 *
 * 取的都是**生效值**，输入框里显示的永远是此刻真正在用的东西；提交时逐字段与这份快照比较，
 * 只有改动过的字段才会发出去，因此界面不编辑的 `reasoningEfforts` 之类不会被顺手抹掉。
 */
function initialOf(model: PanelModel): RowDraft {
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
 */
function declaredIn(model: PanelModel, key: string): boolean {
  return (model.overrideKeys ?? []).includes(key);
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

// ------------------------------------------------------------------ 页面

/**
 * 配置页：实例（地址、同步开关）与模型清单。
 *
 * 表单状态读注入面里的 `useApertureCard`（官方 SettingsFormModel 的投影），报告、提示语与每行
 * 草稿是局部状态——它们是这一页的视图状态，不是设置文档的一部分。报告本身（`panel.status` 那一份
 * 结构化数据）仍然要读：每一行的事实、覆盖与状态点都长在它上面，只是不再整块摊开给用户看。
 *
 * **effect 的依赖里刻意不放注入面**：`inject` 面由渲染器每次渲染重新组装，把它的身份放进依赖会
 * 让 effect 每渲染一次就重跑一次。因此报告用一个自增计数器当重读信号（依赖里只有那个数），注入
 * 面里的函数只在事件处理里调用，拿到的永远是当轮的那份。
 *
 * @param {object} props - 注入面：`useApertureCard`、`panel`（报告端点）、`save` / `edit` /
 *   `resetField` / `discard` / `failed`（设置表单）与 `t`（字典，注册时声明了 `locale`）。
 * @returns {object} 页面元素。
 */
export function AperturePanel(props: AperturePanelProps) {
  const t: TranslateNS<typeof NS> = typeof props.t === 'function'
    ? props.t
    : (key, params) => interpolate(zhDict[key] ?? key, params);
  const state = props.useApertureCard((snapshot) => snapshot);

  const [report, setReport] = React.useState<PanelReport | null>(null);
  const [banner, setBanner] = React.useState<Notice | null>(null);
  const [busy, setBusy] = React.useState('');
  const [drafts, setDrafts] = React.useState<RowDrafts>({});
  const [opened, setOpened] = React.useState<RowOpened>({});
  const [revision, setRevision] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    props.panel.status().then(
      (next) => {
        if (!cancelled) setReport(next);
      },
      (error) => {
        if (!cancelled) setBanner({ ok: false, text: textOf(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [revision]);

  /** 跑一个动作：期间禁用控件，结束后把结果贴出来并按需重读报告。 */
  const run = (key: string, action: () => Promise<PanelAction>, after?: () => void): void => {
    setBusy(key);
    setBanner(null);
    void (async () => {
      try {
        const result = await action();
        setBanner({ ok: result.ok, text: result.summary });
      } catch (error) {
        setBanner({ ok: false, text: textOf(error) });
      } finally {
        setBusy('');
        if (after !== undefined) after();
      }
    })();
  };

  /**
   * 保存设置里那两个字段，然后等一轮重新发现落地再说话。
   *
   * 写入走官方表单模型的 `save()`：它自带 `revision` 围栏（期间别处改过就拒绝，而不是覆盖别人的
   * 改动）并从宿主接受的那份重新播种，因此写完不重读设置——投影会自己变新。报告里的模型事实
   * 与状态点来自最近一次刷新，写完必须等一轮，否则就是「保存了却没变」。设置变更自己也会唤起同一轮
   * 刷新（单飞判定按配置版本合并），因此这里通常并进那一轮。
   */
  const saveSettings = () => run('save', async () => {
    await props.save();
    if (props.failed()) return { ok: false, summary: t('configRefused') };
    const round = await props.panel.refresh();
    // 写入成功了，但重新发现可能失败——两件事不能混成一句话说，因此后半句照抄那一轮的说法。
    return { ok: round.ok, summary: t('savedResult', { result: round.summary }) };
  }, () => setRevision((value) => value + 1));

  /** 一个模型此刻的草稿；没改过就是生效值本身。 */
  const draftOf = (model: PanelModel): RowDraft => drafts[model.id] ?? initialOf(model);

  /** 改这一行的几个字段；用函数式更新，同一个 tick 里连着改几项也不会互相覆盖。 */
  const stage = (model: PanelModel, changes: Partial<RowDraft>): void => {
    setDrafts((current) => ({
      ...current,
      [model.id]: { ...(current[model.id] ?? initialOf(model)), ...changes },
    }));
  };

  /**
   * 改动的字段 → 补丁；没变的不进补丁，非法值只报字段名。补丁里的空值就是「这一项不覆盖」：
   * 文本字段用空串或 `null`（别名用空串），模态用 `null`，推理用 `null` 表示回落到发现。
   */
  const patchOf = (draft: RowDraft, initial: RowDraft): RowPatchResult => {
    const patch: RowPatch = {};
    const bad: string[] = [];

    // 前后空白不算改动：只把 `  名字  ` 的空格去掉不算换过值，否则会凭空写下一笔覆盖。
    const name = draft.name.trim();
    if (name !== initial.name) patch.name = name === '' ? null : name;

    const alias = draft.alias.trim();
    if (alias !== initial.alias) patch.alias = alias;

    for (const [field, label] of [['contextWindow', 'editContextWindow'], ['maxTokens', 'editMaxTokens']] as const) {
      if (draft[field] === initial[field]) continue;
      // 容量认 `1M`、`100K` 这种写法（官方「模型」页同一套）；空串是「这一项不覆盖」。
      const value = parseCapacity(draft[field]);
      if (capacityBad(draft[field])) bad.push(t(label));
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
  };

  /**
   * 容量那一项的本地判定，输入框与保存走同一条规矩：空串不是非法，是「这一项不覆盖」；其余必须
   * 是不小于 1 的整数——面板只收这种值，放过去只会换来一次没必要的往返。`1G`、`1.5`、`0` 都在
   * 这里被挡下。
   */
  const capacityBad = (text: string): boolean => {
    const value = parseCapacity(text);
    return value !== undefined && (!Number.isInteger(value) || value < 1);
  };

  /** 这一行有没有还没写下去的改动。 */
  const dirtyOf = (model: PanelModel): boolean =>
    Object.keys(patchOf(draftOf(model), initialOf(model)).patch).length > 0;

  /** 丢掉一行的草稿：输入框回到生效值。 */
  const dropDraft = (id: string): void => {
    setDrafts((current) => {
      const { [id]: _dropped, ...kept } = current;
      return kept;
    });
  };

  /** 展开或收起一行；收起不动草稿——收起来不等于放弃，标签会写着还有未保存的改动。 */
  const toggleRow = (model: PanelModel): void =>
    setOpened((current) => ({ ...current, [model.id]: current[model.id] !== true }));

  /**
   * 写下这一行（一个模型）的改动。
   *
   * 一行一个保存按钮，写下去的就只有这一行，宿主那边的版本校验也只管这一次写入。成功后收起面板
   * ——这一行的覆盖标签与事实都会跟着变，收起才看得见。
   *
   * @param {object} model - 报告里的一个模型。
   */
  const submitRow = (model: PanelModel): void => {
    const { patch, bad } = patchOf(draftOf(model), initialOf(model));
    if (bad.length > 0) {
      setBanner({ ok: false, text: t('invalidNumber', { field: bad.join(t('listSeparator')) }) });
      return;
    }
    if (Object.keys(patch).length === 0) {
      setBanner({ ok: true, text: t('noChanges') });
      return;
    }
    run('edit', () => props.panel.writeModel(model.id, patch), () => {
      dropDraft(model.id);
      setOpened((current) => ({ ...current, [model.id]: false }));
      setRevision((value) => value + 1);
    });
  };

  /** 取消这一行的编辑：草稿丢掉、面板收起，什么都不写。 */
  const cancelRow = (model: PanelModel): void => {
    dropDraft(model.id);
    setOpened((current) => ({ ...current, [model.id]: false }));
    setBanner(null);
  };

  /**
   * 撤销这一行的覆盖：只把**报告里写着确实被覆盖过**的字段清掉。
   *
   * 不是整条删掉：`aperture.models` 里那条可能还有界面根本不编辑的键（例如 `reasoningEfforts`），
   * 整条删掉等于把用户手写的东西一起扔掉，因此只把已知被覆盖的字段逐个置空。万一报告里出现了
   * 界面不认识的键（宿主以后加了字段），整条删掉是唯一能让这一行真的回落到发现值的做法。
   *
   * @param {object} model - 报告里的一个模型。
   */
  const clearOverrides = (model: PanelModel): void => {
    const keys = model.overrideKeys ?? [];
    const known = keys.filter((key) => EDITABLE_KEYS.includes(key));
    const unknown = keys.filter((key) => !EDITABLE_KEYS.includes(key));
    // 别名用空串表示「不要再覆盖」；其余字段 `null` 就是「不覆盖这一项」。
    const patch = Object.fromEntries(known.map((key) => [key, key === 'alias' ? '' : null]));
    const payload = unknown.length > 0 || known.length === 0 ? null : patch;
    run('revert', () => props.panel.writeModel(model.id, payload), () => {
      dropDraft(model.id);
      setOpened((current) => ({ ...current, [model.id]: false }));
      setRevision((value) => value + 1);
    });
  };

  const refreshReport = () => run('refresh', () => props.panel.refresh(), () => setRevision((value) => value + 1));

  /** 来源那句：报告里的事实都有出处，界面按语言渲染它。 */
  const sourceOf = (fact: FactSource): string => t('factSource', {
    source: SOURCE_KEYS[fact] === undefined ? fact : t(SOURCE_KEYS[fact]),
  });

  /** 最近一轮写入过的路由名；`undefined` 是「这一轮没同步」，不是「没写」——同步关着的时候报告里
   * 根本没有这一项，界面不能把「不知道」说成「没写」。
   */
  const writtenRoutes = report === null || report.refresh === undefined || report.refresh.sync === undefined
    ? undefined
    : report.refresh.sync.routes;

  /** 一行模型那几项生效的事实，一项一句；缺哪项就不提哪项。 */
  const factItems = (model: PanelModel): string[] => {
    const facts: string[] = [];
    if (model.route !== undefined) facts.push(t('factRoute', { route: model.route }));
    if (model.protocol !== undefined) facts.push(t('factProtocol', { protocol: model.protocol }));
    if (model.contextWindow !== undefined) {
      facts.push(t('factContextWindow', { count: formatCount(model.contextWindow) }));
    }
    if (model.maxTokens !== undefined) facts.push(t('factMaxTokens', { count: formatCount(model.maxTokens) }));
    facts.push(t('factInput', {
      value: model.input.length === 0
        ? t('modalityNone')
        : model.input.map((item) => t(item === 'image' ? 'modalityImage' : 'modalityText')).join('+'),
    }));
    facts.push(t('factReasoning', { value: model.reasoning ? t('reasoningOn') : t('reasoningOff') }));
    if (model.alias !== undefined && model.alias !== '') facts.push(t('factAlias', { alias: model.alias }));
    return facts;
  };

  /**
   * 这一行的状态点：绿是写进去了、灰是没写进去、黄是根本没有路由能服务它。
   *
   * 点旁边那句 `title` 就是它的说法——官方 `StateDot` 自己是 `aria-hidden`，说给谁听得由这里给。
   */
  const publishState = (model: PanelModel): { state: StateDotState; title: string } => {
    if (model.route === undefined) return { state: 'warning', title: t('statusUnserved') };
    if (writtenRoutes === undefined) return { state: 'idle', title: t('statusUnknown') };
    return writtenRoutes.includes(model.route)
      ? { state: 'done', title: t('statusPublished') }
      : { state: 'idle', title: t('statusNotPublished') };
  };

  /** 把覆盖键翻成给人看的一句话：界面认得的键都有字段，认不得的只有这里说得出名字。 */
  const overrideKeyNames = (keys: readonly string[]): string => keys
    .map((key) => (OVERRIDE_NAMES[key] === undefined ? key : t(OVERRIDE_NAMES[key])))
    .join(t('listSeparator'));

  /**
   * 一个文本类覆盖字段。
   *
   * 官方 `SettingsValueField` 的语义正好对得上：「已覆盖」= 用户层里有这个键（报告给的
   * `overrideKeys`），「恢复默认」= 把草稿改回「不覆盖」，非法草稿只标出来、由保存拦住。
   *
   * 长解释进 `help`（官方那个「i」按钮），输入框下面只留一句来源；外面再套一层格子，官方字段行
   * 那条「相邻就加上边框」在网格里会错开半格，隔开一层壳就不碰它了。
   */
  const textField = (model: PanelModel, key: TextFieldKey, copy: TextFieldCopy) => (
    <div className="dap-fieldCell">
      <SettingsValueField
        id={`dap-${model.id}-${key}`}
        label={t(copy.label)}
        help={{ label: t('fieldHelp', { field: t(copy.label) }), content: t(copy.hint) }}
        hint={sourceOf(copy.source(model))}
        {...(copy.placeholder === undefined ? {} : { placeholder: copy.placeholder(model) })}
        {...(copy.numeric === true ? { numeric: true } : {})}
        text={draftOf(model)[key]}
        overridden={declaredIn(model, key)}
        // 只有容量那两项用 `1M`/`384K` 的词汇，因此也只有它们会「读不出来」；文本字段写什么都算数。
        invalid={copy.numeric === true && capacityBad(draftOf(model)[key])}
        overriddenLabel={t('overridden')}
        resetLabel={t('resetField')}
        invalidLabel={t('invalidField')}
        disabled={busy !== ''}
        onEdit={(text) => stage(model, { [key]: text })}
        onReset={() => stage(model, { [key]: copy.cleared })}
      />
    </div>
  );

  /** 一行模型的覆盖编辑器：只写这一行。 */
  const editor = (model: PanelModel) => {
    const draft = draftOf(model);
    const overrides = model.overrideKeys ?? [];
    const changed = Object.keys(patchOf(draft, initialOf(model)).patch).length;
    // 界面认不得的键（`reasoningEfforts` 之类）只有「清空覆盖」撤得掉，而那是整条删，得先说清楚。
    const unknown = overrides.filter((key) => !EDITABLE_KEYS.includes(key));
    return (
      <div className="dap-editor">
        <div className="dap-editorHead">
          <span className="dap-editorId" title={model.id}>{model.id}</span>
          {unknown.length === 0
            ? null
            : (
              <span className="dap-warnNote">
                {t('editUnknownOverrides', { keys: overrideKeyNames(unknown) })}
              </span>
            )}
          {dirtyOf(model)
            ? <Tag tone="warning" className="dap-editorDirty">{t('dirtyTag')}</Tag>
            : null}
        </div>
        <div className="dap-editGroup">
          <span className="dap-editGroupTitle">{t('editGroupIdentity')}</span>
          <div className="dap-fields">
            {textField(model, 'name', {
              label: 'editName',
              hint: 'editNameHint',
              source: (item) => item.provenance.name,
              cleared: '',
            })}
            {textField(model, 'alias', {
              label: 'editAlias',
              hint: 'editAliasHint',
              source: () => 'config',
              cleared: '',
            })}
            {textField(model, 'api', {
              label: 'editApi',
              hint: 'editApiHint',
              // 协议没有单独一项来源：写过就是配置，没写过就是从通告的端点推导出来的。
              source: (item) => (declaredIn(item, 'api') ? 'config' : 'aperture'),
              cleared: '',
              placeholder: (item) => item.protocol ?? '',
            })}
          </div>
        </div>
        <div className="dap-editGroup">
          <span className="dap-editGroupTitle">{t('editGroupCapacity')}</span>
          <div className="dap-fields">
            {textField(model, 'contextWindow', {
              label: 'editContextWindow',
              hint: 'editCapacityHint',
              source: (item) => item.provenance.limits,
              cleared: '',
              numeric: true,
              // 清空之后回落到的就是发现到的那个数，摆在占位符里最省事。
              placeholder: (item) => formatCapacity(item.contextWindow),
            })}
            {textField(model, 'maxTokens', {
              label: 'editMaxTokens',
              hint: 'editCapacityHint',
              source: (item) => item.provenance.limits,
              cleared: '',
              numeric: true,
              placeholder: (item) => formatCapacity(item.maxTokens),
            })}
          </div>
        </div>
        {/* 模态与推理并排：它们都是「一个开关加一句话」，横着放比竖着叠省一半高度。 */}
        <div className="dap-grid2">
          <div className="dap-editGroup">
            <span className="dap-editGroupTitle">{t('editInput')}</span>
            <div className="dap-control">
              <Checkbox
                checked={draft.text}
                onChange={(next) => stage(model, { text: next })}
                label={t('modalityText')}
                disabled={busy !== ''}
              />
              <Checkbox
                checked={draft.image}
                onChange={(next) => stage(model, { image: next })}
                label={t('modalityImage')}
                disabled={busy !== ''}
              />
              {overrides.includes('input') ? <Tag tone="neutral">{t('overridden')}</Tag> : null}
            </div>
            <span className="dap-hint">{sourceOf(model.provenance.input)}</span>
          </div>
          <div className="dap-editGroup">
            <span className="dap-editGroupTitle">{t('editReasoning')}</span>
            {/* 显式给出 `Value`：`options` 里的字面量会被拓宽成 `string`，不给的话 `onChange`
                拿到的就是 `string`，与草稿上的字面量联合对不上。 */}
            <SegmentedControl<RowDraft['reasoning']>
              id={`dap-${model.id}-reasoning`}
              label={t('editReasoning')}
              value={draft.reasoning}
              options={[
                { value: 'auto', label: t('reasoningFollow') },
                { value: 'on', label: t('reasoningOn') },
                { value: 'off', label: t('reasoningOff') },
              ]}
              onChange={(next) => stage(model, { reasoning: next })}
              disabled={busy !== ''}
            />
            <span className="dap-hint">{sourceOf(model.provenance.reasoning)}</span>
          </div>
        </div>
        {model.endpoints.length === 0
          ? null
          : (
            <div className="dap-endpoints">
              <span className="dap-editGroupTitle">{t('factEndpoints')}</span>
              <ul className="dap-endpointList">
                {model.endpoints.map((endpoint) => (
                  <li className="dap-endpoint" key={endpoint}>{endpoint}</li>
                ))}
              </ul>
            </div>
          )}
        <div className="dap-actions">
          <span className="dap-actionsNote">
            {changed === 0 ? t('noPendingChanges') : t('pendingChanges', { count: changed })}
          </span>
          <Button variant="ghost" size="sm" onClick={() => cancelRow(model)} disabled={busy !== ''}>
            {t('cancelRow')}
          </Button>
          {overrides.length === 0
            ? null
            : (
              <Button variant="outline" size="sm" onClick={() => clearOverrides(model)} disabled={busy !== ''}>
                {t('clearOverrides')}
              </Button>
            )}
          <Button variant="primary" size="sm" onClick={() => submitRow(model)} disabled={busy !== ''}>
            {busy === 'edit' ? t('saving') : t('saveRow')}
          </Button>
        </div>
      </div>
    );
  };

  /**
   * 一行模型：折起来是身份与状态，展开是这一行的覆盖编辑器。
   *
   * 行首那条按钮盖满整行（官方 `DisclosureRow` 是一根 24px 高、`overflow:hidden` 的横条，标题又
   * 不许收缩，名字一长就把右边的事实和标签挤没了）。这里名字自己一行、过长省略，事实另起一行随
   * 宽度换行，标签跟在名字后面。
   */
  const modelRow = (model: PanelModel) => {
    const open = opened[model.id] === true;
    const overrides = model.overrideKeys ?? [];
    const status = publishState(model);
    return (
      <li key={model.id} className="dap-card">
        <button
          type="button"
          className="dap-cardHead"
          aria-expanded={open ? 'true' : 'false'}
          onClick={() => toggleRow(model)}
        >
          <span className="dap-status" role="img" aria-label={status.title} title={status.title}>
            <StateDot state={status.state} size={10} />
          </span>
          <span className="dap-identity">
            <span className="dap-identityTop">
              <span className="dap-name" title={model.name}>{model.name}</span>
              {model.route === undefined ? <Tag tone="warning">{t('unservedTag')}</Tag> : null}
              {overrides.length === 0
                ? null
                : (
                  // 这一层只为挂 `title`：官方 `Tag` 除了 tone/className/children 什么都不透传，
                  // 想让人 hover 看出「覆盖的是哪几项」就得自己在外面套一层。
                  <span className="dap-tagWrap" title={overrideKeyNames(overrides)}>
                    <Tag tone="neutral">{t('overriddenCount', { count: overrides.length })}</Tag>
                  </span>
                )}
              {dirtyOf(model) ? <Tag tone="warning">{t('dirtyTag')}</Tag> : null}
            </span>
            <span className="dap-factRow">
              {factItems(model).map((item, index) => (
                <span className="dap-factItem" key={`${model.id}-fact-${String(index)}`}>{item}</span>
              ))}
            </span>
          </span>
          <span className="dap-chevron" data-open={open ? 'true' : 'false'}>
            <IconChevronRightOutlineRegular size={14} />
          </span>
        </button>
        {open ? editor(model) : null}
      </li>
    );
  };

  /**
   * 这一轮哪里不对：清单读不到、或者该写的东西没写进去。
   *
   * 「发现报告」那一块删掉之后，这些原本只写在报告事实表里的话得有地方落脚——否则清单挂了的时候，
   * 用户看到的就只是「还没有发现任何模型」，没有任何理由。刷新整个失败（`ok: false`）不在这里说：
   * 那句话由 `run()` 贴到提示语上，比这里更显眼。正常的一轮（同步关着 / 同步成功）什么都不说。
   */
  const roundProblem = (current: PanelReport | null): string | null => {
    const refresh = current === null ? undefined : current.refresh;
    if (refresh === undefined) return null;
    if (!refresh.catalog.available) {
      return t('catalogUnavailable', { reason: refresh.catalog.reason ?? '—' });
    }
    if (refresh.sync !== undefined && !refresh.sync.applied) {
      return t('syncSkipped', { reason: refresh.sync.reason ?? '—' });
    }
    return null;
  };

  const controlsDisabled = !state.available || !state.writable;
  const problem = roundProblem(report);

  return (
    <div data-dsh-aperture="">
      <SettingsForm
        labels={{
          unavailable: t('unavailable'),
          readOnly: t('readOnly'),
          saveFailed: t('saveFailed'),
          save: t('save'),
          saving: t('saving'),
        }}
        state={state}
        onSave={saveSettings}
        onDiscard={props.discard}
      >
        <SettingsValueField
          id="dap-base-url"
          label={t('addressLabel')}
          hint={t('addressHint')}
          placeholder={t('addressPlaceholder')}
          text={state.baseUrl.text}
          overridden={state.baseUrl.overridden}
          invalid={state.baseUrl.invalid}
          overriddenLabel={t('overridden')}
          resetLabel={t('resetField')}
          invalidLabel={t('invalidField')}
          disabled={controlsDisabled || state.saving}
          onEdit={(text) => props.edit('baseUrl', text)}
          onReset={() => props.resetField('baseUrl')}
        />
        <div className="dap-toggleRow">
          <div className="dap-toggleText">
            <span>{t('syncLabel')}</span>
            <span className="dap-hint">{t('syncHint')}</span>
          </div>
          <div className="dap-inline">
            {state.sync.overridden ? <Tag tone="info">{t('overridden')}</Tag> : null}
            {state.sync.overridden
              ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => props.resetField('sync')}
                  disabled={controlsDisabled || state.saving}
                >
                  {t('resetField')}
                </Button>
              )
              : null}
            <Switch
              checked={state.sync.text === 'true'}
              onChange={(next) => props.edit('sync', next ? 'true' : 'false')}
              label={t('syncLabel')}
              disabled={controlsDisabled || state.saving}
            />
          </div>
        </div>
      </SettingsForm>
      {banner === null
        ? null
        : (
          <p
            className="dap-banner"
            data-ok={banner.ok ? 'true' : 'false'}
            role="status"
            aria-live="polite"
          >
            {banner.text}
          </p>
        )}
      <section className="dap-group">
        <div className="dap-groupHead">
          <span className="dap-titleWrap">
            <h3 className="dap-groupTitle">{t('modelsTitle')}</h3>
            {report === null
              ? null
              : <span className="dap-count">{t('modelsCount', { count: report.models.length })}</span>}
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRefreshOutlineRegular size={14} />}
            onClick={refreshReport}
            disabled={busy !== ''}
            title={t('refreshHint')}
          >
            {busy === 'refresh' ? t('refreshing') : t('refresh')}
          </Button>
        </div>
        <p className="dap-hint">{t('modelsHint')}</p>
        {problem === null ? null : <p className="dap-warnNote">{problem}</p>}
        {report === null
          ? <p className="dap-hint">{t('loading')}</p>
          : report.models.length === 0
            // 没有实例地址时发现根本不会跑，这时说「还没发现到模型」等于没说——那句话要说清为什么。
            // 只在设置读得到的时候这么说：读不到时地址存不存在都不知道，那是另一件事（表单自己会说）。
            ? <p className="dap-empty">{state.available && state.baseUrl.text === '' ? t('dormantHint') : t('noModels')}</p>
            : (
              <ul className="dap-rows">
                {report.models.map(modelRow)}
              </ul>
            )}
      </section>
    </div>
  );
}
