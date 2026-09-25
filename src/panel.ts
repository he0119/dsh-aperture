/**
 * 设置界面配置页的 Host 端。
 *
 * 配置页本身在浏览器里跑（`client/aperture.js`），这里只留下它读不到的那几样：最近一次刷新的
 * 报告、立刻刷新，以及单个模型参数的写入。地址与同步开关**不在这里**——那两项就在页主递来的
 * 设置表单快照里，配置页交给同一个 `form.mutate` 写，版本校验与冲突恢复都由设置接缝负责；
 * 同一个命名空间上挂两条写路径，只会让「谁在什么时候写」说不清。
 *
 * 留下的写入口是模型参数，因为它们零碎：容量、模态、推理、协议落在 `models` 的对应条目上，清单
 * 别名落在 `modelAliases[id]`，写入按字段合并——界面没提到的字段原样留着。合并与校验在这里做，
 * 因为写进设置文档的坏值会让下一轮刷新的 `resolveConfig` 直接抛异常。报告则不是配置：把发现的
 * 模型塞进设置文档会让「用户写了什么」与「插件发现了什么」混成同一份账。
 *
 * 端点都不抛异常：失败是界面要显示的结果之一，因此它是返回值里的字段。
 *
 * @module dsh-aperture/panel
 */

import type { SettingsDescriptor, SettingsForms, SettingsPathOp } from '@deepseek-ai/dsh-settings';
import { APERTURE_NAMESPACE, type ResolvedConfig } from './config.ts';
import { buildReport, type DeclaredOverrides, type PanelReport } from './report.ts';
import { message, type ApertureRuntime } from './runtime.ts';
import type { Modality } from './types.ts';

/**
 * 界面为单个模型写下的参数。
 *
 * 补丁是**稀疏**的：界面只发改动过的字段，没提到的原样留在设置文档里——因此界面完全不编辑的
 * `reasoningEfforts` 也不会被顺手抹掉。`null` 是「这条覆盖不要了」，即把字段从 `models` 的那
 * 一条里删掉，回落到发现值与清单。
 */
export interface PanelModelPatch {
  /** 显示名。 */
  readonly name?: string | null;
  /** 协议覆盖；也是让「未服务」的模型变得可服务的唯一方式。 */
  readonly api?: string | null;
  /** 上下文容量，以 token 计。 */
  readonly contextWindow?: number | null;
  /** 最大输出，以 token 计。 */
  readonly maxTokens?: number | null;
  /** 请求模态。 */
  readonly input?: readonly Modality[] | null;
  /** 强制打开（`true`）或关闭（`false`）推理。 */
  readonly thinking?: boolean | null;
  /** 清单别名（`aperture.modelAliases`）；空串或 `null` 表示不设。 */
  readonly alias?: string | null;
}

/** 一次动作的结果：成败与一句人话。 */
export interface PanelAction {
  /** 动作是否落地。 */
  readonly ok: boolean;
  /** 面向用户的说明。 */
  readonly summary: string;
}

/** 配置页可以调用的端点。 */
export interface PanelOps {
  /** 最近一次刷新做了什么；不触发任何工作。 */
  status(): PanelReport;
  /** 立刻重新发现并发布。 */
  refresh(): Promise<PanelAction>;
  /**
   * 写入一个模型的参数。
   *
   * 一次只动一个模型：界面上一行一个「保存」，版本校验也只管这一次写入。空串与 `null` 都表示
   * 「这一项不覆盖」。写完等一轮重新发现落地才返回：报告里的容量、模态、协议都是刷新算出来的
   * 事实，不等它就是「保存了却没变」。地址与同步开关不走这里，它们直接交给页主的设置表单。
   *
   * @param id - 模型 id（Aperture 接受的那个）。
   * @param patch - 要改的字段；`null` 表示撤销这个模型的全部覆盖（含别名）。
   */
  edit(id: string, patch: PanelModelPatch | null): Promise<PanelAction>;
}

/** 端点背后的东西。 */
export interface PanelDeps {
  /** 发现运行时，报告与刷新都来自它。 */
  readonly runtime: ApertureRuntime;
  /** 当前生效配置的活引用（thunk）。 */
  readonly config: () => ResolvedConfig;
  /** 设置服务：读 `aperture` 段的用户层，也写它。 */
  readonly settings: SettingsForms;
}

/** `aperture` 段的解析视图：生效值、用户层、以及写入要带上的版本号。 */
interface ApertureSection {
  readonly value: Record<string, unknown>;
  readonly user: Record<string, unknown>;
  readonly revision: number | undefined;
}

/** 把未知值当成一个普通对象；数组与 `null` 都不算。 */
function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** 一个值是不是「没写」：空串、空数组、空字典都算。 */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * 剔掉一条覆盖里的空值，只留 `id` 与真正写下的内容。
 *
 * 生效值里混着 schema 补出来的默认值（没写的数组字段会变成 `[]`）。原样写回用户层就成了用户
 * 从没写过的覆盖，界面上那颗「已覆盖」会一直挂着，按「恢复默认」又撤不掉。
 *
 * @param entry - 生效值里的一条。
 * @returns 可以写进用户层的那几条键。
 */
function prune(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key, value]) => key === 'id' || !isEmpty(value)));
}

/**
 * 用户层里写下的覆盖。
 *
 * 「有没有覆盖」只能从用户层读：生效值里分不出用户写下的值与 schema 补出来的默认值。
 *
 * @param settings - 设置服务。
 * @returns `aperture.models` 的原样条目，以及写过别名的模型 id。
 */
function declaredOverrides(settings: SettingsForms): DeclaredOverrides {
  const user = readSection(settings).user;
  return {
    models: (Array.isArray(user.models) ? user.models : []).map(asRecord),
    aliasIds: Object.keys(asRecord(user.modelAliases)),
  };
}

/**
 * 读 `aperture` 段。
 *
 * `value` 是叠加默认值、组合层与用户层后的生效值，`user` 是用户层的原始片段——字段在不在
 * `user` 里才是「有没有被覆盖」的判据，拿生效值去和组合层比会得出错误答案。
 *
 * @param settings - 设置服务。
 * @returns 解析视图；命名空间尚未注册或描述符读不到时给出空值。
 */
function readSection(settings: SettingsForms): ApertureSection {
  let descriptor: SettingsDescriptor | undefined;
  try {
    descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === APERTURE_NAMESPACE);
  } catch {
    // `describe()` 会为**每个** entry 跑一遍解析，所以某个不相干的 entry 自己坏掉也会让整次
    // 读取抛异常。页面宁可显示「未注册」也不要整块打不开——写入路径另有它自己的报错。
    descriptor = undefined;
  }
  return {
    value: asRecord(descriptor?.value),
    user: asRecord(descriptor?.user),
    revision: descriptor?.revision,
  };
}

/**
 * 把补丁合并进 `models` 里的一条覆盖。
 *
 * 只做**校验与合并**，不做任何写入：非法值在这里挡下来，因为写进设置文档的坏值会让下一轮刷新的
 * `resolveConfig` 直接抛异常，而界面只能给用户一份再也刷新不出来的报告。
 *
 * @param base - 现有条目；没有时只带 `id`。
 * @param patch - 界面发来的稀疏补丁。
 * @returns 合并后的条目（已经没有任何字段时为 `undefined`），或一个错误。
 */
function mergeEntry(
  base: Record<string, unknown>,
  patch: PanelModelPatch,
): { entry?: Record<string, unknown>; error?: string } {
  const entry: Record<string, unknown> = { ...base };

  if (patch.name !== undefined) {
    const name = patch.name === null ? '' : patch.name.trim();
    if (name.length === 0) delete entry.name;
    else entry.name = name;
  }

  if (patch.api !== undefined) {
    const api = patch.api === null ? '' : patch.api.trim();
    if (api.length === 0) delete entry.api;
    else if (api !== 'openai-completions' && api !== 'openai-responses' && api !== 'anthropic-messages') {
      return { error: `api "${api}" 无法服务；只能是 openai-completions、openai-responses 或 anthropic-messages` };
    } else entry.api = api;
  }

  for (const field of ['contextWindow', 'maxTokens'] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null) {
      delete entry[field];
      continue;
    }
    if (!Number.isInteger(value) || value < 1) {
      return { error: `${field} 必须是不小于 1 的整数` };
    }
    entry[field] = value;
  }

  if (patch.input !== undefined) {
    const input = patch.input === null ? [] : [...new Set(patch.input)];
    if (input.some((item) => item !== 'text' && item !== 'image')) {
      return { error: 'input 只能包含 text 或 image' };
    }
    if (input.length === 0) delete entry.input;
    else entry.input = input;
  }

  if (patch.thinking !== undefined) {
    if (patch.thinking === null) delete entry.thinking;
    else entry.thinking = patch.thinking;
  }

  return Object.keys(entry).some((key) => key !== 'id') ? { entry } : {};
}

/**
 * 组装端点。
 *
 * @param deps - 运行时、配置活引用与设置服务。
 * @returns 三个端点；`status` 是同步的，读一份已经算好的结果不该等待。
 */
export function createPanelOps(deps: PanelDeps): PanelOps {
  // 报告每次都按当前配置现组装：覆盖与别名本身是配置，改完必须立刻能在列表里看到。
  const report = (): PanelReport => buildReport(deps.runtime.last(), deps.config(), declaredOverrides(deps.settings));

  return {
    status: report,

    async refresh(): Promise<PanelAction> {
      // 刷新自己吞掉异常并把原因放进 outcome，因此这里只搬运它。
      const outcome = await deps.runtime.refresh('设置界面');
      return outcome.ok
        ? { ok: true, summary: '已重新发现并发布。' }
        : { ok: false, summary: `刷新没有成功：${outcome.error ?? '原因未知'}` };
    },

    async edit(id, patch): Promise<PanelAction> {
      const modelId = typeof id === 'string' ? id.trim() : '';
      if (modelId.length === 0) return { ok: false, summary: '缺少模型 id。' };
      // 补丁必须显式给出：`null` 是「撤销这个模型的全部覆盖」，缺失是调用方写错了。
      if (patch === undefined || (patch !== null && typeof patch !== 'object')) {
        return { ok: false, summary: '缺少要写入的参数。' };
      }

      const section = readSection(deps.settings);
      // `models` 是数组，而路径操作只能整段替换它，因此每次都算出完整的新数组再写回去。
      // 基础取自生效值（组合层若也写过 models，它在界面上本来就是看得见的那些条目），但空值要
      // 剔掉：schema 补出来的 `[]` 不该被写进用户层（见 `prune`）。
      const before = (Array.isArray(section.value.models) ? section.value.models : []).map((entry) => prune(asRecord(entry)));
      const aliases = asRecord(section.value.modelAliases);
      // 撤销别名只在**用户层确实有**这个键时才写：界面显示的是生效别名，它可能来自组合层或
      // 清单，而删一个不存在的键要么白写、要么被设置服务当成坏路径拒绝，两种都不该发生。
      const owned = asRecord(section.user.modelAliases);
      const index = before.findIndex((entry) => entry.id === modelId);
      const currentAlias = typeof aliases[modelId] === 'string' ? (aliases[modelId] as string) : '';
      let models = before;
      const nextAliases: Record<string, unknown> = { ...aliases };
      let revoked = false;

      if (patch === null) {
        // `null` 是「撤销这个模型的全部覆盖」：`models` 里那条与清单别名一起走。
        models = before.filter((_, at) => at !== index);
        if (currentAlias.length > 0) delete nextAliases[modelId];
        revoked = true;
      } else {
        const merged = mergeEntry(index === -1 ? { id: modelId } : before[index]!, patch);
        if (merged.error !== undefined) return { ok: false, summary: `"${modelId}"：${merged.error}` };
        // 就地替换而不是挪到末尾：一条覆盖的位置不该因为改了一个字段就变（界面上也一样，
        // 列表顺序来自路由与发现顺序，不来自用户改过哪一条）。
        if (index === -1) {
          if (merged.entry !== undefined) models = [...before, merged.entry];
        } else if (merged.entry === undefined) {
          models = before.filter((_, at) => at !== index);
        } else {
          models = before.map((entry, at) => (at === index ? merged.entry! : entry));
        }

        // 别名不进 `models`：它是「网关 id → 清单 id」的映射，与覆盖是两件事。
        const alias = patch.alias === undefined ? currentAlias : (patch.alias ?? '').trim();
        if (alias.length === 0) delete nextAliases[modelId];
        else nextAliases[modelId] = alias;
      }

      const ops: SettingsPathOp[] = [];
      if (JSON.stringify(models) !== JSON.stringify(before)) {
        ops.push({ op: 'set', path: ['models'], value: models });
      }
      // 别名逐键比对：改过的写、撤掉的删，没动过的连碰都不碰。
      for (const key of new Set([...Object.keys(aliases), ...Object.keys(nextAliases)])) {
        if (nextAliases[key] === aliases[key]) continue;
        if (nextAliases[key] !== undefined) {
          ops.push({ op: 'set', path: ['modelAliases', key], value: nextAliases[key] });
          continue;
        }
        // 生效值里没有它了，但界面上那只是「回落到清单」；只有用户层写过才需要删。
        if (Object.prototype.hasOwnProperty.call(owned, key)) {
          ops.push({ op: 'unset', path: ['modelAliases', key] });
        }
      }

      if (ops.length === 0) return { ok: true, summary: '没有要保存的改动。' };

      try {
        // 带着刚读到的版本号写入：期间别人改过就拒绝，而不是覆盖他的改动。
        await deps.settings.mutate(APERTURE_NAMESPACE, ops, section.revision);
        // 写完等这一轮刷新落地再回答：这一行的容量、模态、协议都是刷新算出来的事实，不等它，
        // 配置页重读报告时看到的还是旧值——「保存了却没变」就是这么来的。配置变更自己也会唤起
        // 同一轮刷新（Loader 的 `loader/volatile-update`），运行时的单飞判定按配置版本合并，
        // 因此这里通常并进那一轮，而不是另跑一轮。
        const outcome = await deps.runtime.refresh('配置变更');
        const saved = revoked
          ? `已撤销 "${modelId}" 的全部覆盖，回落到发现值与清单`
          : `已保存 "${modelId}" 的参数`;
        return {
          ok: true,
          summary: outcome.ok
            ? `${saved}，并按新配置重新发现。`
            : `${saved}，但重新发现没有成功：${outcome.error ?? '原因未知'}`,
        };
      } catch (error) {
        return { ok: false, summary: `保存失败：${message(error)}` };
      }
    },
  };
}
