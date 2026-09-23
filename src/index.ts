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
 * 界面在设置里：浏览器半边（`client/aperture.js`）在「插件」下挂一个 Aperture 标签页，
 * 用来改实例地址与同步开关、立刻刷新、以及把已经发布的路由撤下来。除此之外没有别的
 * 界面——发现本身发生在插件加载、配置变更与刷新间隔到点上。
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
import { fetchModelsListing } from './aperture.ts';
import { ModelCatalog } from './catalog.ts';
import { APERTURE_NAMESPACE, Config as ConfigSchema, memoizedConfig, resolveConfig, type Config } from './config.ts';
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
  PI_AI_NAMESPACE,
  resolveConfig,
} from './config.ts';
export type { Config as ApertureConfig, ResolvedConfig } from './config.ts';
export { createPanelOps } from './panel.ts';
export type { PanelAction, PanelConfiguration, PanelDeps, PanelModelPatch, PanelOps } from './panel.ts';
export { buildReport } from './report.ts';
export type { DeclaredOverrides, PanelModel, PanelRefresh, PanelReport, PanelRoute } from './report.ts';
export { DEFAULT_PLACEHOLDER_CREDENTIAL, buildProfilePlan } from './profile.ts';
export type { ProfilePlan, ProfileOptions, RoutePlan } from './profile.ts';
export { buildRegistry, classifyProtocol, isDeepSeekFamily } from './registry.ts';
export type { RegistryResult } from './registry.ts';
export { AperturePanelService, PANEL_CONTRIBUTION, PANEL_INVOCATIONS, PANEL_NAMESPACE, PANEL_PACKAGE } from './remote.ts';
export { applySync, clearRoutes, planSync } from './sync.ts';
export type { SyncOutcome } from './sync.ts';
export type { ConfiguredModel, DiscoveredModel, FactSource, Modality, ModelProvenance } from './types.ts';
export { buildModelsEndpoint, buildRouteBaseUrl, normalizeBaseUrl } from './url.ts';
export { Config } from './config.ts';

/** 出现在加载器诊断里的插件名。 */
export const name = 'dsh-aperture';

/**
 * settings 是必需依赖，而不是可选项：把发现的模型清单发布进 `llm-pi-ai` **就是**
 * 本插件的职责，而同一次注册又让插件自己的 `aperture` 段变得可编辑。在这里声明它，
 * 意味着框架会把插件挂在 PENDING 直到 settings 就绪；provider 一旦被替换就卸载插件，
 * 恢复后再重新加载——而不是留下一个已经加载、却无处发布的实例。
 *
 * `typert` 则刻意**不**声明：设置界面上的标签页只是顺手提供的便利，没有它的部署（例如
 * headless profile）也应该照样获得发现能力，因此它在下面按需注入，不在就安静地跳过。
 */
export const inject = ['settings'];

/**
 * 发布网关的模型清单：现在发布，之后有任何变化也发布。
 *
 * @param ctx - 插件上下文，其中 `settings` 已就绪。
 * @param config - 组合层的 `aperture` 段，已按 {@link ConfigSchema} 校验并带上默认值。
 * @throws Error 当配置自身矛盾（路由键不合文法或两条路由重复），或存储的 `aperture`
 *   段非法时抛出——框架的失败路径正是“坏配置要响亮”的实现方式。
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger as RuntimeLogger;
  const catalog = new ModelCatalog();

  // `installSection` 交出来的是**活引用**（thunk）而不是快照：解析后的配置段每次被
  // 编辑都是就地替换，所以只有持有这个 thunk，后续的配置变更才能抵达本插件。下面
  // 所有读取都因此走它。
  let source: () => Config = () => config;
  // 解析结果按源缓存：设置服务每次提交都换一份深冻结的对象，因此这个 thunk 的返回值
  // 身份就是**配置版本**——运行时靠它判断正在跑的那一轮读的是不是此刻这份配置。
  const readConfig = memoizedConfig(() => source());

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

  const initial = readConfig();
  logger.info(
    'dsh-aperture: %s',
    initial.instanceRoot === undefined
      ? '还没有可用的 baseUrl，发现功能处于休眠'
      : `正在监视 ${initial.instanceRoot} 的模型`,
  );

  // 注册配置段本身也是启动发现的那个动作：`installSection` 在挂载时会先调用
  // `setSource`、再通知一次 `onChange`，顺序如此，所以第一次刷新看到的就是叠加了
  // 用户层的配置——只跑一遍，而不是先按组合层配置跑一遍、再补一遍去对齐。
  ctx.settings.installSection(ctx, APERTURE_NAMESPACE, ConfigSchema, config, {
    setSource(current) {
      source = current;
    },
    onChange() {
      armInterval();
      void runtime.refresh('配置变更');
    },
    validate(value) {
      resolveConfig(value);
    },
  });

  // 设置里那个标签页需要宿主半边的 Remote 面（报告、配置读写、立刻刷新、撤下路由），而
  // Typert 注册表只有 Web 这类装配了网关的 profile 才有。其余 profile 里这一整块被跳过：
  // 发现照常运行，只是没有可点按的界面。
  ctx.inject(['typert'], (panelCtx) => {
    const ops = createPanelOps({ runtime, config: readConfig, settings: ctx.settings });
    panelCtx.effect(() => panelCtx.typert.register(PANEL_CONTRIBUTION), 'aperture panel invocations');
    panelCtx.plugin(AperturePanelService, ops);
  });
}
