# Agent Note: 占位凭据

Status: implemented

## Problem

pi-ai 在既没有请求级密钥、又没有非空的 `authorization` / `x-api-key` /
`cf-aig-authorization` 头时会直接抛 `No API key for provider`，请求根本发不出去。Aperture 靠网络
身份认证，本不需要密钥，但适配器不这么认为。

## Decision

没有配 `apiKeyEnv` 的路由，按协议带一个占位请求头，让适配器愿意发请求：

- `aperture` 路由 → `authorization: Bearer dsh-aperture`
- `aperture-anthropic` 路由 → `x-api-key: dsh-aperture`

**这不是密钥**，只是一个让适配器闭嘴的字符串；实测 Aperture 对垃圾 Bearer 照常
返回 200。

## Alternatives considered

**要求用户自己填一个密钥。** 一个不需要密钥的部署被迫先编一个假密钥才能用，而
编出来的值会进设置文档、进备份、进同步。

**改 pi-ai，让它接受「没有密钥」这个状态。** 那要改的是上游的包，不是插件；而且「没有密钥」在
别的 provider 上确实是错误状态，为一家网关放宽会把校验让掉。

## Consequences

- 配置里带 `apiKeyEnv`（指向凭据 seam 里的记录）时不带占位头，真密钥照常生效。
- 占位值会随请求发到网关上，因此必须叫得像占位，不能长得像真凭据；它不落进任何配置，用户层里
  只有 `apiKeyEnv` 这个名字（见[不写任何配置](../simplification/2026-10-03-no-configuration-writes.md)）。
