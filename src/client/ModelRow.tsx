/**
 * 一行模型：折起来是身份与状态，展开是这一行的覆盖编辑器。
 *
 * 这一份只画、不记：草稿与展开状态都长在页面上，按 props 递下来，动作也由页面绑好这一行的 id 再
 * 递下来。它们确实不是这一行自己的东西——收起一行不丢草稿（收起来不等于放弃，标签会一直挂着），
 * 写完一行页面要顺手把它收起来，两行还各改各的——因此行与编辑器都不持有 state，状态只有页面那一份。
 *
 * 行首那条按钮盖满整行（官方 `DisclosureRow` 是一根 24px 高、`overflow:hidden` 的横条，标题又
 * 不许收缩，名字一长就把右边的事实和标签挤没了）。这里名字自己一行、过长省略，事实另起一行随
 * 宽度换行，标签跟在名字后面。行本身（`li` 与那圈卡片描边）由列表那一层画，key 也在那儿。
 *
 * @module dsh-aperture/client/ModelRow
 */

import {
  IconChevronRightOutlineRegular,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ReactNode } from 'react';
import type { PanelModel } from '../report.ts';
import { overrideKeyNames, pendingChanges, type RowDraft } from './draft.ts';
import { formatCount } from './format.ts';
import type { PanelTranslate } from './locales.ts';
import { ModelEditor } from './ModelEditor.tsx';

/** 一行要的状态与动作：草稿与展开状态由页面持有，这里只按它们画。 */
export interface ModelRowProps {
  /** 报告里的这一行。 */
  model: PanelModel;
  /** 这一行此刻的草稿（没改过就是生效值本身）。 */
  draft: RowDraft;
  /** 展开没有。 */
  open: boolean;
  /** 正在跑的动作名；非空即禁用这一行的控件。 */
  busy: string;
  /** 最近一轮写入过的路由名；`undefined` 是「这一轮没同步」，不是「没写」。 */
  writtenRoutes: readonly string[] | undefined;
  /** 字典。 */
  t: PanelTranslate;
  /** 展开或收起这一行。 */
  onToggle: () => void;
  /** 改这一行的几个字段。 */
  onStage: (changes: Partial<RowDraft>) => void;
  /** 取消这一行的编辑。 */
  onCancel: () => void;
  /** 写下这一行的改动。 */
  onSave: () => void;
  /** 撤销这一行的覆盖。 */
  onClear: () => void;
}

/**
 * 这一行的状态点：绿是写进去了、灰是没写进去、黄是根本没有路由能服务它。
 *
 * 点旁边那句 `title` 就是它的说法——官方 `StateDot` 自己是 `aria-hidden`，说给谁听得由这里给。
 * 同步那一轮没跑（`writtenRoutes` 缺失）时不装作「没写进去」：报告里根本没有这一项。
 *
 * @param {object} model - 报告里的这一行。
 * @param {readonly string[]|undefined} writtenRoutes - 最近一轮写进路由的名字。
 * @param {Function} t - 字典。
 * @returns {object} 点的状态与它的说法。
 */
function publishState(
  model: PanelModel,
  writtenRoutes: readonly string[] | undefined,
  t: PanelTranslate,
): { state: StateDotState; title: string } {
  if (model.route === undefined) return { state: 'warning', title: t('statusUnserved') };
  if (writtenRoutes === undefined) return { state: 'idle', title: t('statusUnknown') };
  return writtenRoutes.includes(model.route)
    ? { state: 'done', title: t('statusPublished') }
    : { state: 'idle', title: t('statusNotPublished') };
}

/**
 * 一行模型那几项生效的事实，一项一句；缺哪项就不提哪项。
 *
 * @param {object} model - 报告里的这一行。
 * @param {Function} t - 字典。
 * @returns {string[]} 事实。
 */
function factItems(model: PanelModel, t: PanelTranslate): string[] {
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
}

/**
 * 一行模型：折起来的身份，加展开之后那个编辑器。
 *
 * @param {object} props - 这一行的草稿、展开状态、字典与几个动作。
 * @returns {object} 这一行的内容（`li` 由列表那一层画）。
 */
export function ModelRow(props: ModelRowProps): ReactNode {
  const { model, draft, open, busy, writtenRoutes, t, onToggle, onStage, onCancel, onSave, onClear } = props;
  const overrides = model.overrideKeys ?? [];
  const status = publishState(model, writtenRoutes, t);
  return (
    <>
      <button
        type="button"
        className="dap-cardHead"
        aria-expanded={open ? 'true' : 'false'}
        onClick={onToggle}
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
                <span className="dap-tagWrap" title={overrideKeyNames(overrides, t)}>
                  <Tag tone="neutral">{t('overriddenCount', { count: overrides.length })}</Tag>
                </span>
              )}
            {pendingChanges(model, draft) > 0 ? <Tag tone="warning">{t('dirtyTag')}</Tag> : null}
          </span>
          <span className="dap-factRow">
            {factItems(model, t).map((item, index) => (
              <span className="dap-factItem" key={`${model.id}-fact-${String(index)}`}>{item}</span>
            ))}
          </span>
        </span>
        <span className="dap-chevron" data-open={open ? 'true' : 'false'}>
          <IconChevronRightOutlineRegular size={14} />
        </span>
      </button>
      {open
        ? (
          <ModelEditor
            model={model}
            draft={draft}
            busy={busy}
            t={t}
            onStage={onStage}
            onCancel={onCancel}
            onSave={onSave}
            onClear={onClear}
          />
        )
        : null}
    </>
  );
}
