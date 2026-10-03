/**
 * 注册阶段：把一代路由交给宿主的 LLM 接缝。
 *
 * 本模块**不写任何配置**。更早的版本把自己的路由写进另一个插件的配置段，现在这条能力整块拿掉：
 * 配置只由用户与官方界面写，本插件只读。代价是遗留写入不会自动消失——它正好占着本插件要用的
 * 路由键，于是注册被拒。这时本模块不去替用户清理，而是把「哪个键挡住了、去哪删」写进报告，
 * 界面上直接可读；用户删掉之后下一次 `llm/adapters-updated` 就会把注册补上。
 *
 * 注册本身只有两条性质需要照顾：首次注册用 `registerAdapter`（空数组会被拒），之后用句柄的
 * `replace`，于是刷新不会让请求观察到「路由消失」的空档；注册失败不会把整轮刷新判为失败——
 * 发现与报告仍然有结果，用户看到的是「哪条路由没上去、为什么」。
 *
 * @module dsh-aperture/provider
 */

import {
  LlmError,
  assertUsableApiKey,
  type AdapterRegistrationHandle,
  type DirectoryRegistrationHandle,
  type LlmConfigurableProvider,
  type LlmRuntime,
} from '@deepseek-ai/dsh-llm';
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { ApertureAdapter } from './adapter/index.ts';
import { APERTURE_NAMESPACE } from './config.ts';
import type { PlannedRoute, ProviderRoute, RoutePlan } from './plan.ts';
import type { RuntimeLogger } from './runtime.ts';

/** 一次发布的结果。 */
export interface PublishOutcome {
  /** 已注册的路由键；注册未成功时为空。 */
  readonly routes: readonly string[];
  /** 未能注册时，给用户看的原因与要做的事。 */
  readonly reason?: string;
}

/** 注册层需要的外部事实。 */
export interface ProviderDeps {
  /** LLM 服务。 */
  readonly llm: LlmRuntime;
  /** 凭据服务；未挂载时为缺失。 */
  readonly credentials: () => CredentialProvider | undefined;
  /** 附件服务；没有它的部署里图片不可转换。 */
  readonly attachments: () => AttachmentStore | undefined;
  /** 诊断。 */
  readonly logger: RuntimeLogger;
}

/**
 * 本插件的 provider 身份。
 *
 * 一个实例跨代复用同一个适配器对象，只替换它的路由集合。
 */
export class ApertureProvider {
  private readonly adapter: ApertureAdapter;
  /** 外部事实；显式字段而非参数属性，理由见 `ApertureAdapter`。 */
  private readonly deps: ProviderDeps;
  private registration: AdapterRegistrationHandle | undefined;
  private directory: DirectoryRegistrationHandle | undefined;
  /** 当前这一代适配器服务的路由。 */
  private routes: readonly PlannedRoute[] = [];
  /** 最近一次想要服务的路由键；冲突重试要用它。 */
  private desired: readonly string[] = [];
  /** 最近一次注册被谁挡住了；没有冲突时为 `undefined`。 */
  private blocked: readonly string[] | undefined;

  constructor(deps: ProviderDeps) {
    this.deps = deps;
    this.adapter = new ApertureAdapter({
      routes: () => this.routes,
      resolveApiKey: (provider, profile) => this.resolveApiKey(provider, profile),
      attachments: () => this.deps.attachments(),
      logger: this.deps.logger,
    });
  }

  /**
   * 发布一代方案。
   *
   * @param plan - 本次要服务的路由与未被服务的模型。
   * @returns 发生了什么。
   */
  async publish(plan: RoutePlan): Promise<PublishOutcome> {
    this.routes = plan.routes;
    this.desired = plan.routes.map((route) => route.route.id);
    this.registerRoutes();
    this.registerDirectory(plan.routes);

    return {
      routes: this.registration === undefined ? [] : this.desired,
      ...(this.blocked === undefined ? {} : { reason: this.conflictReason(this.blocked) }),
    };
  }

  /**
   * 冲突之后重试注册。
   *
   * 由 `llm/adapters-updated` 触发：挡住本插件的那一方可能刚刚把自己撤下（例如用户照报告删掉了
   * 遗留配置）。没有冲突时是空操作，因此本插件自己的注册所触发的那次事件不会变成自激循环。
   *
   * @returns 这一轮之后是否已注册。
   */
  retry(): boolean {
    if (this.blocked === undefined) return this.registration !== undefined;
    this.registerRoutes();
    return this.blocked === undefined && this.registration !== undefined;
  }

  /** 撤下本插件的全部注册。 */
  dispose(): void {
    this.registration?.();
    this.registration = undefined;
    this.directory?.();
    this.directory = undefined;
  }

  /** 首次注册或原子替换路由。 */
  private registerRoutes(): void {
    if (this.desired.length === 0) {
      // 没有要服务的路由：首次不注册（接缝拒绝空数组），已注册的把路由集合换成空。
      if (this.registration !== undefined) {
        this.registration.replace([]);
      }
      this.blocked = undefined;
      return;
    }

    // 先问一次谁占着这些键。接缝自己也会拒（`DUPLICATE_ADAPTER`），但它只给出路由名；这里的
    // 检查让报告能说出「去哪删」这件事，而用户要做的恰好就是那一步。
    const taken = new Set(this.deps.llm.listProviders().map((provider) => provider.id));
    const blocked = this.registration === undefined
      ? this.desired.filter((route) => taken.has(route))
      : [];
    if (blocked.length > 0) {
      this.blocked = blocked;
      this.deps.logger.warn('dsh-aperture: 路由 %s 已被别的适配器占用；已跳过注册', blocked.join('、'));
      return;
    }

    try {
      if (this.registration === undefined) {
        this.registration = this.deps.llm.registerAdapter([...this.desired], this.adapter);
      } else {
        this.registration.replace([...this.desired]);
      }
      this.blocked = undefined;
    } catch (error) {
      this.blocked = [...this.desired];
      this.deps.logger.warn(
        'dsh-aperture: 路由注册失败：%s',
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * 声明本插件的路由可以由哪个配置段激活。
   *
   * 声明让官方「模型」页把本插件的路由列成行，并读出它们的凭据引用。那个页面只为
   * `llm-deepseek` 与 `llm-pi-ai` 准备了编辑布局，因此落到本插件的命名空间时会显示「其余字段在
   * cordis.patch.yml 中」的提示并禁用保存——本插件的配置面是自己的插件页。
   *
   * 只声明**真的有模型**的那些路由：一种协议在这个网关上没有模型时，那一行只会是多出来的空行
   * （该协议下没有任何可选的东西），而它在这里也声明不了任何事实——本插件不写配置。
   */
  private registerDirectory(routes: readonly PlannedRoute[]): void {
    if (routes.length === 0) {
      // 没有要服务的路由：首次不注册（接缝拒绝空数组），已注册的把目录清空。
      this.directory?.replace([]);
      return;
    }
    const entries: LlmConfigurableProvider[] = routes.map((route) => ({
      provider: route.route.id,
      displayName: route.provider.displayName,
      settingsNs: APERTURE_NAMESPACE,
      settingsPath: [],
      declared: true,
    }));
    try {
      if (this.directory === undefined) {
        this.directory = this.deps.llm.registerConfigurableProviders(entries);
      } else {
        this.directory.replace(entries);
      }
    } catch (error) {
      this.deps.logger.warn(
        'dsh-aperture: provider 目录注册失败：%s',
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** 给用户看的冲突说明：点名被占用的键，并说清要手工做什么。 */
  private conflictReason(blocked: readonly string[]): string {
    return `路由 ${blocked.join('、')} 已被另一个适配器注册；本插件不写配置，`
      + '请手工处理：旧版本曾把本插件的路由写进 llm-pi-ai.providers，'
      + `删掉那里的 ${blocked.join(' / ')} 键即可；若那个路由名是别的插件在用的，`
      + '请把本插件配置里的 routePrefix 改成另一个名字（三条路由键一起变）。';
  }

  /**
   * 解析一条路由的凭据。
   *
   * 配置了 `apiKeyEnv` 就**必须**解析出可用的值：那是一个明确的声明，悄悄退回占位凭据会让
   * 一次配错了密钥的部署看起来像一次网关拒绝。
   */
  private async resolveApiKey(provider: string, route: ProviderRoute): Promise<string | undefined> {
    const ref = route.apiKeyEnv;
    if (ref === undefined) return undefined;
    const credentials = this.deps.credentials();
    const resolved = credentials === undefined
      ? process.env[ref]
      : (await credentials.resolve(credentialRef(ref)))?.value;
    if (resolved !== undefined && resolved.length > 0) {
      return assertUsableApiKey(resolved, 'dsh-aperture', ref);
    }
    throw new LlmError(
      `dsh-aperture: 路由 "${provider}" 的 apiKeyEnv 指向 ${ref}，但它没有值；`
      + `请通过凭据服务存入 ${ref}（模型页可写入），或在启动环境里导出它`,
      'MISSING_CREDENTIAL',
    );
  }
}
