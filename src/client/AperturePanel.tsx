/**
 * 配置页：插件列表里本插件那个包页上的设置页——实例地址、注册开关，以及这一轮哪里不对。
 *
 * **模型的清单与逐模型覆盖不在这一页**：它们在官方「模型」页的页脚扩展位
 * （`settings.models.footer`）上，见 [ApertureModels.tsx](./ApertureModels.tsx)。模型本来就列在
 * 那一页里（provider 目录那几行就是本插件的路由），在模型旁边改模型比「先去插件页、再回来找模型」
 * 少一次往返；这一页只留「去哪儿发现」这一件事。
 *
 * 页面只交内容，控件用官方原语，**没有卡片**——标题与面包屑由页主画。表单状态读注入面里的
 * `useApertureCard`（官方 `SettingsFormModel` 的投影）；报告只是为了那一句「这一轮哪里不对」而读的
 * （清单读不到、路由没注册上），因此这里不摊开任何模型事实。
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
  SettingsForm,
  SettingsValueField,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { SettingsFormActions } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PanelReport } from '../report.ts';
import { interpolate, zhDict, type PanelTranslate } from './locales.ts';
import {
  roundProblem,
  textOf,
  type ApertureCardHook,
  type PanelFace,
} from './shared.ts';

/** 顶栏那条提示。 */
interface Notice {
  ok: boolean;
  text: string;
}

/**
 * 配置页组件拿到的注入面：注册时 `inject` 返回什么，这里就要求什么；渲染器另外把
 * `locale: NS` 绑成 `t`、把 `hooks.apertureCard` 变成 `useApertureCard` 选择器钩子。
 */
export interface AperturePanelProps {
  /** 字典（注册时声明了 `locale: NS`）；没有时用内置中文兜底（测试与首次渲染）。 */
  t?: PanelTranslate;
  /** 表单投影的选择器钩子。 */
  useApertureCard: ApertureCardHook;
  /** 报告与两个写端点（这一页只用报告与「立刻刷新」那一份）。 */
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
 * 配置页：实例地址与注册开关。
 *
 * 报告仍然要读：模型的清单在另一页上，但「这一轮哪里不对」得在这一页上说——地址填完按保存之后，
 * 用户唯一会盯着看的就是这里。
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
   * 跑一个动作：期间禁用控件，结束后把结果贴出来。
   *
   * @param {string} key - 正在跑的动作名（用来禁用控件与换按钮文案）。
   * @param {Function} action - 要跑的动作。
   */
  const run = (key: string, action: () => Promise<{ ok: boolean; summary: string }>): void => {
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
      }
    })();
  };

  /**
   * 保存设置里那两个字段，然后等一轮重新发现落地再说话。
   *
   * 写入走官方表单模型的 `save()`：它自带 `revision` 围栏（期间别处改过就拒绝，而不是覆盖别人的
   * 改动）并从宿主接受的那份重新播种，因此写完不重读设置——投影会自己变新。报告里的模型事实
   * 来自最近一次刷新，写完必须等一轮，否则就是「保存了却没变」。设置变更自己也会唤起同一轮刷新
   * （单飞判定按配置版本合并），因此这里通常并进那一轮。
   */
  const saveSettings = () => run('save', async () => {
    await props.save();
    if (props.failed()) return { ok: false, summary: t('configRefused') };
    const round = await props.panel.refresh();
    // 写入成功了，但重新发现可能失败——两件事不能混成一句话说，因此后半句照抄那一轮的说法。
    return { ok: round.ok, summary: t('savedResult', { result: round.summary }) };
  });

  const controlsDisabled = !state.available || !state.writable;
  const problem = roundProblem(report, t);

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
      {problem === null ? null : <p className="dap-warnNote">{problem}</p>}
      <p className="dap-hint">{t('modelsElsewhere')}</p>
    </div>
  );
}
