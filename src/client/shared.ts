/**
 * 两个界面组件共用的那一层：报告端点的形状、设置表单投影的快照类型，以及几个纯函数。
 *
 * 配置页（[AperturePanel.tsx](./AperturePanel.tsx)）与模型清单
 * （[ApertureModels.tsx](./ApertureModels.tsx)）挂在两个不同的槽位上，但它们说的是同一件事：
 * 同一个报告端点、同一份设置表单。把这两样东西放在这里，两边拿到的就永远是同一个定义。
 *
 * @module dsh-aperture/client/shared
 */

import type {
  SettingsFieldState,
  SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { PanelAction, PanelModelPatch } from '../panel.ts';
import type { PanelReport } from '../report.ts';
import type { PanelTranslate } from './locales.ts';

/** 报告与两个写端点（走 `aperturePanel` Remote）。 */
export interface PanelFace {
  status(): Promise<PanelReport>;
  refresh(): Promise<PanelAction>;
  writeModel(id: string, patch: PanelModelPatch | null): Promise<PanelAction>;
}

/** 注入面里 `useApertureCard` 交给组件的快照：官方表单外壳加上这一页那两个字段。 */
export type ApertureCardSnapshot = SettingsFormShell & {
  baseUrl: SettingsFieldState;
  sync: SettingsFieldState;
};

/** 表单投影的选择器钩子。 */
export type ApertureCardHook = <T>(select: (snapshot: ApertureCardSnapshot) => T) => T;

/** 一个错误的人话形式。 */
export function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 这一轮哪里不对：清单读不到、或者这一轮没注册上。
 *
 * 这些话原本只写在报告事实表里；报告那一块删掉之后，清单挂了的时候用户看到的就只是「还没有发现
 * 任何模型」，没有任何理由。刷新整个失败（`ok: false`）不在这里说：那句话由 `run()` 贴到提示语
 * 上，比这里更显眼。两个组件都用它——它说的是整个插件的事，两处都该看得到。
 *
 * @param {object} current - 最近一次报告。
 * @param {Function} t - 字典。
 * @returns {string|null} 要说的话，没问题时为 `null`。
 */
export function roundProblem(current: PanelReport | null, t: PanelTranslate): string | null {
  const refresh = current === null ? undefined : current.refresh;
  if (refresh === undefined) return null;
  if (!refresh.catalog.available) {
    return t('catalogUnavailable', { reason: refresh.catalog.reason ?? '—' });
  }
  if (refresh.publish?.reason !== undefined) {
    return t('registerSkipped', { reason: refresh.publish.reason });
  }
  return null;
}
