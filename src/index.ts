/**
 * dsh-aperture：发现 Aperture 网关所服务的模型，并自己作为 dsh 的 provider 把它们服务出去。
 *
 * Aperture 是 Tailscale 的集中式 LLM 网关：一个端点挡在团队有权使用的所有上游前面，靠网络
 * 身份而不是密钥认证。harness 本来就会跟这样的网关说话——三种线缆协议分别由 pi-ai 的
 * OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 实现——但没有东西让模型
 * 清单自己刷新：适配器自带的「获取可用模型」只接受一份当时还在编辑的草稿。
 *
 * 本插件就是缺的那一半：读 `GET {baseUrl}/v1/models`，逐个模型判断网关实际用哪种协议服务它，
 * 用网关自己的字段加上 models.dev 定容量、写描述，然后**注册自己的 provider 路由**把这些模型
 * 服务出去。它不转换任何协议格式——这正是重点。
 *
 * 注册走官方那条接缝（`ctx.llm.registerAdapter` + `registerConfigurableProviders`），因此本插件
 * 不写任何配置：配置只由用户与官方界面写，本插件只读。路由键被别的适配器占着时注册会被拒，
 * 那一轮的报告会点名是哪个键挡住的、要手工删掉什么。
 *
 * 界面在「插件」页里：Web Client 端（`client/aperture.js`）把自己注册成插件管理页的**包级**配置页
 * （`plugins.bundle.config`，键是包名），用来改实例地址与注册开关（关掉即撤下已注册的路由）、
 * 立刻刷新，以及就地改单个模型的参数。除此之外没有别的界面——发现本身发生在插件加载、配置变更
 * 与刷新间隔到点上。
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
// 同理：这三个包把 `llm` / `credentials` / `attachments` 声明合并进 `Context`，
// 空导入让 `ctx.llm`、`ctx.get('credentials')` 有类型。运行时它们由宿主提供。
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-attachment';
import { fetchModelsListing } from './aperture.ts';
import { ModelCatalog } from './catalog.ts';
import {
  configValue,
  memoizedConfig,
  type ConfigRef,
} from './config.ts';
import { createPanelOps } from './panel.ts';
import { buildProfilePlan } from './profile.ts';
import { ApertureProvider } from './provider.ts';
import { outside } from './relay.ts';
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
export type { PanelAction, PanelDeps, PanelModelPatch, PanelOps } from './panel.ts';
export { buildReport } from './report.ts';
export type { DeclaredOverrides, PanelModel, PanelRefresh, PanelReport, PanelRoute } from './report.ts';
export { DEFAULT_PLACEHOLDER_CREDENTIAL, buildProfilePlan } from './profile.ts';
export type { ModelProfile, ProfilePlan, ProfileOptions, RoutePlan, RouteProfile } from './profile.ts';
export { ApertureProvider } from './provider.ts';
export type { ProviderDeps, PublishOutcome } from './provider.ts';
export { buildRegistry, classifyProtocol, isDeepSeekFamily } from './registry.ts';
export type { RegistryResult } from './registry.ts';
export { AperturePanelService, PANEL_CONTRIBUTION, PANEL_INVOCATIONS, PANEL_NAMESPACE, PANEL_PACKAGE } from './remote.ts';
export { ApertureRuntime } from './runtime.ts';
export type { RefreshOutcome, RuntimeDeps, RuntimeLogger } from './runtime.ts';
export type { ConfiguredModel, DiscoveredModel, FactSource, Modality, ModelProvenance } from './types.ts';
export { buildModelsEndpoint, buildRouteBaseUrl, normalizeBaseUrl } from './url.ts';
export { Config, configValue } from './config.ts';

/** 出现在加载器诊断里的插件名。 */
export const name = 'dsh-aperture';

/**
 * `settings` 是必需依赖：发现报告与配置页都要读它，而插件自己的 `aperture` 段也要由它变成
 * 可编辑的。`llm` 同样必需：本插件的产出就是那几条 provider 路由，没有 LLM 接缝就没有地方
 * 可以注册——走到这里却注册不了，用户只会看到模型莫名其妙地不见了。
 *
 * `typert` 则刻意**不**声明：配置页只是顺手提供的便利，没有它的部署（例如 headless profile）
 * 也该照样获得路由，因此它在下面按需注入，不在就安静跳过。
 */
export const inject = ['settings', 'llm'];

/**
 * 把网关的模型清单注册成自己的 provider 路由：现在注册，之后有任何变化也重新注册。
 *
 * @param ctx - 插件上下文，其中 `settings` 与 `llm` 已就绪。
 * @param config - 组合层的 `aperture` 段，已按 `Config` schema 校验并带上默认值；根级 volatile
 *   使它成为活引用，读值走 `config.get()`。
 * @throws Error 当配置自身矛盾（路由键不合文法、推理档位非法、模型覆盖重复或无法服务）时抛出
 *   ——框架的失败路径正是「坏配置要响亮」的实现方式。
 */
export function apply(ctx: Context, config: ConfigRef): void {
  const logger = ctx.logger as RuntimeLogger;
  const catalog = new ModelCatalog();

  // 根级 volatile 让 `config` 是**活引用**而非快照：每次配置变更都是对同一引用来一次
  // `updateVolatile`，只有值真的变了才换一份深冻结的解析结果。下面所有读取都走 `configValue`，
  // 而它给出的快照身份就是运行时用的「配置版本」。
  const readConfig = memoizedConfig(() => configValue(config));

  const provider = new ApertureProvider({
    llm: ctx.llm,
    credentials: () => ctx.get('credentials'),
    attachments: () => ctx.get('attachments'),
    logger,
  });
  ctx.effect(() => () => provider.dispose(), 'aperture provider registration');

  const runtime = new ApertureRuntime({
    config: readConfig,
    settings: ctx.settings,
    logger,
    catalog,
    provider,
  });

  // 被占用的路由键随时可能被腾出来（用户照报告删掉了遗留配置，或那个插件自己撤了）。接缝每次
  // 注册集合变动都发这个事件，因此这里不必轮询；没有冲突时 `retry()` 是空操作，本插件自己那次
  // 成功注册所触发的事件不会变成自激循环。
  ctx.on('llm/adapters-updated', () => {
    if (provider.retry()) {
      logger.info('dsh-aperture: 路由注册的冲突已解除，本插件的路由已就绪');
    }
  });

  // 刷新间隔在每次配置变更时重新计算，而不是只捕获一次：部署可以在设置文档里开关周期刷新，
  // 无需重启。
  let timer: ReturnType<typeof setInterval> | undefined;
  const armInterval = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    const { refreshIntervalMinutes } = readConfig();
    if (refreshIntervalMinutes > 0) {
      timer = setInterval(() => void outside(() => runtime.refresh('定时')), refreshIntervalMinutes * 60_000);
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

  // 配置变更只有这一条来路：Loader 在一次 volatile-only 更新落地后发这个事件，此时 `get()`
  // 已是新值。配置页自己写入的变更也走这里——它写完会再显式刷一轮，而那一轮与这里起的是同一轮
  // （运行时的单飞判定按配置版本合并），不会多跑一遍发现。
  //
  // 这一轮非经 `outside` 不可：事件是在设置写入那个**事务里**同步发出来的，直接在事务里做注册
  // 这类外部动作会被 HMR 判成事务嵌套而拒绝（见 `relay.ts`）。
  ctx.on('loader/volatile-update', () => {
    armInterval();
    void outside(() => runtime.refresh('配置变更'));
  });

  // 本插件自己画设置表单（Web Client 端在包级配置页上拿 `configForms` 那份作用域手写这一页），
  // 因此不让设置接缝再为它生成一个通用表单页。这只是页面归属的声明，不影响配置的读写能力。
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

  // 插件加载本身就是启动发现的那个动作：走到这里配置已解析完毕（组合层 + 用户层，默认值全部
  // 补齐），所以第一轮刷新看到的就是生效配置。第一轮照样走 `outside`：插件本身可能是被源码热重载
  // 在事务里重建的，那一代的注册同样要从事务之外起跑。
  void outside(() => runtime.refresh('插件加载'));

  // 配置页需要 Host 端的 Remote 接口（报告、按行写模型参数、立刻刷新），而 Typert 注册表只有 Web
  // 这类装配了网关的 profile 才有。其余 profile 里这一整块被跳过：路由照常注册，只是没有可点按
  // 的界面。
  ctx.inject(['typert'], (panelCtx) => {
    const ops = createPanelOps({ runtime, config: readConfig, settings: ctx.settings });
    panelCtx.effect(() => panelCtx.typert.register(PANEL_CONTRIBUTION), 'aperture panel invocations');
    panelCtx.plugin(AperturePanelService, ops);
  });
}
