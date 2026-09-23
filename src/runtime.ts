/**
 * 发现运行时：同一时刻只跑一次刷新，只记住一个结果。
 *
 * 刷新来自四个方向——插件加载、设置变更、刷新间隔，以及设置界面的标签页——其中两个
 * 很容易重叠，因为本插件自己写入并提交的设置变更会唤醒触发这次写入的同一个 watcher。
 * 因此刷新是单飞（single-flight）的：在刷新过程中到达的请求会把自己记为下一次运行，
 * 而不是启动第二次，循环会用最新配置再跑一遍。
 *
 * 记住的结果就是设置文档里那一份的影子：标签页报告的就是它，而真正服务请求的，是
 * 文档里已经生效的那一份。
 *
 * @module dsh-aperture/runtime
 */

import type { SettingsProvider } from '@deepseek-ai/dsh-settings';
import { fetchModelsListing } from './aperture.ts';
import { ModelCatalog, type CatalogLoad } from './catalog.ts';
import { type ResolvedConfig } from './config.ts';
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
  readonly settings: SettingsProvider;
  /** 具名 logger。 */
  readonly logger: RuntimeLogger;
  /** models.dev 缓存，在各次刷新之间共享。 */
  readonly catalog: ModelCatalog;
}

/** 单飞（single-flight）的发现与发布。 */
export class ApertureRuntime {
  private readonly deps: RuntimeDeps;
  private running: Promise<RefreshOutcome> | undefined;
  private queued: string | undefined;
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
   * 刷新；若已有刷新在运行，则把本次刷新排在其后。
   * @param trigger - 触发来源；出现在标签页的状态段里。
   * @returns 本次调用所参与的那次刷新的结果。
   */
  async refresh(trigger: string): Promise<RefreshOutcome> {
    if (this.running !== undefined) {
      this.queued = trigger;
      return this.running;
    }
    this.running = this.run(trigger);
    try {
      return await this.running;
    } finally {
      this.running = undefined;
      const queued = this.queued;
      this.queued = undefined;
      if (queued !== undefined) {
        void this.refresh(queued);
      }
    }
  }

  /** 执行一次刷新，绝不抛出异常。 */
  private async run(trigger: string): Promise<RefreshOutcome> {
    const started = Date.now();
    const at = new Date();
    try {
      return await this.execute(trigger, started, at);
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
  private async execute(trigger: string, started: number, at: Date): Promise<RefreshOutcome> {
    const config = this.deps.config();

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

    const catalog = await this.deps.catalog.load(config.modelMetadataUrl, config.timeoutMs);

    let listed: readonly unknown[];
    let endpoint: string;
    try {
      const listing = await fetchModelsListing(config.instanceRoot, { timeoutMs: config.timeoutMs });
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
        defaultContextWindow: config.defaultContextWindow,
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
      placeholderCredential: config.placeholderCredential,
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
    if (!config.sync) {
      return { applied: false, ops: 0, routes: [], reason: '同步已禁用' };
    }
    try {
      return await applySync(this.deps.settings, plan.routes, plan.ownedRoutes);
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
