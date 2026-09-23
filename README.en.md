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

After a restart you can also set it in the GUI: the **Aperture** tab under **Settings → Plugins** (alongside "Plugin configuration"). Its "实例地址" field edits the same `aperture.baseUrl`.

### 3. Restart DSH

Bundle changes are not hot-reloaded. Before starting, you can look at the composed result:

```sh
npx @deepseek-ai/dsh --profile web --dump-config   # should show a "# == dsh-aperture" layer
```

### 4. Confirm

The models appear in the selector under the route `Aperture`. To see what the last refresh did, look at the **Aperture** tab under **Settings → Plugins**: the status block lays every fact out on its own row, and the models are listed per route underneath.

```
Last refresh
  Trigger  配置变更          Time    2026-09-23 12:32:36
  Took     286ms             Result  succeeded
  Catalog  422 entries       Endpoint  https://ai.example.ts.net/v1/models listed 16 rows
  Settings wrote 2 operations to llm-pi-ai (aperture, aperture-anthropic)

Models and routes           1 models overridden, the rest inherit discovery and the catalog
  aperture · openai-completions
  → https://ai.example.ts.net/v1 · 11 models
    deepseek-v4-flash  DeepSeek V4 Flash  overridden           [▾ Collapse]
      1,048,576 context window · 384,000 output · text+image · reasoning
      │ deepseek-v4-flash · aperture · openai-completions
      │ Display name  [DeepSeek V4 Flash           ]  from models.dev
      │ Catalog alias [deepseek/deepseek-v4-flash]
      │ Context       [1048576]  in effect 1,048,576 · from aperture
      │ Max output    [384000]   in effect 384,000 · from aperture
      │ Modalities    ☑ text ☑ image   in effect text+image · from config
      │ Reasoning     [follow discovery ▾]  in effect on · from models.dev
      │ Protocol      [follow discovery ▾]  in effect openai-completions
      │ An empty display name, capacity or modality drops that override…  [Reset override] [Cancel] [Save]
    gemini-2.5-flash                                          [▸ Edit]
      128,000 context window · text · no reasoning
  Unserved: no endpoint this plugin can publish
  4 models
    gemini-2.5-flash-lite                                     [▸ Edit]
      Advertised endpoints: /v1beta/models/gemini-2.5-flash-lite:generateContent
```

Collapsed, each row is just the facts (model id and the values in effect); "Edit" expands the panel, where every source sits next to the field it describes ("in effect 1,048,576 · from aperture"). Each row gets its own Save and Cancel: Save writes that row only, Cancel throws that row's edits away.

(The tab itself is bilingual; the labels above are its English wording.) Next to it are the buttons that edit the address, refresh now, and withdraw the routes.

## Usage

The interface is the **Aperture** tab under **Settings → Plugins**: it shows your instance address and what the last refresh did, lists the discovered models per route, and lets you edit the address, toggle `sync`, discover and republish now, withdraw the published routes from the `llm-pi-ai` section, and edit model parameters in place. The address and the toggle stay drafts until you press Save; the save is handed to the host half, which writes through the settings seam, so it is revision-fenced — a form that has drifted from the settings document is refused rather than overwriting someone else's edit. Model parameters work the same way, **one row at a time**: an expanded row edits a draft (the row shows an "unsaved" tag), Save writes that row only, and Cancel drops it. There is no batch edit.

| Where | Effect |
| --- | --- |
| Tab · 状态 | what the last refresh did, what triggered it, and the catalog, endpoint and settings-write results |
| Tab · 实例地址 | edits `baseUrl` (written through the settings seam, with an "overridden" badge and reset-to-composition) |
| Tab · 同步开关 | edits `sync`: off discovers without writing `llm-pi-ai` |
| Tab · 保存 | writes the address and toggle drafts into the settings document |
| Tab · 立即刷新 | discover and republish now, then show that round's report |
| Tab · 撤掉已发布的路由 | withdraw this plugin's two routes from the `llm-pi-ai` section |
| Tab · 模型与路由 | which route every model belongs to, and the values in effect |
| Tab · 编辑 | expands one model's parameters: display name, catalog alias, capacities, modalities, reasoning, protocol, each source next to the field it describes |
| Tab · 保存 / 取消 | write that row only, or throw that row's edits away |
| Tab · 撤销覆盖 | clear only the fields the report says really were overridden, falling back to discovery and the catalog right away |

In-place edits are configuration: capacities and modalities land on the matching `aperture.models` entry, the catalog alias lands on `aperture.modelAliases[id]`, and writes merge per field — a field the interface never mentions (say `reasoningEfforts`) survives untouched, while an emptied field drops that override and falls back to discovery and the catalog. The protocol field is the only way out for an unserved model: filling it in publishes a model that only answers on its native endpoint under the matching route.

> "撤掉已发布的路由" withdraws once: the next refresh republishes according to the current configuration. To make it stick, turn the sync toggle off first (equivalent to `sync: false`).

## Configuration

Every key may live in the `aperture:` section of `~/.dsh/settings.yaml` (user layer) or in the profile's `cordis.patch.yml` (composition layer). `baseUrl` and `sync` can also be edited on the GUI's Aperture tab, and so can the per-model parameters inside `models` and `modelAliases`; every other key needs the file.

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
| `sync` | `true` | `false` discovers without writing (the tab still reports) |
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
Look at 模型与路由 on the tab (the `未服务` line). Models that only offer Gemini's native `generateContent` endpoint cannot be attached — `llm-pi-ai` speaks OpenAI-compatible and Anthropic Messages only. Using the wrong endpoint fails loudly, and Aperture names the right one:

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

**The tab says `设置：未写入（已处于同步状态）`?**
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
npm run typecheck          # includes test/, and parses the browser half with node --check
npm test                   # offline unit tests (119; devDependencies must be installed)
npm run inspect            # print the generated settings.yaml and its resolutions

DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run test:live   # end-to-end: real harness stack + real gateway
```

The release process and what the published package contains are in [docs/releasing.md](https://github.com/he0119/dsh-aperture/blob/main/docs/releasing.md) (Chinese).

## Acknowledgements

- [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot): the reference implementation this plugin follows for Aperture model discovery.
- [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup): the reference implementation this plugin follows for the interface wiring — the settings-tab registration and the Remote endpoint shape both come from it.
- [Aperture](https://tailscale.com/kb/1542/aperture) (Tailscale): the gateway being discovered.
- [models.dev](https://models.dev): enriches capacity and capabilities Aperture does not declare.
- `@deepseek-ai/dsh-llm-pi-ai`: this plugin only discovers; the adapter does the protocol work.

## License

MIT
