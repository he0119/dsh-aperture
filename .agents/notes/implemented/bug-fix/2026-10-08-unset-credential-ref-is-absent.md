# Agent Note: 未设置的凭据引用是缺失，不是空串

Status: implemented

## Problem

`aperture` 设置段的 `value` 会整份流到别的插件那里：设置服务 `describe()` 交出去的是 schema
校验后的值，而 `apiKeyEnv` 的 schema 默认值是空串。于是任何消费这份值的一方看到的都是「这里有
一个字符串」，而不是「这里没有凭据引用」——空串不是一个引用名，凭据接缝的文法是
`^[A-Za-z_][A-Za-z0-9_]*$`。

代价实测在 Desktop 的欢迎流程上：它把 `llm.listConfigurableProviders()` 每一行的
`settingsNs` / `settingsPath` 解析成设置段的值，**只判类型**（`typeof value.apiKeyEnv ===
'string'`）就把这个字符串收进一次批量查询。`credentials.describe` 的 `refs` 里因此混进一个空
串，整批被判 `gateway/bad-request`（应答 `{"ok":false,...}`）；而欢迎流程把任何一次非 ok 的
RPC 升级成启动期致命错误，Desktop 直接弹「应用无法启动」的恢复对话框。行里填没填 `baseUrl`
与这件事无关：只要本插件的设置命名空间在，`apiKeyEnv` 就在，默认值会把它补出来。

浏览器侧看不见这个问题：官方「模型」页取引用时要求非空（为空则退回派生名
`<PROVIDER>_API_KEY`），而且凭据读取失败只让徽标降级，不让页面失败。

## Decision

`apiKeyEnv` 不再有默认值，并声明成一个凭据引用：

- `Config` 里写 `apiKeyEnv: z.string().role('credential-ref')`：不写这一项时，设置段的值里
  **没有这个键**（schema 不会凭空造出一个空串），写过什么就原样是什么；
- 角色与官方两个 provider 的写法一致（`llm-pi-ai` 的 `providers.*.apiKeyEnv`、
  `llm-deepseek` 的 `apiKeyEnv`），在设置 schema 的线上形态里表现为 `"role":"credential-ref"`；
- 「空白算未设置」这条语义留在 `resolveConfig` 里（空串、纯空白 → `undefined`），发布出去
  的路由照旧带占位凭据（见[占位凭据](../architecture/2026-09-23-placeholder-credential-header.md)）。

## Alternatives considered

**保留空串默认值，只等上游改那条判据。** 上游迟早会补长度校验，但本插件暴露出去的仍然是一个
非法引用名：任何按字符串取值的消费者都会重新踩一遍，而他们的发布节奏不由本仓库掌握。

**用 `z.transform` 把空白规一化成 `undefined`。** 这样连显式写下的 `apiKeyEnv: ''` 也一并兜
住，但会给设置 schema 引入本仓库第一处 `transform` 节点——线上 22 个设置命名空间里一个都没
有，浏览器侧 rehydrate 这条路径本仓库没有实测覆盖，风险大于收益。显式空串的暴露留给上游的
`length > 0` 那条判据。

**把空串当成合法的「不带凭据」。** 那正是缺陷本身：接缝的引用文法不接受它，消费方也无从知道
这个空串是「没有」还是「写错了」。

## Consequences

- 裸行解析出来的键集少一项：`apiKeyEnv` 只在真的写过时才出现。`test/config.test.ts` 同时钉住
  「没有默认值」与「角色是 `credential-ref`」两条声明，改回空串默认值就会变红。
- 显式写下 `apiKeyEnv: ''` 的配置不受这次改动保护：设置段的值仍然带着那个空串，遇到只判类型的
  消费者照样被拒；按 README 这类配置应当整项删掉。
- Desktop 欢迎流程那条判据该补长度校验，凭据读取失败也不该是启动期致命错误——那是上游的事，
  本仓库只保证自己不再生产非法引用名。
