/**
 * 设置界面标签页的宿主半边。
 *
 * 标签页本身在浏览器里跑（`client/aperture.js`），它能读到的只有这里暴露的端点——与参考
 * 实现（`@xiaoyuyu6420/dsh-backup` 的 `backupPanel`）同一种做法：界面不直接碰宿主存储，
 * 所有读写都经自己的 Remote 命名空间往返，因此客户端半边不必注入设置传输，也不必知道设置
 * 文档长什么样。
 *
 * 写入仍然是配置，所以它落在 `aperture` 命名空间的用户层：地址与同步开关用路径操作写，
 * 「撤销」是把字段从用户层移除、回落到组合层与默认值。单个模型的参数也走这里，只是它们更
 * 零碎——容量、模态、推理、协议落在 `models` 的对应条目上，清单别名落在 `modelAliases[id]`，
 * 而写入是按字段合并的：界面没提到的字段原样留着（`reasoningEfforts` 界面根本不编辑，也不该
 * 被顺手抹掉）。报告与两个动作则不是配置——把发现的模型塞进设置文档会让「用户写了什么」与
 * 「插件发现了什么」混成同一份账，而后者每轮刷新都会被重写。
 *
 * 端点都不抛异常：失败是界面要显示的结果之一，因此它是返回值里的字段，而不是需要标签页
 * 去分辨的 rejected promise。
 *
 * @module dsh-aperture/panel
 */

import type { SettingsPathOp, SettingsProvider } from '@deepseek-ai/dsh-settings';
import type { ResolvedConfig } from './config.ts';
import { APERTURE_NAMESPACE, PI_AI_NAMESPACE } from './namespaces.ts';
import { buildReport, type PanelReport } from './report.ts';
import { message, type ApertureRuntime } from './runtime.ts';
import { clearRoutes } from './sync.ts';
import type { Modality } from './types.ts';

/**
 * 界面为单个模型写下的参数。
 *
 * 补丁是**稀疏**的：界面只发它改动过的字段，没提到的字段原样留在设置文档里——因此界面
 * 完全不编辑的字段（`reasoningEfforts`）也不会被它顺手抹掉。`null` 是「这条覆盖不要了」，
 * 也就是把字段从 `models` 的那一条里删掉，回落到发现值与清单。
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

/** 标签页表单要显示的东西。 */
export interface PanelConfiguration {
  /** 生效的实例地址（schema 默认值 → 组合层 → 用户层）。 */
  readonly baseUrl: string;
  /** 生效的同步开关。 */
  readonly sync: boolean;
  /** `baseUrl` 在用户层里有条目，也就是被覆盖了。 */
  readonly baseUrlOverridden: boolean;
  /** `sync` 在用户层里有条目。 */
  readonly syncOverridden: boolean;
  /** 设置文档是否接受写入；为假时表单只读。 */
  readonly writable: boolean;
}

/** 端点背后的东西。 */
export interface PanelDeps {
  /** 发现运行时，报告与刷新都来自它。 */
  readonly runtime: ApertureRuntime;
  /** 当前生效配置的活引用（thunk）。 */
  readonly config: () => ResolvedConfig;
  /** 设置服务：读 `aperture` 段的用户层，也写它。 */
  readonly settings: SettingsProvider;
}

/** 标签页可以调用的端点。 */
export interface PanelOps {
  /** 最近一次刷新做了什么；不触发任何工作。 */
  status(): PanelReport;
  /** 立刻重新发现并发布。 */
  refresh(): Promise<PanelAction>;
  /** 把本插件拥有的路由从 `llm-pi-ai` 段撤下来。 */
  withdraw(): Promise<PanelAction>;
  /** 表单要显示的配置与「是否被覆盖」。 */
  configuration(): PanelConfiguration;
  /**
   * 写入配置。
   *
   * @param baseUrl - 新地址；`null` 表示撤销覆盖（从用户层移除），`undefined` 表示不碰。
   * @param sync - 新开关；`undefined` 表示不碰。
   */
  save(baseUrl: string | null | undefined, sync: boolean | undefined): Promise<PanelAction>;
  /**
   * 写入一个模型的参数。
   *
   * 一次只动一个模型：界面上一行一个「保存」，写下去的就只有那一行，版本校验也只管这一次
   * 写入。没提到的字段原样留在设置文档里（界面根本不编辑的 `reasoningEfforts` 就不会被顺手
   * 抹掉），空串与 `null` 都表示「这一项不覆盖」。
   *
   * @param id - 模型 id（Aperture 接受的那个）。
   * @param patch - 要改的字段；`null` 表示撤销这个模型的全部覆盖（含别名）。
   */
  edit(id: string, patch: PanelModelPatch | null): Promise<PanelAction>;
}

/** `aperture` 段的解析视图：生效值、用户层、以及写入要带上的版本号。 */
interface ApertureSection {
  readonly value: Record<string, unknown>;
  readonly user: Record<string, unknown>;
  readonly revision: number | undefined;
  readonly writable: boolean;
}

/** 把未知值当成一个普通对象；数组与 `null` 都不算。 */
function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * 读 `aperture` 段。
 *
 * `value` 是叠加了默认值、组合层与用户层之后的生效值，`user` 是用户层的原始片段——
 * 字段在不在 `user` 里，才是「有没有被覆盖」的判据；拿生效值去和组合层比会得出错误答案。
 *
 * @param settings - 设置服务。
 * @returns 解析视图；命名空间尚未注册或描述符读不到时给出空值。
 */
function readSection(settings: SettingsProvider): ApertureSection {
  const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === APERTURE_NAMESPACE);
  return {
    value: asRecord(descriptor?.value),
    user: asRecord(descriptor?.user),
    revision: descriptor?.revision,
    writable: settings.writable !== false,
  };
}

/**
 * 把补丁合并进 `models` 里的一条覆盖。
 *
 * 只做**校验与合并**，不做任何写入：非法值在这里被挡下来，因为写进设置文档的坏值会让下一轮
 * 刷新的 `resolveConfig` 直接抛异常——那时用户已经在别处改坏了配置，而界面只能给他一份再也
 * 刷新不出来的报告。
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
    else if (api !== 'openai-completions' && api !== 'anthropic-messages') {
      return { error: `api "${api}" 无法服务；只能是 openai-completions 或 anthropic-messages` };
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

/** 一个字段在用户层里有没有条目。 */
function overridden(user: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(user, field);
}

/**
 * 组装端点。
 *
 * @param deps - 运行时、配置活引用与设置服务。
 * @returns 五个端点；`status` 与 `configuration` 是同步的，读一份已经算好的结果不该等待。
 */
export function createPanelOps(deps: PanelDeps): PanelOps {
  // 报告每次都按当前配置现组装：覆盖与别名本身是配置，改完必须立刻能在列表里看到。
  const report = (): PanelReport => buildReport(deps.runtime.last(), deps.config());

  return {
    status: report,

    async refresh(): Promise<PanelAction> {
      // 刷新自己吞掉异常并把原因放进 outcome，因此这里只搬运它。
      const outcome = await deps.runtime.refresh('设置界面');
      return outcome.ok
        ? { ok: true, summary: '已重新发现并发布。' }
        : { ok: false, summary: `刷新没有成功：${outcome.error ?? '原因未知'}` };
    },

    async withdraw(): Promise<PanelAction> {
      const owned = [deps.config().route, deps.config().anthropicRoute];
      try {
        const outcome = await clearRoutes(deps.settings, owned);
        // 「已经没有了」与「刚撤下来」都是想要的状态，因此都算成功。
        return outcome.applied
          ? {
            ok: true,
            summary: `已从 "${PI_AI_NAMESPACE}" 撤下 ${outcome.ops} 条路由：${owned.join('、')}。`
              + '下一次刷新会按当前配置重新发布；要让撤下长期生效，请关掉同步开关。',
          }
          : { ok: true, summary: `没有需要撤下的路由：${outcome.reason ?? '原因未知'}` };
      } catch (error) {
        return { ok: false, summary: `撤下路由失败：${message(error)}` };
      }
    },

    configuration(): PanelConfiguration {
      const section = readSection(deps.settings);
      const config = deps.config();
      return {
        // 表单显示的是用户写的那个值（`rawBaseUrl`），不是归一化后的 `instanceRoot`：
        // 把归一化结果回填进输入框，会让人以为自己写的地址被悄悄改掉了。
        baseUrl: typeof section.value.baseUrl === 'string' ? section.value.baseUrl : config.rawBaseUrl,
        sync: typeof section.value.sync === 'boolean' ? section.value.sync : config.sync,
        baseUrlOverridden: overridden(section.user, 'baseUrl'),
        syncOverridden: overridden(section.user, 'sync'),
        writable: section.writable,
      };
    },

    async save(baseUrl, sync): Promise<PanelAction> {
      const ops: SettingsPathOp[] = [];
      if (baseUrl === null) ops.push({ op: 'unset', path: ['baseUrl'] });
      else if (baseUrl !== undefined) ops.push({ op: 'set', path: ['baseUrl'], value: baseUrl.trim() });
      if (sync !== undefined) ops.push({ op: 'set', path: ['sync'], value: sync });
      if (ops.length === 0) return { ok: true, summary: '没有要保存的改动。' };

      // 撤销覆盖是唯一一种「只移除、不写入」的保存，值得单独说一句。
      const withdrawOnly = ops.every((op) => op.op === 'unset');
      try {
        // 带着刚读到的版本号写入：期间有别人改过就拒绝，而不是覆盖他的改动。
        await deps.settings.mutate(APERTURE_NAMESPACE, ops, readSection(deps.settings).revision);
        return {
          ok: true,
          summary: withdrawOnly
            ? '已撤销覆盖，回落到组合层与默认值。'
            : '已写入设置；插件会按新配置重新发现。',
        };
      } catch (error) {
        return { ok: false, summary: `保存失败：${message(error)}` };
      }
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
      // 基础取自生效值：组合层若也写过 models，它在界面上本来就是看得见的那些条目。
      const before = (Array.isArray(section.value.models) ? section.value.models : []).map(asRecord);
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

      const summary = revoked
        ? `已撤销 "${modelId}" 的全部覆盖，回落到发现值与清单；插件会按新配置重新发现。`
        : `已保存 "${modelId}" 的参数；插件会按新配置重新发现。`;

      try {
        // 与 `save` 同一条路径：带着刚读到的版本号写入，期间别人改过就拒绝。
        await deps.settings.mutate(APERTURE_NAMESPACE, ops, section.revision);
        return { ok: true, summary };
      } catch (error) {
        return { ok: false, summary: `保存失败：${message(error)}` };
      }
    },
  };
}
