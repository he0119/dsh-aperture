# dsh-aperture

Discover the models an [Aperture](https://tailscale.com/kb/1542/aperture) gateway serves, and publish them to DeepSeek Harness as `llm-pi-ai` provider routes — so they simply appear in the model selector.

Once installed, one Aperture address is all you configure.

## Install

Requirements: Node ≥ 24, and an Aperture instance you can reach.

### 1. Add the plugin

From [npm](https://www.npmjs.com/package/dsh-aperture) (recommended):

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-aperture
```

The published artifact ships a compiled `lib/`, so no build script has to be authorized.

To pin a commit, or to follow unreleased changes, install from git:

```sh
npx @deepseek-ai/dsh plugin --profile web add github:he0119/dsh-aperture#<sha>
```

A git install pulls **source**, compiled by a `prepare` script during install. pnpm ≥10 refuses to run a git dependency's build scripts until it is explicitly allowed, so **the first `add` fails**: dsh prints the package key you need, which you write into the profile's `pnpm-workspace.yaml` before running `add` again.

```yaml
# ~/.dsh/profiles/web/pnpm-workspace.yaml
allowBuilds:
  dsh-aperture: true
```

(The key takes the **map** form with `true`; a list is not accepted.)

> That authorization lets this package run code on your machine at install time, outside any agent sandbox. Authorize only source you trust.

When editing the code locally, install the checkout directory instead (run `npm run build` first):

```sh
npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-aperture
```

### 2. Point it at your instance

```yaml
# ~/.dsh/settings.yaml
aperture:
  baseUrl: https://ai.example.ts.net
```

You may put this in the profile's `cordis.patch.yml` (composition layer) instead; the user layer wins.

### 3. Restart DSH

Bundle changes are not hot-reloaded. Before starting, you can look at the composed result:

```sh
npx @deepseek-ai/dsh --profile web --dump-config   # should show a "# == dsh-aperture" layer
```

### 4. Confirm

The models appear in the selector under the route `Aperture`. Check with `/aperture` (the command reports in Chinese):

```
Aperture：https://ai.example.ts.net
  最近一次刷新：配置变更 · 2026-09-22T16:31:02.184Z · 412ms · 成功
  清单：422 个条目
  端点：https://ai.example.ts.net/v1/models 列出了 16 行
  路由 aperture：11 个模型，经由 openai-completions → https://ai.example.ts.net/v1
  路由 aperture-anthropic：1 个模型，经由 anthropic-messages → https://ai.example.ts.net
  未服务：4 个模型（gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.5-pro, gemini-3.1-flash-image-preview）
  设置：向 llm-pi-ai 写入 2 个操作（aperture, aperture-anthropic）
```

## Usage

| Command | Effect |
| --- | --- |
| `/aperture` | status of the last refresh (default) |
| `/aperture models` | every model, its route, and the source of each fact |
| `/aperture refresh` | discover and republish now |
| `/aperture remove` | withdraw this plugin's routes from the `llm-pi-ai` section |

## Configuration

Every key may live in the `aperture:` section of `~/.dsh/settings.yaml` (user layer) or in the profile's `cordis.patch.yml` (composition layer).

| Key | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `''` | Aperture instance root. A trailing `/v1` is tolerated and stripped; empty leaves the plugin dormant |
| `route` | `aperture` | Route key owning OpenAI-compatible models |
| `anthropicRoute` | `aperture-anthropic` | Route key owning Anthropic Messages models |
| `displayName` | `Aperture` | Selector label |
| `anthropicDisplayName` | `Aperture (Anthropic)` | Selector label for the Anthropic route |
| `apiKeyEnv` | `''` | Credential-seam reference; non-empty suppresses the placeholder header |
| `placeholderCredential` | `dsh-aperture` | Placeholder value; `''` writes no placeholder header at all |
| `headers` | `{}` | Extra request headers; they **win over** the placeholder |
| `enabledModelIds` | `[]` | Non-empty restricts discovery to these ids (explicit `models` entries are exempt) |
| `modelAliases` | `{}` | Gateway id → models.dev id |
| `models` | `[]` | Per-model overrides and extras: `id`, `name`, `api`, `contextWindow`, `maxTokens`, `input`, `thinking`, `reasoningEfforts` |
| `modelMetadataUrl` | `https://models.dev/models.json` | Catalog URL; `''` disables enrichment |
| `defaultContextWindow` | `128000` | Context capacity when nothing sizes a model |
| `images` | `ignore` | `metadata` adopts models.dev input modalities (images) |
| `reasoning` | `auto` | `off` declares every model non-reasoning |
| `sync` | `true` | `false` discovers without writing (`/aperture` still reports) |
| `refreshIntervalMinutes` | `0` | Periodic refresh; `0` refreshes only at load and on change |
| `timeoutMs` | `20000` | Per-request timeout for the gateway and the catalog |

Missing capacity and reasoning levels are filled in from Aperture's own fields → [models.dev](https://models.dev) → a conservative default. An unstated `maxTokens` is deliberately **omitted**: in `llm-pi-ai` it is also the per-request `max_tokens` cap, so inventing a value would truncate every request.

## Troubleshooting

**The first `add` from git fails, saying build scripts were ignored?**
Add the `allowBuilds` line from the git part of step 1, then re-run — or install from npm, which needs no authorization at all.

**`Issues with peer dependencies found` during install?**
Expected. The `@deepseek-ai/cordis`, `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-settings` packages this plugin peers on ship with DSH and are resolved by DSH itself (they never enter the profile's `node_modules`), so pnpm not seeing them does not affect running the plugin.

**`Failed to resolve dependency: The filename, directory name, or volume label syntax is incorrect. (os error 123)`?**
The git spec is scp-style (`git@github.com:he0119/dsh-aperture.git`) — on Windows the colon reads as a drive letter, so it is parsed as a **local path**. Use a spec pnpm recognises: `github:he0119/dsh-aperture`, `git+https://…` or `git+ssh://…`.

**git over HTTPS is unusable on this machine (schannel / `SEC_E_NO_CREDENTIALS`)?**

```sh
git config --global url."git@github.com:".insteadOf "https://github.com/"
```

**Some models never show up in the selector?**
Look at the `未服务` line of `/aperture`. Models that only offer Gemini's native `generateContent` endpoint cannot be attached — `llm-pi-ai` speaks OpenAI-compatible and Anthropic Messages only. Using the wrong endpoint fails loudly, and Aperture names the right one:

```
404 model "gemini-2.5-flash" is available via gemini_generate_content, not openai_chat
404 model "MiniMax-M3" is available via anthropic_messages, not openai_chat
```

**Want more reasoning levels for a model?**
Only two conservative levels are offered by default (DeepSeek family `off/high/max`, every other reasoning model `off/high`). Add your own:

```yaml
aperture:
  models:
    - id: deepseek-v4-pro
      reasoningEfforts:
        off: disabled
        minimal: minimal
        low: low
        medium: medium
        high: high
        max: max
```

**Want a model the gateway did not list?**
Add it explicitly with `models` — for instance those four Gemini models, if you know they work on an OpenAI-compatible endpoint after all:

```yaml
aperture:
  models:
    - id: gemini-2.5-pro
      api: openai-completions
```

**Capacity or reasoning flags were not filled in?**
Gateways rename things, and models.dev may not match (in practice `deepseek-flash` and `k3` are `deepseek/deepseek-v4-flash` and `moonshotai/kimi-k3` there). Bridge it explicitly:

```yaml
aperture:
  modelAliases:
    deepseek-flash: deepseek/deepseek-v4-flash
    k3: moonshotai/kimi-k3
```

**`/aperture` says `设置：未写入（已处于同步状态）`?**
That is the normal steady state: the settings already hold the current catalog.

**Need a real key instead of the placeholder header?**
Aperture authenticates by network identity (Tailscale) and needs none; the plugin writes `authorization: Bearer dsh-aperture` / `x-api-key: dsh-aperture` only to make the adapter willing to send the request. It is **not a key**. When a real credential is needed, point `apiKeyEnv` at a credential-seam record and no placeholder is written.

**The old route is still there after changing `route` / `anthropicRoute`?**
The plugin only knows the two keys it currently owns, not the names it used before, so the old key stays in `llm-pi-ai.providers`. It does no harm and simply stops refreshing; delete the entry by hand to clean it up.

## What it does

```
GET {baseUrl}/v1/models
        │
        ├─ per model: supported_endpoints ──► routing
        │     /v1/chat/completions        ──► route            (openai-completions)
        │     /v1/messages                ──► anthropicRoute   (anthropic-messages)
        │     native generateContent only ──► not published (reported under 未服务)
        │
        ├─ capacity:  Aperture fields ─► models.dev ─► default
        ├─ reasoning: Aperture fields ─► models.dev ─► off
        │
        └─ llm-pi-ai providers.<route>, written to settings.yaml by revision
```

Writes touch only the two keys under `llm-pi-ai.providers` that this plugin owns: an unchanged section is not rewritten; writes are path-addressed so your hand-written providers survive untouched; a failed discovery never wipes the published catalog; a route that lost its models is removed.

Design notes — why two routes, where each fact comes from, lifecycle and dependencies, write behaviour — are in [docs/internals.md](https://github.com/he0119/dsh-aperture/blob/main/docs/internals.md) (Chinese).

## Development

```sh
npm install                # if the machine-level npm cache is not writable: npm install --cache ./.npm-cache --ignore-scripts
npm run build              # tsc -> lib/
npm run typecheck          # includes test/
npm test                   # offline unit tests (93, no node_modules needed)
npm run inspect            # print the generated settings.yaml and its resolutions

DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run test:live   # end-to-end: real harness stack + real gateway
```

> `lib/` is a build artifact: a git install and `npm publish` both compile it through the `prepare` script.
> Installing from a **local directory** (`link:`) does *not* run `prepare`, so run `npm run build` before
> debugging locally.

The release process is in [docs/releasing.md](https://github.com/he0119/dsh-aperture/blob/main/docs/releasing.md) (Chinese).

## Acknowledgements

- [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot): the reference implementation this plugin follows for Aperture model discovery.
- [Aperture](https://tailscale.com/kb/1542/aperture) (Tailscale): the gateway being discovered.
- [models.dev](https://models.dev): enriches capacity and capabilities Aperture does not declare.
- `@deepseek-ai/dsh-llm-pi-ai`: this plugin only discovers; the adapter does the protocol work.

## License

MIT
