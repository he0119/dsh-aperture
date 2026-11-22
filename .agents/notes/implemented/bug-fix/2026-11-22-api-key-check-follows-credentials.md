# Agent Note: 密钥判定跟随 dsh-credentials

Status: implemented

## Problem

`@deepseek-ai/dsh-llm` 从 0.2.3-alpha.1 起不再导出 `assertUsableApiKey`（同一版还删了
`normalizeApiKey`）。本插件原先在模块顶层 import 它，于是插件在 alpha 宿主上加载即失败：
`does not provide an export named 'assertUsableApiKey'`，整行插件被跳过，界面上什么也不出现。
官方迁移指南给出的替代是 `@deepseek-ai/dsh-credentials` 的 `normalizeApiKey`。

## Decision

判定改用 `@deepseek-ai/dsh-credentials` 的 `normalizeApiKey`；`src/provider.ts` 的
`usableApiKey` 只负责把结论翻译成本插件的诊断：点名凭据引用、不回显密钥，并以
`LlmError('INVALID_CREDENTIAL')` 在发请求之前失败。

## Alternatives considered

**在本仓库抄一份判定。** 上游只在两个原因码上分叉（空白与非法字符），抄一份的代价不大，
但字符集是宿主定的：它一改，本插件要么跟着改，要么把一次可解释的本地错误交给 `fetch`。
支持线收窄到一条之后，这份复制没有换来任何兼容性。

**继续从 `@deepseek-ai/dsh-llm` 导入。** 支持的那一版里已经没有这个导出，加载即失败。

**不检查，直接发请求。** 带换行或非 ASCII 的密钥会让请求头构造抛 `ByteString` 的 `TypeError`，
被适配器当成「连不上网关」，把一次确定的本地配置错误说成网络问题。

## Consequences

- 判定的字符集与诊断原因跟着宿主走；本插件只决定措辞与错误码。
- `test/provider.test.ts` 分别钉住 trim、空白值、含空白/换行/非 ASCII/DEL 的拒绝，
  并要求两种原因的措辞能分开——只断言「抛了」的话，删掉空白分支也照样绿。
- 支持线只有 `^0.2.3-alpha.2`（见 [只支持一条 DSH 版本线]
  (../architecture/2026-11-22-single-supported-dsh-line.md)）。
