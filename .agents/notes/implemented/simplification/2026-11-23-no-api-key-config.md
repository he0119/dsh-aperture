# Agent Note: 不提供密钥配置

Status: implemented

## Problem

Aperture 靠网络身份（Tailscale）认证，网关不校验密钥。`apiKeyEnv` 却把「按请求从凭据接缝解析
密钥」这条路留在配置里：它带来一份 schema 声明、一条对 `ctx.credentials` 的依赖、一组必须写
测试的拒绝路径，还要在宿主升级删掉密钥判定导出时跟着迁移。没有部署需要它。

## Decision

删除 `apiKeyEnv`：配置 schema、解析结果、路由事实与适配器里都不再有凭据引用这一项，
`@deepseek-ai/dsh-credentials` 也不在本包的 peer 与 devDependencies 里。请求一律按协议带占位
凭据；网关真要静态令牌时，用 `headers` 写死 `authorization` 或 `x-api-key`。

## Alternatives considered

**保留 `apiKeyEnv` 作为可选能力。** 它只服务「网关要求真密钥」这一种部署，而那种部署用
`headers` 也能过——令牌明确写在配置里，与占位凭据走同一条头路径，不必多一个服务依赖与一条
拒绝分支。

**保留配置项、静默忽略。** 设置段的值会流到别的插件，留一个不再生效的键只会让人以为它有用。

## Consequences

- 配置键少一项。写过 `apiKeyEnv` 的部署升级后该项被 schema 忽略，路由改带占位凭据；需要令牌的
  改用 `headers`。
- 占位凭据与 `headers` 的优先级不变，见
  [占位凭据](../architecture/2026-09-23-placeholder-credential-header.md)。
- 升级 dsh 0.2.3-alpha 时不再需要跟着迁移密钥判定（那一版删掉了 `dsh-llm` 的相关导出）；
  那段历史见 [未设置的凭据引用是缺失](../bug-fix/2026-10-08-unset-credential-ref-is-absent.md)。
