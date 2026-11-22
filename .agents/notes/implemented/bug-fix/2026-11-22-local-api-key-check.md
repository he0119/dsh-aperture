# Agent Note: 密钥可用性判定留在本插件里

Status: implemented

## Problem

`@deepseek-ai/dsh-llm` 在 0.2.3-alpha.1 删掉了 `assertUsableApiKey`（同一版还删了
`normalizeApiKey`），官方迁移指南说改用 `@deepseek-ai/dsh-credentials` 的 `normalizeApiKey`。
可是本插件还要装在 0.1.7 与 0.2.0 的宿主上，那两版的 `dsh-credentials` 只有 `credentialRef` 与
`isCredentialRefName`，没有这个导出。于是无论从哪个包导入，总有一条支持的宿主线在模块加载阶段
就抛 `SyntaxError`，整行插件被跳过——界面上什么也不出现，只有一行诊断。

## Decision

判定改为本模块的 `usableApiKey`（`src/provider.ts`）：去掉首尾空白后，空串与含 HTTP 头不能携带
的字符（可见 ASCII 之外）都抛 `LlmError('INVALID_CREDENTIAL')`，诊断点名凭据引用而不回显密钥。
不再从宿主导入这份判定。

## Alternatives considered

**从 `@deepseek-ai/dsh-credentials` 导入 `normalizeApiKey`。** 0.1.7 与 0.2.0 的
`dsh-credentials` 没有这个导出，插件在那两条线上会整行加载失败，等于把一处坏法换成另一处。

**继续用 `@deepseek-ai/dsh-llm` 的 `assertUsableApiKey`。** 0.2.3-alpha.1 起没有这个导出，
本插件在 alpha 宿主上加载即失败（实测：`does not provide an export named 'assertUsableApiKey'`）。

**不检查，直接发请求。** 带换行或非 ASCII 的密钥会让请求头构造抛 `ByteString` 的 `TypeError`，
被适配器当成「连不上网关」，把一次确定的本地配置错误说成网络问题。

## Consequences

- 判定语义与 0.2.0 的 `assertUsableApiKey` 一致：只 trim，空值与非法字符都在发请求前拒绝。
- 上游再改这份合法字符集时，本插件不会自动跟随；要改就改 `LEGAL_API_KEY` 一条正则。
- `test/provider.test.ts` 分别钉住 trim、空白值、含空白/换行/非 ASCII/DEL 的拒绝；
  失败的诊断必须点名凭据引用。
- devDependencies 跟到 0.2.3-alpha.2：同一版还改了图片请求目标、`ProfileContext` 的 overlay
  字段与兼容预检的读取顺序，那些迁移在同一次改动里跟上，本笔记只记这一项。
