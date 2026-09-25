/**
 * 配置页：插件列表里本插件那个包页上的设置页（实例地址、同步开关，以及逐模型的覆盖）。
 *
 * 页面只交内容，控件用官方原语，**没有卡片**——标题与面包屑由页主画。表单状态读注入面里的
 * `useApertureCard`（官方 `SettingsFormModel` 的投影），报告、提示语与每行的草稿、展开状态是这一页
 * 的局部状态；报告里的事实（`panel.status` 那一份结构化数据）只是不再整块摊开给用户看。
 *
 * 这一层是唯一持有状态的地方：草稿与展开按模型 id 记成两张表，动作在这里按行绑好，然后整份递给
 * 只画不记的 [ModelRow.tsx](./ModelRow.tsx)（展开之后是 [ModelEditor.tsx](./ModelEditor.tsx)）。
 * 草稿与补丁的换算——哪一项改过、该发什么出去——在 [draft.ts](./draft.ts) 里，行与编辑器问的是
 * 同一个答案。
 *
 * **effect 的依赖里刻意不放注入面**：`inject` 面由渲染器每次渲染重新组装，把它的身份放进依赖会
 * 让 effect 每渲染一次就重跑一次。因此报告用一个自增计数器当重读信号（依赖里只有那个数），注入
 * 面里的函数只在事件处理里调用，拿到的永远是当轮的那份。
 *
 * @module dsh-aperture/client/AperturePanel
 */

import * as React from 'react';
import {
  Button,
  IconRefreshOutlineRegular,
  SettingsForm,
  SettingsValueField,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  SettingsFieldState,
  SettingsFormActions,
  SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { PanelAction, PanelModelPatch } from '../panel.ts';
import type { PanelModel, PanelReport } from '../report.ts';
import {
  EDITABLE_KEYS,
  initialOf,
  patchOf,
  type RowDraft,
  type RowDrafts,
  type RowOpened,
} from './draft.ts';
import { interpolate, zhDict, type PanelTranslate } from './locales.ts';
import { ModelRow } from './ModelRow.tsx';

/** 一个错误的人话形式。 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 顶栏那条提示。 */
interface Notice {
  ok: boolean;
  text: string;
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
  t?: PanelTranslate;
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

// ------------------------------------------------------------------ 页面

/**
 * 配置页：实例（地址、同步开关）与模型清单。
 *
 * 报告本身（`panel.status` 那一份结构化数据）仍然要读：每一行的事实、覆盖与状态点都长在它上面，
 * 只是不再整块摊开给用户看。
 *
 * @param {object} props - 注入面：`useApertureCard`、`panel`（报告端点）、`save` / `edit` /
 *   `resetField` / `discard` / `failed`（设置表单）与 `t`（字典，注册时声明了 `locale`）。
 * @returns {object} 页面元素。
 */
export function AperturePanel(props: AperturePanelProps) {
  const t: PanelTranslate = typeof props.t === 'function'
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

  /**
   * 跑一个动作：期间禁用控件，结束后把结果贴出来并按需收尾。
   *
   * `after` 会拿到动作是否成功；调用方若要丢草稿、收起编辑器，必须只在 `true` 时做。刷新报告这类
   * 无论结果如何都要做的收尾可以忽略这个参数。
   */
  const run = (
    key: string,
    action: () => Promise<PanelAction>,
    after?: (ok: boolean) => void,
  ): void => {
    setBusy(key);
    setBanner(null);
    void (async () => {
      let ok = false;
      try {
        const result = await action();
        ok = result.ok;
        setBanner({ ok: result.ok, text: result.summary });
      } catch (error) {
        setBanner({ ok: false, text: textOf(error) });
      } finally {
        setBusy('');
        if (after !== undefined) after(ok);
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
      setBanner({
        ok: false,
        text: t('invalidNumber', { field: bad.map((key) => t(key)).join(t('listSeparator')) }),
      });
      return;
    }
    if (Object.keys(patch).length === 0) {
      setBanner({ ok: true, text: t('noChanges') });
      return;
    }
    run(`edit:${model.id}`, () => props.panel.writeModel(model.id, patch), (ok) => {
      if (!ok) return;
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
    run(`revert:${model.id}`, () => props.panel.writeModel(model.id, payload), (ok) => {
      if (!ok) return;
      dropDraft(model.id);
      setOpened((current) => ({ ...current, [model.id]: false }));
      setRevision((value) => value + 1);
    });
  };

  const refreshReport = () => run('refresh', () => props.panel.refresh(), () => setRevision((value) => value + 1));

  /** 最近一轮写入过的路由名；`undefined` 是「这一轮没同步」，不是「没写」——同步关着的时候报告里
   * 根本没有这一项，界面不能把「不知道」说成「没写」。
   */
  const writtenRoutes = report === null || report.refresh === undefined || report.refresh.sync === undefined
    ? undefined
    : report.refresh.sync.routes;

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
                {report.models.map((model) => (
                  <li className="dap-card" key={model.id}>
                    <ModelRow
                      model={model}
                      draft={draftOf(model)}
                      open={opened[model.id] === true}
                      busy={busy}
                      writtenRoutes={writtenRoutes}
                      t={t}
                      onToggle={() => toggleRow(model)}
                      onStage={(changes) => stage(model, changes)}
                      onCancel={() => cancelRow(model)}
                      onSave={() => submitRow(model)}
                      onClear={() => clearOverrides(model)}
                    />
                  </li>
                ))}
              </ul>
            )}
      </section>
    </div>
  );
}
