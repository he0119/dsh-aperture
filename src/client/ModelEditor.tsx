/**
 * 展开之后那一行的覆盖编辑器：只写这一行。
 *
 * 它不持有 state：草稿与动作都是页面按这一行绑好之后递下来的 props（见 [ModelRow.tsx](./ModelRow.tsx)）。
 * 编辑器自己算的都是**这一帧的读数**——改了哪几项、哪一项读不出来、界面认不得的覆盖有哪些——它们
 * 全在草稿与报告里，重算一遍比记一份不会漂。
 *
 * 一行一个「保存」，不摆批量：一份草稿对应多行时「按了保存到底写了哪几行」没有答案。动作左边那句
 * 「有 N 项改动还没写下去」与行首那颗标签走的是同一个数（`pendingChanges`），按下去之前先知道这一按
 * 会不会真的写。
 *
 * @module dsh-aperture/client/ModelEditor
 */

import {
  Button,
  Checkbox,
  SegmentedControl,
  SettingsValueField,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { ReactNode } from 'react';
import type { PanelModel } from '../report.ts';
import type { FactSource } from '../types.ts';
import {
  EDITABLE_KEYS,
  capacityBad,
  declaredIn,
  overrideKeyNames,
  pendingChanges,
  type RowDraft,
  type TextFieldKey,
} from './draft.ts';
import { formatCapacity } from './format.ts';
import type { LocaleKey, PanelTranslate } from './locales.ts';

/** 事实来源 → 字典键；未知来源原样显示。 */
const SOURCE_KEYS: Readonly<Record<string, LocaleKey>> = {
  aperture: 'sourceAperture',
  'models.dev': 'sourceModelsDev',
  config: 'sourceConfig',
  default: 'sourceDefault',
};

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

/**
 * 编辑器的注入面：这一行的草稿，以及页面替它绑好的动作。
 *
 * `onStage` 只改草稿（函数式更新在页面那一边，同一个 tick 里连着改几项也不会互相覆盖），落笔全在
 * `onSave` 里——这一层不认识设置文档，也不直接碰端点。
 */
export interface ModelEditorProps {
  /** 报告里的这一行。 */
  model: PanelModel;
  /** 这一行此刻的草稿。 */
  draft: RowDraft;
  /** 正在跑的动作名；非空即禁用控件，`edit` 是这一行的保存正在飞。 */
  busy: string;
  /** 字典。 */
  t: PanelTranslate;
  /** 改这一行的几个字段。 */
  onStage: (changes: Partial<RowDraft>) => void;
  /** 取消：丢掉这一行的草稿、收起面板，什么都不写。 */
  onCancel: () => void;
  /** 写下这一行的改动。 */
  onSave: () => void;
  /** 撤销这一行的覆盖。 */
  onClear: () => void;
}

/**
 * 一行模型的覆盖编辑器。
 *
 * @param {object} props - 这一行的草稿、字典与几个动作。
 * @returns {object} 编辑器元素。
 */
export function ModelEditor(props: ModelEditorProps): ReactNode {
  const { model, draft, busy, t, onStage, onCancel, onSave, onClear } = props;
  const disabled = busy !== '';
  const overrides = model.overrideKeys ?? [];
  // 界面认不得的键（`reasoningEfforts` 之类）只有「清空覆盖」撤得掉，而那是整条删，得先说清楚。
  const unknown = overrides.filter((key) => !EDITABLE_KEYS.includes(key));
  /** 还没写下去的改动有几项；下面两处说的是同一件事。 */
  const pending = pendingChanges(model, draft);

  /** 来源那句：报告里的事实都有出处，界面按语言渲染它。 */
  const sourceOf = (fact: FactSource): string => t('factSource', {
    source: SOURCE_KEYS[fact] === undefined ? fact : t(SOURCE_KEYS[fact]),
  });

  /**
   * 一个文本类覆盖字段。
   *
   * 官方 `SettingsValueField` 的语义正好对得上：「已覆盖」= 用户层里有这个键（报告给的
   * `overrideKeys`），「恢复默认」= 把草稿改回「不覆盖」，非法草稿只标出来、由保存拦住。
   *
   * 长解释进 `help`（官方那个「i」按钮），输入框下面只留一句来源；外面再套一层格子，官方字段行
   * 那条「相邻就加上边框」在网格里会错开半格，隔开一层壳就不碰它了。
   */
  const textField = (key: TextFieldKey, copy: TextFieldCopy) => (
    <div className="dap-fieldCell">
      <SettingsValueField
        id={`dap-${model.id}-${key}`}
        label={t(copy.label)}
        help={{ label: t('fieldHelp', { field: t(copy.label) }), content: t(copy.hint) }}
        hint={sourceOf(copy.source(model))}
        {...(copy.placeholder === undefined ? {} : { placeholder: copy.placeholder(model) })}
        {...(copy.numeric === true ? { numeric: true } : {})}
        text={draft[key]}
        overridden={declaredIn(model, key)}
        // 只有容量那两项用 `1M`/`384K` 的词汇，因此也只有它们会「读不出来」；文本字段写什么都算数。
        invalid={copy.numeric === true && capacityBad(draft[key])}
        overriddenLabel={t('overridden')}
        resetLabel={t('resetField')}
        invalidLabel={t('invalidField')}
        disabled={disabled}
        onEdit={(text) => onStage({ [key]: text })}
        onReset={() => onStage({ [key]: copy.cleared })}
      />
    </div>
  );

  return (
    <div className="dap-editor">
      <div className="dap-editorHead">
        <span className="dap-editorId" title={model.id}>{model.id}</span>
        {unknown.length === 0
          ? null
          : (
            <span className="dap-warnNote">
              {t('editUnknownOverrides', { keys: overrideKeyNames(unknown, t) })}
            </span>
          )}
        {pending > 0
          ? <Tag tone="warning" className="dap-editorDirty">{t('dirtyTag')}</Tag>
          : null}
      </div>
      <div className="dap-editGroup">
        <span className="dap-editGroupTitle">{t('editGroupIdentity')}</span>
        <div className="dap-fields">
          {textField('name', {
            label: 'editName',
            hint: 'editNameHint',
            source: (item) => item.provenance.name,
            cleared: '',
          })}
          {textField('alias', {
            label: 'editAlias',
            hint: 'editAliasHint',
            source: () => 'config',
            cleared: '',
          })}
          {textField('api', {
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
          {textField('contextWindow', {
            label: 'editContextWindow',
            hint: 'editCapacityHint',
            source: (item) => item.provenance.limits,
            cleared: '',
            numeric: true,
            // 清空之后回落到的就是发现到的那个数，摆在占位符里最省事。
            placeholder: (item) => formatCapacity(item.contextWindow),
          })}
          {textField('maxTokens', {
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
              onChange={(next) => onStage({ text: next })}
              label={t('modalityText')}
              disabled={disabled}
            />
            <Checkbox
              checked={draft.image}
              onChange={(next) => onStage({ image: next })}
              label={t('modalityImage')}
              disabled={disabled}
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
            onChange={(next) => onStage({ reasoning: next })}
            disabled={disabled}
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
          {pending === 0 ? t('noPendingChanges') : t('pendingChanges', { count: pending })}
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={disabled}>
          {t('cancelRow')}
        </Button>
        {overrides.length === 0
          ? null
          : (
            <Button variant="outline" size="sm" onClick={onClear} disabled={disabled}>
              {t('clearOverrides')}
            </Button>
          )}
        <Button variant="primary" size="sm" onClick={onSave} disabled={disabled}>
          {busy === 'edit' ? t('saving') : t('saveRow')}
        </Button>
      </div>
    </div>
  );
}
