/**
 * 发现运行时：同一时刻只跑一次刷新，只记住一个结果。
 *
 * 刷新有四个来路（插件加载、设置变更、刷新间隔、配置页），其中两条容易重叠——本插件写入的
 * 设置变更会唤醒触发这次写入的同一个 watcher。因此刷新是单飞的：途中到达的请求若正在跑的那
 * 一轮读的就是此刻这份配置就并进它，否则排在它后面（见 {@link ApertureRuntime.refresh}）；
 * 排队者共享同一轮，所以再多的调用方也只多跑一轮。
 *
 * 记住的结果只是设置文档里那份的影子：配置页报告它，真正服务请求的是文档里已生效的那份。
 *
 * @module dsh-aperture/runtime
 */

import type { SettingsForms } from '@deepseek-ai/dsh-settings';
import { fetchModelsListing } from './aperture.ts';
import { ModelCatalog, type CatalogLoad } from './catalog.ts';
import { DEFAULT_TIMEOUT_MS, type ResolvedConfig } from './config.ts';
import { buildProfilePlan, type ProfilePlan, type RoutePlan } from './profile.ts';
import { buildRegistry } from './registry.ts';
import { applySync, type SyncOutcome } from './sync.ts';
import type { DiscoveredModel } from './types.ts';

/** 运行时用来输出诊断信息的最小日志接口。 */
export interface RuntimeLogger {
  error(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  debug(message: string, ...rest: unknown[]): void;
}

/** 一次已完成的刷新。 */
export interface RefreshOutcome {
  /** 触发这次刷新的来源。 */
  readonly trigger: string;
  /** 发现与发布是否都成功。 */
  readonly ok: boolean;
  /** 完成时间。 */
  readonly at: Date;
  /** 耗时。 */
  readonly durationMs: number;
  /** 应答的 URL（如果有）。 */
  readonly endpoint?: string;
  /** 网关列出的模型行数。 */
  readonly listed: number;
  /** 全部归一化后的模型。 */
  readonly models: readonly DiscoveredModel[];
  /** 该方案发布的路由。 */
  readonly routes: readonly RoutePlan[];
  /** 没有任何路由能服务的模型。 */
  readonly unserved: readonly DiscoveredModel[];
  /** 清单提供的内容。 */
  readonly catalog: CatalogLoad;
  /** 设置写入的结果（如果尝试过写入）。 */
  readonly sync?: SyncOutcome;
  /** 刷新失败时的错误。 */
  readonly error?: string;
}

/** 运行时从宿主读取的全部内容。 */
export interface RuntimeDeps {
  /** 当前生效的配置，每次刷新都会重新读取。 */
  readonly config: () => ResolvedConfig;
  /** 设置服务；插件把它声明为必需注入。 */
  readonly settings: SettingsForms;
  /** 具名 logger。 */
  readonly logger: RuntimeLogger;
  /** models.dev 缓存，在各次刷新之间共享。 */
  readonly catalog: ModelCatalog;
}

/** 单飞（single-flight）的发现与发布。 */
export class ApertureRuntime {
  private readonly deps: RuntimeDeps;
  private running: Promise<RefreshOutcome> | undefined;
  /** 正在跑的那一轮读的是哪一份配置；用来判断排队者该并进它还是排到它后面。 */
  private runningConfig: ResolvedConfig | undefined;
  private latest: RefreshOutcome | undefined;

  /**
   * @param deps - 宿主服务与配置活引用（thunk）。
   */
  constructor(deps: RuntimeDeps) {
    this.deps = deps;
  }

  /** 最近一次已完成的刷新（如果完成过）。 */
  last(): RefreshOutcome | undefined {
    return this.latest;
  }

  /**
   * 刷新；已有刷新在运行时，等它收尾之后再决定是并进新的一轮，还是自己起一轮。
   *
   * 承诺是「返回的那一轮读的是**此刻**的配置」：正在跑的那一轮若读的就是此刻这份配置，
   * 调用方并进它；否则等它收尾再重问一次。设置界面刚写完配置就来重读报告时，等的必须是
   * 读过新配置的那一轮——等正在跑的那一轮回来等于拿回过期报告，界面于是「保存了却没变」。
   * 配置身份可以直接比：设置服务每次提交都换一份深冻结的解析结果，没变就还是同一个对象。
   *
   * @param trigger - 触发来源；出现在配置页的状态段里。
   * @returns 本次调用所参与的那一轮刷新的结果。
   */
  async refresh(trigger: string): Promise<RefreshOutcome> {
    if (this.running !== undefined) {
      if (this.runningConfig === this.deps.config()) return this.running;
      await this.running;
      return this.refresh(trigger);
    }
    const config = this.deps.config();
    const run = this.run(trigger, config);
    this.running = run;
    this.runningConfig = config;
    try {
      return await run;
    } finally {
      this.running = undefined;
      this.runningConfig = undefined;
    }
  }

  /** 执行一次刷新，绝不抛出异常。 */
  private async run(trigger: string, config: ResolvedConfig): Promise<RefreshOutcome> {
    const started = Date.now();
    const at = new Date();
    try {
      return await this.execute(trigger, config, started, at);
    } catch (error) {
      // 上面的任何代码都不允许 reject：所有调用方都是即发即忘的 `void`，而在宿主的
      // loader 里出现未处理的 rejection 并不是报告清单损坏的可接受方式。
      const outcome: RefreshOutcome = {
        trigger,
        ok: false,
        at,
        durationMs: Date.now() - started,
        listed: 0,
        models: [],
        routes: [],
        unserved: [],
        catalog: { entries: 0, reason: '未执行' },
        error: message(error),
      };
      this.latest = outcome;
      this.deps.logger.warn('刷新失败：%s', outcome.error ?? '');
      return outcome;
    }
  }

  /** 一次刷新的主体。 */
  private async execute(
    trigger: string,
    config: ResolvedConfig,
    started: number,
    at: Date,
  ): Promise<RefreshOutcome> {
    if (config.instanceRoot === undefined) {
      const outcome: RefreshOutcome = {
        trigger,
        ok: false,
        at,
        durationMs: Date.now() - started,
        listed: 0,
        models: [],
        routes: [],
        unserved: [],
        catalog: { entries: 0, reason: '未尝试' },
        error: config.rawBaseUrl.length === 0 ? '未配置 baseUrl' : `baseUrl "${config.rawBaseUrl}" 不是可用的 URL`,
      };
      this.latest = outcome;
      return outcome;
    }

    const catalog = await this.deps.catalog.load(config.modelMetadataUrl, DEFAULT_TIMEOUT_MS);

    let listed: readonly unknown[];
    let endpoint: string;
    try {
      const listing = await fetchModelsListing(config.instanceRoot, { timeoutMs: DEFAULT_TIMEOUT_MS });
      listed = listing.entries;
      endpoint = listing.endpoint;
    } catch (error) {
      const outcome: RefreshOutcome = {
        trigger,
        ok: false,
        at,
        durationMs: Date.now() - started,
        listed: 0,
        models: [],
        routes: [],
        unserved: [],
        catalog,
        error: message(error),
      };
      this.latest = outcome;
      // 失败的刷新不发布任何内容：设置文档中已有的清单继续提供服务，一次瞬时网络错误
      // 不得把它撤销。
      this.deps.logger.warn('发现失败；保留已发布的清单：%s', outcome.error ?? '');
      return outcome;
    }

    const registry = buildRegistry(
      listed,
      {
        models: config.models,
        enabledModelIds: config.enabledModelIds,
        modelAliases: config.modelAliases,
        images: config.images,
        reasoning: config.reasoning,
      },
      catalog.lookup,
    );

    const plan = buildProfilePlan(registry.models, {
      instanceRoot: config.instanceRoot,
      route: config.route,
      anthropicRoute: config.anthropicRoute,
      displayName: config.displayName,
      anthropicDisplayName: config.anthropicDisplayName,
      ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
      headers: config.headers,
      configured: config.models,
    });

    const sync = await this.publish(config, plan);
    const outcome: RefreshOutcome = {
      trigger,
      ok: true,
      at,
      durationMs: Date.now() - started,
      endpoint,
      listed: listed.length,
      models: registry.models,
      routes: plan.routes,
      unserved: plan.unserved,
      catalog,
      sync,
    };
    this.latest = outcome;

    this.deps.logger.info(
      '发现 %d 个模型（来自 %s）；已发布 %d 条路由%s',
      registry.models.length,
      endpoint,
      plan.routes.length,
      sync.applied ? '' : ` （${sync.reason ?? '未写入'}）`,
    );
    return outcome;
  }

  /** 写入方案，或说明为什么没有写入任何内容。 */
  private async publish(config: ResolvedConfig, plan: ProfilePlan): Promise<SyncOutcome> {
    // 关掉同步是「撤下本插件的路由」，不是「什么都不做」：留着一份不再由配置决定的清单，
    // 界面看不出还有谁在服务，用户只能自己去翻 `llm-pi-ai` 段。空方案正好表达撤下——
    // `planSync` 会把每个拥有但不再需要的路由键 unset 掉。
    const routes = config.sync ? plan.routes : [];
    try {
      const outcome = await applySync(this.deps.settings, routes, plan.ownedRoutes);
      return config.sync || outcome.applied
        ? outcome
        : { ...outcome, reason: '同步已关闭，本插件没有发布过路由' };
    } catch (error) {
      this.deps.logger.warn('发布发现的清单失败：%s', message(error));
      return { applied: false, ops: 0, routes: [], reason: message(error) };
    }
  }
}

/** 把未知的可抛出对象渲染为单行原因。 */
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
