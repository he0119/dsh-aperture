# Agent Note: 占位凭据

Status: implemented

## Problem

`llm-pi-ai`（更准确地说，它背后的 pi-ai）在没有密钥时会直接抛
`No API key for provider`，请求根本发不出去。Aperture 靠网络身份认证，本不需要
密钥，但适配器不这么认为。

## Decision

默认写入一个占位请求头，让适配器愿意发请求：

- `aperture` 路由 → `authorization: Bearer dsh-aperture`
- `aperture-anthropic` 路由 → `x-api-key: dsh-aperture`

**这不是密钥**，只是一个让适配器闭嘴的字符串；实测 Aperture 对垃圾 Bearer 照常
返回 200。

## Alternatives considered

**要求用户自己填一个密钥。** 一个不需要密钥的部署被迫先编一个假密钥才能用，而
编出来的值会进设置文档、进备份、进同步。

**改 `llm-pi-ai`，让它接受「没有密钥」这个状态。** 那要改的是宿主的包，不是插件；
而且「没有密钥」在别的 provider 上确实是错误状态，为一家网关放宽会把校验让掉。

## Consequences

- 配置里带 `apiKeyEnv`（指向凭据 seam 里的记录）时不写占位头，真密钥照常生效。
- 占位值出现在用户看得见的配置里，因此必须叫得像占位，不能长得像真凭据。
