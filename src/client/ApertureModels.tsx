/**
 * 模型清单与逐模型编辑器：挂在官方「模型」页的两个扩展位上，本插件的配置页只留实例地址与注册开关。
 *
 * 两个座位分工（页主自己的 README 叫 Extension slots，0.1.7-rc.1 与 0.2.0-rc.2 两版逐字相同）：
 *
 * - `settings.models.provider-card`：**本插件每一条路由的那张卡里**——座位按 `settingsNs` 派发，
 *   因此本插件注册的每一行都会得到这一块；组件从递进来的目录行认出自己管哪一条路由，只画那一条
 *   路由的模型。这是主入口：模型就列在它所属的那一行下面。
 * - `settings.models.footer`：提供商列表之后。它只接卡片接不住的那些——没有路由可服务的模型（例
 *   如配置里手写的、清单里没有的），以及一条路由都没注册时（`sync` 关着、或这一轮什么都没注册成）
 *   的全部模型。没有它，这些模型在界面上就再也没有入口。
 *
 * 不放在本插件的配置页里：模型本来就在那一页上列着（provider 目录那几行就是本插件的路由），在模型
 * 旁边编辑模型比「先去插件页、再回来选模型」少一次往返。
 *
 * 页面只交内容，控件用官方原语，**没有卡片**。报告、提示语与每行的草稿、展开状态是这一块的局部
 * 状态；动作在这里按行绑好，然后整份递给只画不记的 [ModelRow.tsx](./ModelRow.tsx)（展开之后是
 * [ModelEditor.tsx](./ModelEditor.tsx)）。草稿与补丁的换算——哪一项改过、该发什么出去——在
 * [draft.ts](./draft.ts) 里，行与编辑器问的是同一个答案。
 *
 * **这一块默认收着**（官方 `DisclosureRow`，一行 24px 的折叠头 + 折叠内容）：卡片座位在官方
 * 「模型」页里是**每一行都渲染**的（页主的派发不带「这一行展开了吗」这个事实），摊开一次是十几
 * 行的清单，收着才不喧宾夺主——标题与模型数目在折叠头上仍然一眼能看到。页主自己的编辑器（点
 * 「编辑」才出现的那一块）与这一块互不影响。
 *
 * **effect 的依赖里刻意不放注入面**：`inject` 面由渲染器每次渲染重新组装，把它的身份放进依赖会
 * 让 effect 每渲染一次就重跑一次。因此报告用一个自增计数器当重读信号（依赖里只有那个数），注入
 * 面里的函数只在事件处理里调用，拿到的永远是当轮的那份。
 *
 * @module dsh-aperture/client/ApertureModels
 */

import * as React from 'react';
import {
  Button,
  DisclosureRow,
  IconFlatListOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { PanelAction } from '../panel.ts';
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
 * 模型清单组件拿到的注入面：注册时 `inject` 返回什么，这里就要求什么；渲染器另外把
 * `locale: NS` 绑成 `t`。
 */
export interface ApertureModelsProps {
  /** 字典（注册时声明了 `locale: NS`）；没有时用内置中文兜底（测试与首次渲染）。 */
  t?: PanelTranslate;
  /** 报告与两个写端点。 */
  panel: PanelFace;
  /**
   * 设置表单投影的选择器钩子。
   *
   * 这一块只问它一件事：此刻有没有实例地址。报告本身分不出「还没填地址所以没跑过发现」与
   * 「跑了但一个模型都没有」，而这两句话对用户是两回事。
   */
  useApertureCard: ApertureCardHook;
  /**
   * 卡片座位递来的那一行目录（路由 id 在里面）；页脚座位没有这一项。
   *
   * 类型写成结构里的一小块，而不是官方 `ProviderDirectoryEntry` 整份：这一块只用得上路由 id，
   * 官方以后往那一份里加字段不该牵动这里。
   */
  provider?: { readonly provider: string };
}

/** 这一块该画哪些模型：某一条路由的，还是卡片接不住的那些。 */
type ModelsScope = 'route' | 'unserved' | 'all';

// -------------------------------------------------------------- 模型清单

/**
 * 模型清单与逐模型覆盖：一行一个模型，展开改这一行的覆盖。
 *
 * @param {object} props - 注入面：`panel`（报告、立刻刷新、按行写入）与 `t`（字典，注册时声明了
 *   `locale`）。
 * @returns {object} 这一块元素。
 */
export function ApertureModels(props: ApertureModelsProps) {
  const t: PanelTranslate = typeof props.t === 'function'
    ? props.t
    : (key, params) => interpolate(zhDict[key] ?? key, params);

  const [open, setOpen] = React.useState(false);
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
   * 一行一个保存按钮，写下去的就只有这一行，Host 端的版本校验也只管这一次写入。成功后收起面板
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

  /**
   * 这一块画哪些模型。
   *
   * 卡片座位上只画**这一条路由**的模型；页脚座位接卡片接不住的：一条路由都没注册时它管全部（否则
   * 那些模型在界面上没有入口），否则只管没有路由可服务的那些。
   */
  const cardRoute = props.provider?.provider;
  const scope: ModelsScope = cardRoute !== undefined
    ? 'route'
    : (report?.routes ?? []).length === 0
      ? 'all'
      : 'unserved';
  const models = (report?.models ?? []).filter((model) => {
    if (scope === 'route') return model.route === cardRoute;
    if (scope === 'all') return true;
    return model.route === undefined;
  });
  /** 页脚座位没东西可说时整块不画：它不该在别人的页上留一块空地。 */
  const silent = cardRoute === undefined && scope === 'unserved' && models.length === 0;

  // 只取「地址空着吗」这一项：没有地址时发现根本不会跑，这时说「还没发现到模型」等于没说。
  const dormant = props.useApertureCard(
    (snapshot) => snapshot.available && snapshot.baseUrl.text === '',
  );
  const problem = roundProblem(report, t);
  if (silent && problem === null) return null;

  const title = scope === 'route'
    ? t('modelsTitleRoute')
    : scope === 'all' ? t('modelsTitle') : t('modelsTitleUnserved');

  return (
    <div data-dsh-aperture="">
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
      <DisclosureRow
        className="dap-group"
        icon={<IconFlatListOutlineRegular size={14} />}
        title={title}
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setOpen((value) => !value)}
        collapsedContent={report === null
          ? null
          : <span className="dap-count">{t('modelsCount', { count: models.length })}</span>}
      >
        <div className="dap-modelsBody">
          <div className="dap-modelsHead">
            <p className="dap-hint">{t('modelsHint')}</p>
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
          {scope === 'route' ? null : <p className="dap-hint">{t('modelsOrphanHint')}</p>}
          {report === null
            ? <p className="dap-hint">{t('loading')}</p>
            : models.length === 0
              ? <p className="dap-empty">{dormant ? t('dormantHint') : t('noModels')}</p>
              : (
                <ul className="dap-rows">
                  {models.map((model) => (
                    <li className="dap-card" key={model.id}>
                      <ModelRow
                        model={model}
                        draft={draftOf(model)}
                        open={opened[model.id] === true}
                        busy={busy}
                        registeredRoutes={report === null ? undefined : report.refresh?.publish?.routes}
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
        </div>
      </DisclosureRow>
      {problem === null ? null : <p className="dap-warnNote">{problem}</p>}
    </div>
  );
}
