/**
 * 标签页与宿主之间的 Typert Remote 面：`aperturePanel` 命名空间。
 *
 * 描述符是手工登记的，因为生成它们的 Typert 生成器并不随 DSH 发布，而这一步的规范本身
 * 很小：宿主半边用 `src-json` 编解码器，浏览器半边带 strict 校验，两端共享同一组端点名。
 * 参数按描述符里的顺序位置传入宿主方法，因此两边的名字与顺序必须一致。
 *
 * 端点 id 的 `#` 之前是包名，之后是 `<命名空间>/<方法>`；这与网关、注册表和客户端三方
 * 共用的文法一致。
 *
 * @module dsh-aperture/remote
 */

import type { Context } from '@deepseek-ai/cordis';
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import type { PanelAction, PanelConfiguration, PanelModelPatch, PanelOps } from './panel.ts';
import type { PanelReport } from './report.ts';

/** 包名，同时是端点 id 的前缀。 */
export const PANEL_PACKAGE = 'dsh-aperture';

/** 线上命名空间，也是浏览器半边注入的服务名（`remote.aperturePanel`）。 */
export const PANEL_NAMESPACE = 'aperturePanel';

/**
 * 一个端点的宿主侧调用描述符。
 *
 * @param method - 端点方法名，同时也是宿主服务上的方法名。
 * @param parameters - 参数名，按宿主方法的形参顺序；省略即无参数。
 * @returns 一个结果为 JSON 的直调描述符。
 */
function panelDescriptor(method: string, parameters: readonly string[] = []): InvocationDescriptor {
  return {
    id: `${PANEL_PACKAGE}#${PANEL_NAMESPACE}/${method}`,
    service: PANEL_NAMESPACE,
    namespace: PANEL_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map((name) => ({ name, wire: name, source: 'json' as const, codec: { mode: 'src-json' as const } })),
    result: { mode: 'src-json' },
  };
}

/**
 * 本插件暴露给浏览器的全部端点。
 *
 * 端点名有一处不显眼的约束：api-gateway 在客户端为每个命名空间建一个
 * `RemoteNamespaceService`，端点会成为它的属性，因此与它自己的成员重名会被
 * `validateContribution` 拒绝，**整份贡献一起撤回**（浏览器里只剩一行 console.error，
 * 界面安静地什么都不出现）。它预置的名字是 `ctx` / `empty` / `invokeRemote` / `methods`
 * / `name` / `namespace` 与 `has` / `install` / `installDirect` / `installScoped` /
 * `assertMethodAvailable` / `remove` —— 「撤下路由」因此叫 `withdraw` 而不是 `remove`。
 */
export const PANEL_INVOCATIONS: readonly InvocationDescriptor[] = [
  panelDescriptor('status'),
  panelDescriptor('refresh'),
  panelDescriptor('withdraw'),
  panelDescriptor('configuration'),
  panelDescriptor('save', ['baseUrl', 'sync']),
  panelDescriptor('edit', ['id', 'patch']),
];

/**
 * 登记进 Typert 注册表的贡献。
 *
 * `schemas`/`model` 是生成器的产物，这里没有生成器，因此它们如实为空：本插件不导出可
 * 复用的 schema，也没有需要反射的业务类型。端点本身仍然完整——宿主注册 `src-json`、浏览器
 * 带 strict 校验，两者按同一份契约工作。
 */
export const PANEL_CONTRIBUTION: TypertContribution = {
  package: PANEL_PACKAGE,
  face: 'host',
  schemas: [],
  invocations: PANEL_INVOCATIONS,
  model: { services: [], events: [], objects: [] },
};

/**
 * `aperturePanel` 宿主服务：方法与描述符一一对应，实现全部委托给 {@link PanelOps}。
 *
 * 方法签名必须与描述符的参数顺序一致——`save` 的两个形参名字与描述符里的两个参数同名，
 * 顺序也相同，网关就是按描述符顺序把 wire 参数位置传入的。
 */
export class AperturePanelService extends TypertRemoteService {
  private readonly ops: PanelOps;

  /**
   * @param ctx - 挂载上下文。
   * @param ops - 端点实现。
   */
  constructor(ctx: Context, ops: PanelOps) {
    super(ctx, PANEL_NAMESPACE);
    this.ops = ops;
  }

  /** 最近一次刷新的报告。 */
  status(): PanelReport {
    return this.ops.status();
  }

  /** 立刻重新发现并发布。 */
  refresh(): Promise<PanelAction> {
    return this.ops.refresh();
  }

  /** 撤下本插件发布的路由。方法名受端点名约束，见 {@link PANEL_INVOCATIONS}。 */
  withdraw(): Promise<PanelAction> {
    return this.ops.withdraw();
  }

  /** 标签页表单要显示的配置。 */
  configuration(): PanelConfiguration {
    return this.ops.configuration();
  }

  /**
   * 写入配置。
   *
   * @param baseUrl - 新地址；`null` 恢复默认，`undefined` 不碰。
   * @param sync - 新开关；`null` 恢复默认，`undefined` 不碰。
   * @returns 成败与一句人话。
   */
  save(baseUrl: string | null | undefined, sync: boolean | null | undefined): Promise<PanelAction> {
    return this.ops.save(baseUrl, sync);
  }

  /**
   * 写入一个模型的参数。
   *
   * @param id - 模型 id。
   * @param patch - 要改的字段；`null` 表示撤销这个模型的全部覆盖。
   * @returns 成败与一句人话。
   */
  edit(id: string, patch: PanelModelPatch | null): Promise<PanelAction> {
    return this.ops.edit(id, patch);
  }
}
