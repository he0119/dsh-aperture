# Agent Note: settings 是硬依赖，typert 只用于界面

Status: implemented

## Problem

插件的产出是一份写进设置的配置，因此它和 `settings` 的关系不是「用得上就用」；
另外两件接线是可选的：配置页要用 Typert Remote，定时刷新需要一个可回收的注册点。

## Decision

- `inject = ['settings']` 是**硬依赖**：没有它，发布对象根本不存在。宁可让框架把
  插件挂在 `PENDING`、provider 被替换时自动卸载、恢复后重新加载，也不留一个无处
  发布的实例。（`settings` 本身要求 `configEditor` 与 `profileContext`，因此这一层
  依赖等于说「这个部署得有一个可管理的 profile」。）
- `typert` **不声明**，也只用于界面：配置页需要的三个端点（报告、立刻刷新、按行
  编辑）经 Typert Remote 暴露，而 Typert 注册表只有 Web 这类装配了网关的 profile
  才有。headless profile 里这一整块被跳过，发现照常运行。
- 定时刷新用 `ctx.effect` 注册，卸载自动清理。
- **第一次发现不靠注册动作触发**：`aperture:` 这一段由 profile 的补丁层给出（本包
  组合层 + 用户层），插件挂载时读到的已经是叠加后的结果，不必为了对齐两份配置再刷
  一遍。

## Alternatives considered

**把 `settings` 写成可选依赖，运行时探测。** 没有 settings 的部署里插件能挂上，但
它唯一的工作就是写设置；挂上只会多一个永远不工作的空壳。

**声明 `typert` 并在没有网关时降级。** headless / SDK 这类 profile 里根本没有
Typert 注册表，声明它等于让整个插件加载失败，而发现本来是可以照常跑的。

**在挂载时主动跑一轮发现。** 挂载时读到的配置已经是叠加后的结果，再刷一遍只是把
同一份配置算两次；真正需要刷新的时机是配置变化，那由 Loader 的事件通知。

## Consequences

- 没有 Typert 的 profile 里插件照常发现，只是没有可点按的界面（见
  [已知边界](../../../../docs/internals.md)）。
- `settings` 被替换或卸载时插件跟着卸载，而不是留着一个发布了却没处落的实例。
