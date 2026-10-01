# Agent Note: 端点描述符手写，线格式只有一层直通

Status: implemented

## Problem

Typert Remote 的端点描述符本来由生成器产出，而那个生成器并不随 DSH 发布，因此两端
都得手写。问题是要手写到什么程度：描述符里有一套 wire 编解码器，看起来该逐字段校验。

实际上不该。注册表（`@deepseek-ai/dsh-typert-registry`）只检查 `mode` 是 `strict`、
`typeSymbol` 非空、`create` 是个函数；网关客户端只读参数上的 `mode` 与结果上可选的
`decode` / `encode`，**没有一处调用 `create()`**。逐字段手写一套 wire 校验因此永远
不会执行，而且会踩到注册表的真实形状：它要的是 `create` 工厂，`schema` 字段不被
承认，于是 `$mount` 抛 `strict codec has no create() factory`、**整份**贡献被拒，
浏览器里只留一行 `console.error`，界面安静地什么都不出现。

## Decision

Host 端用 `src-json` 编解码器；Web Client 端只需要一个**直通**的 strict 编解码器
（`{ parse: (value) => value }`）——Web Client 从不解析这些值，它只是把参数转发回去。

参数名与顺序就是 Host 方法的形参表：调用点按位置传参，网关按 `wire` 映射，并且自动
省掉 `undefined` 实参（`if (value !== void 0) args[parameter.wire] = value`），所以
「没提到的参数」天然就是「不碰」。

## Alternatives considered

**逐字段手写 wire 校验（文法式编解码器）。** 三百行文法换来的是一次都不会执行的
校验，还顺手把整份贡献挡在门外——被拒的是整份注册，不是某一个端点。

**给两端各写一套校验。** 两端共用同一份线格式，而 Web Client 端没有解析需求；
多写一套只会多一处能与 Host 端不一致的地方。

## Consequences

- `test/client.test.ts` 把描述符的键集（`create` / `mode` / `typeSymbol`）与工厂
  一起钉住，并断言 Web Client 端的端点集合、id 与参数名跟 Host 端完全一致。
- 端点名另有一条约束，见
  [端点名不得与 RemoteNamespaceService 的保留成员重名](../bug-fix/2026-09-23-reserved-remote-endpoint-names.md)。
