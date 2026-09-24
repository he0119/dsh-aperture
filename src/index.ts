/**
 * dsh-aperture：发现 Aperture 网关所服务的模型，并把它们作为 `llm-pi-ai` 的
 * provider 路由发布给 DeepSeek Harness。
 *
 * Aperture 是 Tailscale 的集中式 LLM 网关：一个端点挡在团队有权使用的所有上游
 * 前面，靠网络身份而不是密钥来认证。harness 本来就会跟这样的网关说话——
 * `dsh-llm-pi-ai` 适配器讲 OpenAI 兼容的 Chat Completions 与 Anthropic Messages，
 * 而这正是 Aperture 暴露的全部——但没有任何东西让模型清单自己刷新：适配器自带的
 * “获取可用模型”动作只接受用户当时还在编辑的一份草稿，而它写在文档里的局限是
 * “一条路由的模型清单永远不会自己刷新”。
 *
 * 本插件就是缺的那一半。它读取 `GET {baseUrl}/v1/models`，逐个模型判断网关实际用
 * 哪种协议服务它，再用网关自己的字段加上 models.dev 定容量、写描述，最后把结果写进
 * `llm-pi-ai` 的 provider 字典——harness 自己把那份文档称作“决定哪些 provider 运行”
 * 的东西。
 *
 * 它不转换任何协议格式。这正是重点。
 *
 * 界面在「插件」页里：浏览器半边（`client/aperture.js`）注册进插件管理页的
 * `plugins.row.config` 槽位，于是本插件那一行多出一个「配置」入口，用来改实例地址与
 * 同步开关（关掉即撤下已发布的路由）、立刻刷新。除此之外没有别的界面——发现本身发生
 * 在插件加载、配置变更与刷新间隔到点上。
 *
 * ```yaml
 * - id: aperture
 *   name: 'dsh-aperture'
 *   config:
 *     baseUrl: https://ai.example.ts.net
 * ```
 *
 * @module dsh-aperture
 */

import type { Context } from '@deepseek-ai/cordis';
// 只为一个类型而来：`loader/volatile-update` 这个事件名由 cordis-plugin-loader 声明合并
// 进 `Events`，而本包在运行时并不需要它——空导入让编译期能看见那条声明。
import type {} from '@deepseek-ai/cordis-plugin-loader';
import { fetchModelsListing } from './aperture.ts';
import { ModelCatalog } from './catalog.ts';
import {
  configValue,
  memoizedConfig,
  type ConfigRef,
} from './config.ts';
import { createPanelOps } from './panel.ts';
import { buildProfilePlan } from './profile.ts';
import { buildRegistry, classifyProtocol } from './registry.ts';
import { AperturePanelService, PANEL_CONTRIBUTION, PANEL_NAMESPACE, PANEL_PACKAGE } from './remote.ts';
import { ApertureRuntime, type RuntimeLogger } from './runtime.ts';

export { fetchModelsListing } from './aperture.ts';
export type { ModelsListing } from './aperture.ts';
export { ModelCatalog } from './catalog.ts';
export {
  APERTURE_NAMESPACE,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL_METADATA_URL,
  resolveConfig,
} from './config.ts';
export type { Config as ApertureConfig, ConfigRef, ResolvedConfig } from './config.ts';
export { createPanelOps } from './panel.ts';
export type { PanelAction, PanelConfiguration, PanelDeps, PanelModelPatch, PanelOps } from './panel.ts';
export { buildReport } from './report.ts';
export type { DeclaredOverrides, PanelModel, PanelRefresh, PanelReport, PanelRoute } from './report.ts';
export { DEFAULT_PLACEHOLDER_CREDENTIAL, buildProfilePlan } from './profile.ts';
export type { ProfilePlan, ProfileOptions, RoutePlan } from './profile.ts';
export { buildRegistry, classifyProtocol, isDeepSeekFamily } from './registry.ts';
export type { RegistryResult } from './registry.ts';
export { AperturePanelService, PANEL_CONTRIBUTION, PANEL_INVOCATIONS, PANEL_NAMESPACE, PANEL_PACKAGE } from './remote.ts';
export { PI_AI_NAMESPACE, applySync, planSync } from './sync.ts';
export type { SyncOutcome } from './sync.ts';
export type { ConfiguredModel, DiscoveredModel, FactSource, Modality, ModelProvenance } from './types.ts';
export { buildModelsEndpoint, buildRouteBaseUrl, normalizeBaseUrl } from './url.ts';
export { Config, configValue } from './config.ts';

/** 出现在加载器诊断里的插件名。 */
export const name = 'dsh-aperture';

/**
 * settings 是必需依赖，而不是可选项：把发现的模型清单发布进 `llm-pi-ai` **就是**
 * 本插件的职责，而同一次注册又让插件自己的 `aperture` 段变得可编辑。在这里声明它，
 * 意味着框架会把插件挂在 PENDING 直到 settings 就绪；provider 一旦被替换就卸载插件，
 * 恢复后再重新加载——而不是留下一个已经加载、却无处发布的实例。
 *
 * `typert` 则刻意**不**声明：设置界面上的配置页只是顺手提供的便利，没有它的部署（例如
 * headless profile）也应该照样获得发现能力，因此它在下面按需注入，不在就安静地跳过。
 */
export const inject = ['settings'];

/**
 * 发布网关的模型清单：现在发布，之后有任何变化也发布。
 *
 * @param ctx - 插件上下文，其中 `settings` 已就绪。
 * @param config - 组合层的 `aperture` 段，已按 `Config` schema 校验并带上默认值；根级
 *   volatile 使它成为一个活引用，读值走 `config.get()`。
 * @throws Error 当配置自身矛盾（路由键不合文法或两条路由重复），或存储的 `aperture`
 *   段非法时抛出——框架的失败路径正是“坏配置要响亮”的实现方式。
 */
export function apply(ctx: Context, config: ConfigRef): void {
  const logger = ctx.logger as RuntimeLogger;
  const catalog = new ModelCatalog();

  // 根级 volatile 让 `config` 是一个**活引用**，而不是一份快照：每次配置变更都是就地对
  // 同一个引用来一次 `updateVolatile`，只有值真的变了才换一份深冻结的解析结果。下面所有
  // 读取都因此走 `configValue`（`get()` 加一次空值兜底），而它给出的快照身份就是运行时要的
  // 「配置版本」。
  const readConfig = memoizedConfig(() => configValue(config));

  const runtime = new ApertureRuntime({
    config: readConfig,
    settings: ctx.settings,
    logger,
    catalog,
  });

  // 刷新间隔在每次配置变更时重新计算，而不是只捕获一次，这样部署可以在设置文档里
  // 开关周期刷新，无需重启。
  let timer: ReturnType<typeof setInterval> | undefined;
  const armInterval = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    const { refreshIntervalMinutes } = readConfig();
    if (refreshIntervalMinutes > 0) {
      timer = setInterval(() => void runtime.refresh('定时'), refreshIntervalMinutes * 60_000);
      timer.unref?.();
    }
  };
  ctx.effect(
    () => {
      armInterval();
      return () => {
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    'aperture refresh interval',
  );

  // 配置变更只有这一条来路：Loader 在一次 volatile-only 更新落地之后发这个事件，此时
  // `get()` 已经是新值。配置页自己写入的变更也走这里——它写完会再显式刷一轮，而那一轮与
  // 这里起的是同一轮（运行时的单飞判定按配置版本合并），不会多跑一遍发现。
  ctx.on('loader/volatile-update', () => {
    armInterval();
    void runtime.refresh('配置变更');
  });

  // 本插件自己画配置页（浏览器半边注册进「插件」页的 `plugins.row.config` 槽位），因此
  // 不让设置接缝再为它生成一个通用表单页。这只是页面归属的声明，不影响配置的读写能力。
  ctx.effect(
    () => ctx.settings.configure({ auto: false }, ctx.fiber),
    'aperture settings presentation',
  );

  const initial = readConfig();
  logger.info(
    'dsh-aperture: %s',
    initial.instanceRoot === undefined
      ? '还没有可用的 baseUrl，发现功能处于休眠'
      : `正在监视 ${initial.instanceRoot} 的模型`,
  );

  // 插件加载本身就是启动发现的那个动作：走到这里配置已经解析完毕（组合层 + 用户层，默认
  // 值全部补齐），所以第一轮刷新看到的就是生效配置，不必先按组合层跑一遍再补一遍去对齐。
  void runtime.refresh('插件加载');

  // 配置页需要宿主半边的 Remote 面（报告、配置读写、立刻刷新），而
  // Typert 注册表只有 Web 这类装配了网关的 profile 才有。其余 profile 里这一整块被跳过：
  // 发现照常运行，只是没有可点按的界面。
  ctx.inject(['typert'], (panelCtx) => {
    const ops = createPanelOps({ runtime, config: readConfig, settings: ctx.settings });
    panelCtx.effect(() => panelCtx.typert.register(PANEL_CONTRIBUTION), 'aperture panel invocations');
    panelCtx.plugin(AperturePanelService, ops);
  });
}
