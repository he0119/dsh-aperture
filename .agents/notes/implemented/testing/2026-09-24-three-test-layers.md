# Agent Note: 三份测试各证一件不同的事

Status: implemented

## Problem

「写进去的配置合法」与「坏在哪」是两件事：端到端能证明前者，却只会告诉你「文档里
没有 `llm-pi-ai` 那一行」；单元测试能指出「`accept` 头丢了」，却证明不了那份配置真的
能被宿主读进去。一份测试顶替不了另一份。

## Decision

三份，各证一件不同的事：

- **`test/live.test.ts`（端到端）**是唯一能证明「写进去的配置**合法**而不是看起来
  合理」的一份。它真的 `boot()` 一个 profile 目录（`cordis.patch.yml` 里带上本插件
  那一行），交给 Cordis Loader 挂起来，再让真的 `llm-pi-ai` 去读那份产物、把模型
  解出来。写入经 `dsh-config-editor` + `dsh-settings` 落盘，因此断言的是**落地之后**
  的文档，而不是内存里拼出来的对象。
  它自己搭的那套里只有一个替身：`hmr`（`hmrSeam`）。真实的 HMR 要
  `--expose-internals` 与 `timer` 服务才挂得起来，而它恰好决定了写入落不落得下来
  ——少了这个替身，事件里发起的那一轮刷新被事务嵌套拒绝的样子，与「写成功了只是没
  变化」在断言上分不开。替身只留 `runExclusive()` 的两条语义：事务里再来一次就
  拒绝、否则排在上一件工作后面。
  它连的网关是仓库里的 `test/fake-gateway.ts`：内核挑一个空闲端口，`/v1/models`
  回一份与断言一一对应的固定载荷。因此这一份不依赖 Tailscale 网络，CI 里也跑得动。
- **各 `src/*.ts` 的单元测试**钉的是端到端**测不到**的那些：请求头与 URL 归一化、
  解析失败时的具体原因、`planSync` 的逐条 op、单飞语义、写入被拒的分支。
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
- `DSH_APERTURE_LIVE_URL` 给定时端到端改连真实实例。
- 新断言要篡改验证：把被测行为改回去，测试必须变红。
