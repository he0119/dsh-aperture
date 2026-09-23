/**
 * 报告：设置标签页的状态段与模型清单。
 *
 * 这里是**结构化数据**，不是拼好的句子。标签页是双语的，把中文句子拼在宿主半边就等于让英文
 * 界面显示中文；而「哪个模型属于哪条路由」「这条事实是谁给的」本来就是数据，句子只是它的一种
 * 渲染。宿主因此只把发现过程决定了什么摆齐——哪个端点应答了、哪些模型进了哪条路由、哪个模型
 * 没有任何端点能服务、每条事实来自哪里，以及哪些字段是用户写下的覆盖——措辞与排版都交给界面。
 *
 * @module dsh-aperture/report
 */

import type { ResolvedConfig } from './config.ts';
import type { RefreshOutcome } from './runtime.ts';
import type { ConfiguredModel, DiscoveredModel, FactSource, Modality } from './types.ts';

/** 报告里的一个模型。 */
export interface PanelModel {
  /** Aperture 接受的模型 id。 */
  readonly id: string;
  /** 显示名（可能来自清单或覆盖）。 */
  readonly name: string;
  /** 承载它的路由键；没有任何路由能服务时缺失。 */
  readonly route?: string;
  /** 网关通告的协议；未通告时缺失。 */
  readonly protocol?: string;
  /** 网关为该模型通告的每一个端点，用于诊断。 */
  readonly endpoints: readonly string[];
  /** 生效的上下文容量，以 token 计。 */
  readonly contextWindow?: number;
  /** 生效的最大输出，以 token 计。 */
  readonly maxTokens?: number;
  /** 生效的请求模态。 */
  readonly input: readonly Modality[];
  /** 生效的推理能力。 */
  readonly reasoning: boolean;
  /** 每项事实的来源；界面按语言渲染它。 */
  readonly provenance: {
    readonly limits: FactSource;
    readonly reasoning: FactSource;
    readonly input: FactSource;
    readonly name: FactSource;
  };
  /**
   * 用户层里这一行自己写下的键（含界面不编辑的，例如 `reasoningEfforts`；别名写成 `alias`）。
   *
   * 这是「覆盖」的唯一判据，而它只能从用户层读——官方也是这么定义的：看字段在不在用户层里，
   * 而不是拿值与默认值比。解析后的配置用不得：schema 会把没写的数组字段补成 `[]`，把补出来的
   * 空值当成覆盖，界面就会在一行什么都没写过的模型上挂一颗永远撤不掉的「已覆盖」。
   */
  readonly overrideKeys?: readonly string[];
  /** 用户写下的清单别名（`aperture.modelAliases` 里对应那一项）。 */
  readonly alias?: string;
}

/** 报告里的一条已发布路由。 */
export interface PanelRoute {
  /** provider 路由键。 */
  readonly provider: string;
  /** 服务它的协议；本插件自己拼的方案里一定有，类型上仍是可选（`PiAiProviderProfile`）。 */
  readonly api?: string;
  /** 路由的 baseURL，同上。 */
  readonly baseURL?: string;
  /** 该路由承载的模型数。 */
  readonly models: number;
}

/** 最近一次刷新做了什么。 */
export interface PanelRefresh {
  /** 触发来源。 */
  readonly trigger: string;
  /** ISO 时间戳；界面按本地时区渲染。 */
  readonly at: string;
  /** 耗时。 */
  readonly durationMs: number;
  /** 发现与发布是否都成功。 */
  readonly ok: boolean;
  /** 失败原因。 */
  readonly error?: string;
  /** 清单提供了什么。 */
  readonly catalog: {
    /** 清单是否可用。 */
    readonly available: boolean;
    /** 条目数。 */
    readonly entries: number;
    /** 清单不可用时的原因。 */
    readonly reason?: string;
  };
  /** 应答的端点与它列出的行数。 */
  readonly endpoint?: {
    readonly url: string;
    readonly listed: number;
  };
  /** 设置写入的结果。 */
  readonly sync?: {
    readonly applied: boolean;
    readonly ops: number;
    readonly routes: readonly string[];
    readonly reason?: string;
  };
}

/** 标签页要显示的整份报告。 */
export interface PanelReport {
  /** 实例地址（已归一化）；没有配置时为空串，措辞交给界面。 */
  readonly place: string;
  /** 最近一次刷新；还一次都没跑过时为缺失。 */
  readonly refresh?: PanelRefresh;
  /** 已发布的路由。 */
  readonly routes: readonly PanelRoute[];
  /** 逐模型清单：先是各条路由承载的模型，最后是没有任何路由的模型。 */
  readonly models: readonly PanelModel[];
}

/** 用户层里写下的东西：报告要照着它说「哪些是这一行自己写的」。 */
export interface DeclaredOverrides {
  /** 用户层 `aperture.models` 的原样条目。 */
  readonly models?: readonly Record<string, unknown>[];
  /** 用户层 `aperture.modelAliases` 里写过的模型 id。 */
  readonly aliasIds?: readonly string[];
}

/**
 * 组装报告。
 *
 * @param outcome - 最近一次刷新；一次都没完成过时传 `undefined`。
 * @param config - 当前生效配置。
 * @param declared - 用户层里写下的覆盖；缺省即「什么都没写过」。
 * @returns 报告。
 */
export function buildReport(
  outcome: RefreshOutcome | undefined,
  config: ResolvedConfig,
  declared: DeclaredOverrides = {},
): PanelReport {
  const keys = new Map<string, string[]>();
  for (const entry of declared.models ?? []) {
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id.length === 0) continue;
    keys.set(id, Object.keys(entry).filter((key) => key !== 'id'));
  }
  for (const id of declared.aliasIds ?? []) {
    // 别名是另一张表，但对界面来说它是这一行的覆盖之一：撤的时候一起撤。
    keys.set(id, [...(keys.get(id) ?? []), 'alias']);
  }
  const routes: PanelRoute[] = (outcome?.routes ?? []).map((route) => ({
    provider: route.provider,
    ...(route.profile.api === undefined ? {} : { api: route.profile.api }),
    ...(route.profile.baseURL === undefined ? {} : { baseURL: route.profile.baseURL }),
    models: route.models.length,
  }));

  const models: PanelModel[] = [];
  const routed = new Set<string>();
  const describe = (model: DiscoveredModel, route?: string): PanelModel => {
    routed.add(model.id);
    const declaredKeys = keys.get(model.id) ?? [];
    const alias = config.modelAliases[model.id];
    return {
      id: model.id,
      name: model.name,
      ...(route === undefined ? {} : { route }),
      ...(model.protocol === undefined ? {} : { protocol: model.protocol }),
      endpoints: model.endpoints,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      input: model.input,
      reasoning: model.reasoning,
      provenance: model.provenance,
      ...(declaredKeys.length === 0 ? {} : { overrideKeys: declaredKeys }),
      ...(alias === undefined ? {} : { alias }),
    };
  };

  for (const route of outcome?.routes ?? []) {
    for (const model of route.models) models.push(describe(model, route.provider));
  }
  // 没有任何路由能服务的模型跟在后面：它们没有协议可用，或者被配置挡掉了。
  for (const model of outcome?.models ?? []) {
    if (!routed.has(model.id)) models.push(describe(model));
  }

  return {
    place: config.instanceRoot ?? config.rawBaseUrl,
    ...(outcome === undefined ? {} : { refresh: refresh(outcome) }),
    routes,
    models,
  };
}

/**
 * 把一次刷新收成报告要显示的字段。
 *
 * @param outcome - 已完成的刷新。
 * @returns 状态段的数据。
 */
function refresh(outcome: RefreshOutcome): PanelRefresh {
  const catalog = outcome.catalog;
  const sync = outcome.sync;
  return {
    trigger: outcome.trigger,
    at: outcome.at.toISOString(),
    durationMs: outcome.durationMs,
    ok: outcome.ok,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    catalog: {
      // `lookup` 在清单不可用时缺失；报告只报可用性，不报这个函数本身。
      available: catalog.lookup !== undefined,
      entries: catalog.entries,
      ...(catalog.reason === undefined ? {} : { reason: catalog.reason }),
    },
    ...(outcome.endpoint === undefined
      ? {}
      : { endpoint: { url: outcome.endpoint, listed: outcome.listed } }),
    ...(sync === undefined
      ? {}
      : {
        sync: {
          applied: sync.applied,
          ops: sync.ops,
          routes: sync.routes,
          ...(sync.reason === undefined ? {} : { reason: sync.reason }),
        },
      }),
  };
}
