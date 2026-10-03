# Agent Note: 三条路由的名字都写出自己的协议

Status: implemented

## Problem

本插件注册给 dsh 的每一条路由只讲一种线缆协议，路由名因此是用户在「设置 → 模型」页与模型选择器
上分辨它们的唯一线索。原来的命名是「一个前缀加两条后缀」：Chat Completions 那条直接叫 `aperture`，
另两条叫 `aperture-responses` 与 `aperture-anthropic`。三条既不成套也不自解释——光看 `aperture`
分不出它收的是 Chat Completions 还是别的东西，而后两条一条说协议不说厂牌、一条说厂牌不说协议。配置
里那个可写键叫 `route`，读起来像「那一条路由」，实际却是三条路由的共同前缀。

同一个概念还混用两个词：配置字段、编辑补丁与报告里叫 `api`，模型事实与类型里叫 `protocol`。发布
方案那一层的名字又撞上了 dsh 的「profile」——`RouteProfile` / `ProfilePlan` 与 profile 补丁文档
同名不同物。

## Decision

三条路由的名字是同一件事的两种写法，都由前缀与**协议的产品名**推出来：显示名是前缀的标题写法加产品
名，路由键是前缀加同一串产品名的小写连字符写法。产品名逐字取官方「模型」页给这三个协议用的名字——
那一页用产品名显示协议、用 schema 标识符存储，本插件跟着它写：

| 路由键 | 协议 | 显示名 |
| --- | --- | --- |
| `aperture-openai-chat-completions` | `openai-completions` | `Aperture (OpenAI Chat Completions)` |
| `aperture-openai-responses` | `openai-responses` | `Aperture (OpenAI Responses)` |
| `aperture-anthropic-messages` | `anthropic-messages` | `Aperture (Anthropic Messages)` |

厂牌每条都写：三条里有两条是 OpenAI 的协议，只给其中一条写 `openai`，名字看着就不像一套。官方那条
`openai-completions` 的产品名是 `OpenAI Chat Completions` 而不是 `OpenAI Completions`，路由键照
产品名写，于是「选择器上看到的」与「报告里写出的路由键」是同一串字。

- 配置里的 `route` 改叫 `routePrefix`：它的语义就是前缀，三条路由键与三个显示名都由它推出来。
- 模型行那个协议下拉改用同一套产品名显示，存的值仍是 schema 标识符（`openai-completions` 等）——
  这与官方那一页的分工一致，界面上的词与路由名因此是一套。
- 命名只有一处实现：`src/routes.ts` 的 `resolveRoutes` 出三条 `ResolvedRoute`（协议、产品名、
  路由键、显示名），后缀由产品名现算（`OpenAI Chat Completions` → `openai-chat-completions`），
  因此路由键与显示名对不上是不可能的。配置、发布方案、适配器与报告都从它取词，谁都不再自己拼字符
  串；发布方案按协议归拢模型（`src/plan.ts` 的 `planRoutes`），三条路由不再各写一段分支。
- 协议统一叫 `protocol`：`models[].protocol`、编辑补丁里的 `protocol`、报告里的
  `routes[].protocol` 与 `ProviderRoute.protocol` 都指向 pi-ai 的协议名；`api` 这个词只留在
  pi-ai 自己的模型描述符里（那是它的字段名，不是我们的词汇）。
- 发布方案那一层不再叫 profile：`src/profile.ts` → `src/plan.ts`，`RouteProfile` →
  `ProviderRoute`，`RoutePlan` → `PlannedRoute`，`ProfilePlan` → `RoutePlan`，`ProfileOptions` →
  `RoutePlanOptions`，`buildProfilePlan` → `planRoutes`。`profile` 在本仓库里只指 dsh 的 profile
  补丁文档。

## Alternatives considered

- **后缀只写协议、不写厂牌**（`aperture-chat-completions` / `-responses` / `-messages`）：与官方
  产品名差一个厂牌，而三条里两条同为 OpenAI 协议，只有一条写 `openai` ——名字仍不成套。
- **后缀只写特征词**（`aperture-chat` / `aperture-responses` / `aperture-messages`）：路由键短，
  但 `aperture-chat` 与显示名 `Aperture (OpenAI Chat Completions)` 不是同一串字——同一条路由在报告
  里与在选择器上各有一个名字，用户得自己去对应。
- **后缀取 schema 标识符**（`aperture-openai-completions` / `-openai-responses` /
  `-anthropic-messages`）：与 `models[].protocol` 的取值逐字一致，但官方给第一条的产品名是
  OpenAI Chat Completions，路由键与显示名于是各写一半。
- **后缀只写 schema 标识符的最后一段**（`aperture-completions` / `-responses` / `-messages`）：
  `completions` 在 OpenAI 的词汇里也指旧的 `/v1/completions`，而这条路由收的是
  `/v1/chat/completions`。
- **不用前缀，三个键各写各的**（`routes: { chat, responses, messages }`）：一眼看全，但改名要改三
  处，而三个值之间可以互相矛盾——那正是前缀推导要避免的事。
- **保留裸前缀当 Chat Completions 的路由键**（`aperture` / `aperture-openai-responses` /
  `aperture-anthropic-messages`）：改动最小，但三条名字仍不成套，第一条依旧不说协议。
- **保留 `api` 这个词、只统一路由名**：模型行的事实、配置字段与报告字段会继续一半叫 `api` 一半叫
  `protocol`，而这种两词一义正是这次要收拾的东西。

## Consequences

- **破坏性**：路由键从 `aperture` / `aperture-responses` / `aperture-anthropic` 换成
  `aperture-openai-chat-completions` / `aperture-openai-responses` / `aperture-anthropic-messages`；
  配置键 `route` 换成 `routePrefix`，`models[].api` 换成 `models[].protocol`。写死过旧路由名的部署
  要跟着改。
- 模型选择器里那条路由的显示名从 `Aperture (Chat Completions)` 变成
  `Aperture (OpenAI Chat Completions)`，模型行的协议下拉从 schema 标识符改显示产品名（写进配置的
  值不变，仍是标识符）。排版、配色与其余文案没有变化；`tests 284 / pass 284 / fail 0 / skipped 0`。
- 0.2 及更早写进 `llm-pi-ai.providers` 的遗留键因此一个都不与现在的路由键同名：注册不会撞键，
  也就没有任何一行会提醒用户去清理。那三个键留着只会让 `llm-pi-ai` 继续服务一份过期的路由（选择
  器里出现重复模型），因此 README 的升级问答直接让人把它们一并删掉——靠命名去认遗留配置这件事，
  本来就只在名字没变时成立。
- 报告与目录行的字段跟着改名（`routes[].id`、`routes[].protocol`）；三条路由的协议在
  `test/live.test.ts` 里仍按真实线缆各走一遍，路径就是新路由键。
