/**
 * 写入阶段：把方案发布到 `llm-pi-ai` 配置段。
 *
 * 该配置段属于另一个插件——`@deepseek-ai/dsh-llm-pi-ai`——而设置接缝不做归属检查，
 * 因此写入它是被允许的。它同时也是被认可的机制，而不是变通做法：宿主把 pi-ai 适配器
 * 组合为休眠状态，并声明「哪些 provider 运行由用户的设置文档决定」。发现阶段若产出了
 * 别的东西，就必须重新实现一套协议格式，而本插件之所以存在，正是因为不必如此。
 *
 * 三条性质使这一写入可以安全重复。
 *
 * 没有任何变化时它是空操作，且比较对象是**已解析的**配置段而非原始配置段，因此部署
 * 自身的组合层不会被视作漂移。
 *
 * 它只写入本插件拥有的路由键，且使用路径寻址的 op，因此配置段中其他每个 provider 都
 * 原样保留。
 *
 * 它绝不会在发现失败后运行：不可达的网关会保留已经在服务的清单，因为在瞬时网络错误
 * 下删除可用模型的刷新，比什么都不做的刷新更糟。
 *
 * @module dsh-aperture/sync
 */

import type { SettingsPathOp, SettingsProvider } from '@deepseek-ai/dsh-settings';
import { PI_AI_NAMESPACE } from './namespaces.ts';
import type { RoutePlan } from './profile.ts';

/** 一次发布尝试的结果。 */
export interface SyncOutcome {
  /** 是否发出了写入。 */
  readonly applied: boolean;
  /** 该写入携带的路径 op 数量。 */
  readonly ops: number;
  /** 方案发布的路由键。 */
  readonly routes: readonly string[];
  /** 未写入任何内容时，说明原因。 */
  readonly reason?: string;
}

/**
 * 计算使某个配置段与方案一致的路径 op。
 *
 * @param current - 已解析的 `llm-pi-ai` 值；命名空间未注册时为 `undefined`。
 * @param routes - 方案希望存在的路由。
 * @param ownedRoutes - 本插件拥有的每个路由键，因此不再有模型的路由会被移除，而不是
 *   继续服务一份陈旧的清单。
 * @returns 要应用的 op；配置段已经匹配时为空数组。
 */
export function planSync(
  current: unknown,
  routes: readonly RoutePlan[],
  ownedRoutes: readonly string[],
): SettingsPathOp[] {
  const providers = readProviders(current);
  // 无法容纳 provider 字典的配置段不是本插件可以据以规划的对象：写入其中只会造出
  // 适配器无论如何都会拒绝的形状。
  if (providers === undefined) {
    return [];
  }

  const ops: SettingsPathOp[] = [];
  const desired = new Map(routes.map((route) => [route.provider, route.profile]));

  for (const provider of ownedRoutes) {
    const profile = desired.get(provider);
    if (profile === undefined) {
      if (provider in providers) {
        ops.push({ op: 'unset', path: ['providers', provider] });
      }
      continue;
    }
    if (deepEqualJson(providers[provider], profile)) {
      continue;
    }
    ops.push({ op: 'set', path: ['providers', provider], value: profile });
  }

  return ops;
}

/**
 * 把一个方案发布到 `llm-pi-ai` 配置段。
 *
 * @param settings - 设置服务。
 * @param routes - 要发布的路由。
 * @param ownedRoutes - 本插件拥有的每个路由键。
 * @returns 发生了什么；未写入任何内容时包含原因。
 */
export async function applySync(
  settings: SettingsProvider,
  routes: readonly RoutePlan[],
  ownedRoutes: readonly string[],
): Promise<SyncOutcome> {
  const current = settings.get(PI_AI_NAMESPACE);
  if (current === undefined) {
    return {
      applied: false,
      ops: 0,
      routes: [],
      reason: `设置命名空间 "${PI_AI_NAMESPACE}" 未注册；@deepseek-ai/dsh-llm-pi-ai 是否已挂载？`,
    };
  }

  const providers = readProviders(current);
  if (providers === undefined) {
    return { applied: false, ops: 0, routes: [], reason: `"${PI_AI_NAMESPACE}" 配置段不是 provider 字典` };
  }

  const ops = planSync(current, routes, ownedRoutes);
  if (ops.length === 0) {
    return { applied: false, ops: 0, routes: routes.map((route) => route.provider), reason: '已处于同步状态' };
  }

  try {
    await settings.mutate(PI_AI_NAMESPACE, ops, currentRevision(settings));
  } catch (error) {
    // 并发写入者（Models 页面、另一个进程）在读取与写入之间改动了该配置段。用新的
    // 版本号重试一次就足够了：op 是路径寻址的，因此重新规划不会丢失它们的编辑。
    if (!isConflict(error)) {
      throw error;
    }
    const retryOps = planSync(settings.get(PI_AI_NAMESPACE), routes, ownedRoutes);
    if (retryOps.length === 0) {
      return { applied: false, ops: 0, routes: routes.map((route) => route.provider), reason: '已处于同步状态' };
    }
    await settings.mutate(PI_AI_NAMESPACE, retryOps, currentRevision(settings));
  }

  return { applied: true, ops: ops.length, routes: routes.map((route) => route.provider) };
}

/**
 * 从配置段中撤出本插件拥有的每条路由。
 * @param settings - 设置服务。
 * @param ownedRoutes - 要移除的路由键。
 * @returns 发生了什么。
 */
export async function clearRoutes(settings: SettingsProvider, ownedRoutes: readonly string[]): Promise<SyncOutcome> {
  const current = settings.get(PI_AI_NAMESPACE);
  if (current === undefined) {
    return {
      applied: false,
      ops: 0,
      routes: [],
      reason: `设置命名空间 "${PI_AI_NAMESPACE}" 未注册`,
    };
  }
  const providers = readProviders(current);
  if (providers === undefined) {
    return { applied: false, ops: 0, routes: [], reason: `"${PI_AI_NAMESPACE}" 配置段不是 provider 字典` };
  }
  const ops: SettingsPathOp[] = [];
  for (const provider of ownedRoutes) {
    if (provider in providers) {
      ops.push({ op: 'unset', path: ['providers', provider] });
    }
  }
  if (ops.length === 0) {
    return { applied: false, ops: 0, routes: [], reason: '没有需要移除的路由' };
  }
  await settings.mutate(PI_AI_NAMESPACE, ops, currentRevision(settings));
  return { applied: true, ops: ops.length, routes: [] };
}

/** 从已解析的配置段值中读出 provider 字典。 */
function readProviders(current: unknown): Record<string, unknown> | undefined {
  if (current === null || typeof current !== 'object') {
    return undefined;
  }
  const providers = (current as { providers?: unknown }).providers;
  // 该键缺失即为空字典：适配器的 schema 会为其补上默认值，因此从未承载过 provider 的
  // 配置段正是预期状态。
  if (providers === undefined) {
    return {};
  }
  return providers !== null && typeof providers === 'object' && !Array.isArray(providers)
    ? (providers as Record<string, unknown>)
    : undefined;
}

/** pi-ai 配置段的当前版本号；provider 未暴露时为空。 */
function currentRevision(settings: SettingsProvider): number | undefined {
  try {
    return settings.describe().find((descriptor) => descriptor.ns === PI_AI_NAMESPACE)?.revision;
  } catch {
    return undefined;
  }
}

/** 判断某个可抛出对象是否为设置接缝的陈旧版本号冲突。 */
function isConflict(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT';
}

/**
 * 结构化 JSON 相等性。
 *
 * 之所以写出实现而不是导入，是因为这里比较的值恰好都是 JSON：本插件生成的 profile，
 * 以及设置接缝从文档中解析回来的 profile。键顺序不属于这种同一性，因此被归一化掉。
 *
 * @param left - 一个 JSON 值。
 * @param right - 另一个。
 * @returns 两者是否结构相等。
 */
export function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => deepEqualJson(value, right[index]));
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => key in rightRecord && deepEqualJson(leftRecord[key], rightRecord[key]));
}
