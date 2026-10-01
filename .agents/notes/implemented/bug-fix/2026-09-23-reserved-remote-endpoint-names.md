# Agent Note: 端点名不得与 RemoteNamespaceService 的保留成员重名

Status: implemented

## Problem

api-gateway 在客户端给每个命名空间建一个 `RemoteNamespaceService`，端点会成为它的
属性。因此端点与它自己的成员重名时，`validateContribution` 会拒绝**整份**贡献——
浏览器里只留一行 `console.error`，界面安静地什么都不出现。

## Decision

新端点起名时先对一遍那份名单：`ctx` / `empty` / `invokeRemote` / `methods` / `name` /
`namespace` / `has` / `install` / `installDirect` / `installScoped` /
`assertMethodAvailable` / `remove`。`test/client.test.ts` 把名单抄成了护栏，改端点时
由它先红。

## Alternatives considered

**给端点名统一加前缀规避。** 前缀只降低撞名概率，不构成保证；名单是封闭的，直接对
一遍更便宜，而且撞名的代价是整份贡献被拒，不是某一个端点失效。

**靠挂载时的异常提示。** 被拒的是整份贡献，插件自己拿不到那份错误——浏览器里只有
一行 `console.error`，界面上没有任何东西可提示。

## Consequences

- 这条失败是静默的，因此只能靠测试而不是靠界面上看得见的表现。
- 名单来自宿主的实现而不是文档，宿主加成员时本仓库的护栏要跟着更新。
