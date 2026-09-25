/**
 * `aperturePanel` 这个 Remote 贡献的**浏览器侧描述符**，以及它在客户端的类型形状。
 *
 * 生成描述符的 Typert 生成器不随 DSH 发布，因此两半边都手写（见 docs/internals.md）：宿主用
 * `src-json` 编解码器，这里只给一个**直通**的 strict 编解码器——浏览器侧从不解析这些值，注册表
 * 只检查 `mode` 与 `create()`，网关只读 `mode`。
 *
 * 文件末尾那处 `declare module` 是把生成器本该产出的东西手写一份：`TypertRemoteMap` 是拍平的
 * `<命名空间>/<方法>` 键，`TypertRemoteNamespaceMap` 是命名空间到方法表的映射，客户端
 * `ctx.remote.<命名空间>` 与 `ctx.inject(['remote.<命名空间>'])` 都读它。接口名沿用生成器那套
 * 十六进制后缀（`aperturePanel` 的 ASCII）；将来真引入生成器时，删掉这一段换成它生成的文件。
 *
 * @module dsh-aperture/client/remote
 */

import type { InvocationDescriptor, RemoteResult, TypertCodec, TypertRemoteContribution, TypertSchema } from '@deepseek-ai/dsh-typert-protocol';
import type { PanelAction, PanelModelPatch } from '../panel.ts';
import type { PanelReport } from '../report.ts';

/** 包名，取自 package.json；它同时是包级配置页的键、Remote 贡献名与样式归属的前半截。 */
export const PACKAGE = 'dsh-aperture';
/** 宿主半边的 Remote 命名空间（`src/remote.ts`）。 */
export const PANEL = 'aperturePanel';

/**
 * 浏览器半边与宿主半边之间的线格式。
 *
 * 只有一个直通编解码器，因为浏览器侧从不解析这些值：注册表（`@deepseek-ai/dsh-typert-registry`）
 * 只检查 `mode` 是 `strict`、`typeSymbol` 非空、`create` 是个函数，网关客户端只读参数上的
 * `mode` 与结果上可选的 `decode`/`encode`，**没有一处调用 `create()`**，逐字段手写的 wire 校验
 * 因此永远不会执行。曾经那 300 行文法还埋了个雷：注册表要的是 `create` 工厂，`schema` 字段不被
 * 承认，于是 `$mount` 抛 `strict codec has no create() factory`，整份贡献被拒，界面安静地什么
 * 都不出现。
 *
 * 端点名不能与命名空间服务自己的成员重名：api-gateway 为每个命名空间建的
 * `RemoteNamespaceService` 会把端点收成自己的属性，撞上 `remove` / `has` / `install` / `name` /
 * `ctx` 这类预置名字时校验会拒绝**整份**贡献。
 */
const SCHEMA: TypertSchema = Object.freeze({ parse: (value: unknown) => value });
const CODEC: TypertCodec = Object.freeze({
  mode: 'strict',
  typeSymbol: `${PACKAGE}/types#any`,
  create: () => SCHEMA,
});

/**
 * 一个端点的浏览器侧描述符。
 *
 * 参数按宿主方法的形参顺序给出；调用点按位置传参，网关按 `wire` 映射，并且**自动省掉
 * `undefined` 实参**（`if (value !== void 0) args[parameter.wire] = value`），所以「没提到的
 * 参数」天然就是「不碰」。
 *
 * @param {Array<string>} parameters - 参数名，顺序与宿主方法一致。
 */
function descriptor(method: string, parameters: readonly string[] = []): InvocationDescriptor {
  return Object.freeze({
    id: `${PACKAGE}#${PANEL}/${method}`,
    service: PANEL,
    namespace: PANEL,
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze(parameters.map((name) => Object.freeze({
      name,
      wire: name,
      source: 'json',
      codec: CODEC,
    }))),
    result: CODEC,
  });
}

/** 与宿主半边 `PANEL_INVOCATIONS` 一一对应的贡献（按官方的 `TypertRemoteContribution` 校验）。 */
export const REMOTE: TypertRemoteContribution = Object.freeze({
  package: PACKAGE,
  descriptors: Object.freeze([
    descriptor('status'),
    descriptor('refresh'),
    descriptor('edit', ['id', 'patch']),
  ]),
});


/**
 * `aperturePanel` 这个命名空间在**客户端**的形状。
 *
 * 官方这块是 Typert 生成器从宿主 FaceModel 生成的（`*.typert.remote-client.d.ts`），而生成器不随
 * DSH 发布，描述符因此两边都手写（见 docs/internals.md）。这一段就是把生成器本该产出的东西手写
 * 一份：`TypertRemoteMap` 是拍平的 `<命名空间>/<方法>` 键，`TypertRemoteNamespaceMap` 是命名空间
 * 到方法表的映射，客户端 `ctx.remote.<命名空间>` 与 `ctx.inject(['remote.<命名空间>'])` 都读它。
 * 接口名沿用生成器那套十六进制后缀（`aperturePanel` 的 ASCII），将来真引入生成器时，删掉这一段
 * 换成它生成的文件即可。
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$617065727475726550616e656c {
    status: () => Promise<RemoteResult<PanelReport>>;
    refresh: () => Promise<RemoteResult<PanelAction>>;
    edit: (id: string, patch: PanelModelPatch | null) => Promise<RemoteResult<PanelAction>>;
  }
  interface TypertRemoteMap {
    'aperturePanel/status': () => Promise<RemoteResult<PanelReport>>;
    'aperturePanel/refresh': () => Promise<RemoteResult<PanelAction>>;
    'aperturePanel/edit': (id: string, patch: PanelModelPatch | null) => Promise<RemoteResult<PanelAction>>;
  }
  interface TypertRemoteNamespaceMap {
    'aperturePanel': TypertRemoteNamespace$617065727475726550616e656c;
  }
}
