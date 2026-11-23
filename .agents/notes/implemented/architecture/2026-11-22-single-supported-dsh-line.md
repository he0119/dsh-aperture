# Agent Note: 只支持一条 DSH 版本线

Status: implemented

## Problem

上游的 alpha 线在短时间内改了几处本插件用到的接缝：图片请求目标把 `maxBytes` 拆成
`maxImageBytes` 与 `imageTargetBytes`，`ProfileContext` 把 `overlays` 换成 `overlayPaths`，
兼容预检改为先读 `engines.dsh`，消息侧的密钥判定则整块从 `dsh-llm` 移到 `dsh-credentials`。
要让 0.1.7、0.2.0 与 alpha 三条线共存，每一处都得按能力探测或各抄一份，再在真宿主上各验一遍；
而 `latest` 停在 0.1.7 之后，老线上的用户已经不再是升级动机。

## Decision

支持线只留 `^0.2.3-alpha.2`：`engines.dsh`、每个 DSH 的 peer 范围与 `devDependencies` 三者
写同一条线。更老的宿主在预检处被拒，不再为它们保留分支或复制实现。

## Alternatives considered

**维持三条线的并集。** 每处变化都要同时写两套实现（密钥判定是现成的例子：alpha 删了
`dsh-llm` 的导出，老宿主又没有 `dsh-credentials` 的替代），测试与真机验证的成本随线数增长。

**只收窄 `engines.dsh`、peer 范围不动。** 预检先读 `engines.dsh`，peer 会退化成一份没人读的
声明；而 `devDependencies` 已经升到 alpha，声明与装着的东西对不上。

**继续用 `^0.2.0-rc.1` 并靠预发布参与范围的规则。** 这条规则确实让 alpha 落进范围，
但它没有说清本仓库要盯哪一版；`0.2.2` 与 `0.2.3-alpha.1` 也一并被放进来。

## Consequences

- 装到 0.2.2 及更早的宿主上会被预检拒掉，诊断点名 `engines.dsh`，不再是静默失败。
- 与 [peer 范围是一条并集](2026-09-28-peer-range-is-a-union.md) 相反：那份并集不再适用；
  拒绝记录读 `requirements`、预检先读 `engines.dsh` 这两条仍然成立。
- 下次升支持线时，`test/manifest.test.ts` 的 `OUTSIDE` 名单与 `devDependencies` 要一起改；
  两份声明任何一份漏改，用例会红。
