# Agent Note: 容量与能力的来源优先级

Status: implemented

## Problem

一个模型的上下文容量、最大输出、模态与推理能力有三个可能来源：网关的探测结果、
`models.dev` 目录、以及插件自己。三者常常只声明了一部分，而注册出去的路由每一条事实都会被 pi-ai
当成真的用。

## Decision

每类事实按固定顺序取第一个有声明的一方：

| 事实 | 优先级 |
| --- | --- |
| `contextWindow` | Aperture `context_window_tokens` / `max_input_tokens` / `limit.context` → models.dev → 兜底常量 128000 |
| `maxTokens` | Aperture `max_output_tokens` / `limit.output` → models.dev → **不写** |
| `input`（多模态） | `images: metadata` 时取 Aperture 能力字段 → models.dev → `["text"]`；`images: ignore` 时恒为 `["text"]` |
| `reasoning` | Aperture 能力字段 → models.dev → 关闭 |

`maxTokens` 没人声明时**不向宿主声明默认值**（`resolveModel` 的 `defaultMaxTokens` 缺席）：它是
「输出能力」，也是每次请求的 `max_tokens` 上限，凭空编一个 16384 会把每一次请求都截断。pi-ai 侧
的描述符仍需要一个数，那用的是 `DEFAULT_MAX_TOKENS`，只是它不冒充发现结果。

网关会改名。实测里 `deepseek-flash`、`k3` 在 models.dev 上找不到对应条目（那边叫
`deepseek/deepseek-v4-flash`、`moonshotai/kimi-k3`），靠打分是猜不出来的，于是提供
显式映射（`modelAliases`）；映射之后这两个模型才会拿到 models.dev 的推理标记与容量。

## Alternatives considered

**按相似度打分匹配 models.dev 条目。** 猜错一个 id 的后果是把另一个模型的容量写进
这个模型，而用户看不出这份事实是猜的；显式映射至少能被审阅、被撤销。

**缺省值一律编一个。** `maxTokens` 的缺省值会变成硬上限，`contextWindow` 的缺省值
要么截断要么谎报；不写交给下游按自己的默认处理更诚实。

**只信 models.dev，不看网关声明。** 网关知道自己这一份部署的真实上限（尤其是被
代理过的端点），目录只是公共信息。

## Consequences

- models.dev 拉不到就是拉不到：发现本身照常成功，只是少一份补全。
- 报告要能说出每条事实来自哪里，因此优先级链的每一步都得记录下来，而不是只留
  最终值。
