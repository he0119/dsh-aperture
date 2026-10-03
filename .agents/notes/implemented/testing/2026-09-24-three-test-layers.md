# Agent Note: 三份测试各证一件不同的事

Status: implemented

## Problem

「注册出去的路由真的能说话」与「坏在哪」是两件事：端到端能证明前者，却只会告诉你「这个协议上
一个 token 都没流出来」；单元测试能指出「`toolcall_end` 的参数没串化」，却证明不了那三条路由在真
宿主里真的被解析、被派发。一份测试顶替不了另一份。

## Decision

三份，各证一件不同的事：

- **`test/live.test.ts`（端到端）**是唯一能证明「注册出去的三个路由真的按线缆协议流式说话」的
  一份。它真的 `boot()` 一个 profile 目录（`cordis.patch.yml` 里带上本插件那一行、**没有**
  `llm-pi-ai`），交给 Cordis Loader 挂起来，然后在同一个宿主里调 `ctx.llm.stream()`：文本增量要
  抵达调用方、终止原因是 `stop`、用量来自网关的 usage 块；推理档位要按 DeepSeek 方言出现在请求体
  里；Anthropic 的思考签名要经重放信封原样回到下一轮。断言的是**宿主眼里**的结果，而不是内存里拼
  出来的对象。
  它自己搭的那套里只有一个替身：`hmr`（`hmrSeam`）。真实的 HMR 要 `--expose-internals` 与
  `timer` 服务才挂得起来，而刷新必须从事务之外起跑这条规矩要靠它才是真的被测到（见
  [刷新必须从 HMR 事务之外起跑](../bug-fix/2026-09-24-refresh-starts-outside-the-hmr-transaction.md)）。
  替身只留 `runExclusive()` 的两条语义：事务里再来一次就拒绝、否则排在上一件工作后面。
  它连的网关是仓库里的 `test/fake-gateway.ts`：内核挑一个空闲端口，`/v1/models` 回一份与断言
  一一对应的固定载荷，三条推理端点各按自己的协议回答。因此这一份不依赖 Tailscale 网络，CI 里也跑
  得动。给了 `DSH_APERTURE_LIVE_URL` 时它改连真实实例，并跳过需要「网关按协议回答」的那些断言。
- **各 `src/*.ts` 的单元测试**钉的是端到端**测不到**的那些：请求头与 URL 归一化、解析失败时的
  具体原因、事件流转换的失败路径（空回答、长度截断、上下文溢出、没有终态事件）、历史重放的降级
  与损坏分支、`prepareCall` 的代际绑定、注册撞键与重试、单飞语义。
- **`test/client.test.ts`** 测的是**打包产物** `lib/client.js`（`pnpm test` 的 pretest
  会先重打一次），因为 `window.__ModuleLoader__.load` 那层包法正是要钉住的契约之一。
  它走 `test/support/mini-react`，钉住的是**接缝**（注册到哪个槽位、注入面上的名字
  与形状、effect 依赖里不许有对象、提交轮数不许自激、卸载时收不收回订阅与样式）与
  页面行为。它证明不了「官方组件长什么样」。
- **`test/manifest.test.ts`** 不属于上面三层，它不测行为、只核**声明**：拿宿主的
  `evaluatePluginCompatibility` 走一遍 `package.json` 的 peer 范围与 `engines.dsh`。

## Alternatives considered

**只留端到端。** 它能证明「真的能用」，但排障时给出的信息只有「文档里没有那一行」；
`accept` 头丢了这种缺陷要在单元测试那一层才看得见。

**端到端改连真实实例。** 那就需要网络与一台部署好的网关，CI 里跑不动；真实实例只在
手动走查（`DSH_APERTURE_LIVE_URL`）时用。

**让客户端测试只测源码。** 客户端模块系统的契约就是那份包法，测源码等于把要钉住的
东西留在测试之外。

## Consequences

- `test/fake-gateway.ts` 的固定载荷与用例是**一份契约**，改一处就要改另一处。
- `DSH_APERTURE_LIVE_URL` 给定时端到端改连真实实例，并跳过那些要求网关按协议回答的断言。
- 新断言要篡改验证：把被测行为改回去，测试必须变红。
