# dsh-aperture

Discover the models an [Aperture](https://tailscale.com/kb/1542/aperture) gateway serves, and publish them to DeepSeek Harness as `llm-pi-ai` provider routes — so they simply appear in the model selector. Once installed, one Aperture address is all you configure.

## Install

Requirements: Node ^22.19.0 or ≥24.0.0 (matching DSH), and an Aperture instance you can reach.

### 1. Add the plugin

From [npm](https://www.npmjs.com/package/dsh-aperture) (recommended):

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-aperture
```

The published artifact ships a compiled `lib/`, so no build script has to be authorized. To pin a commit, or to follow unreleased changes, install from git:

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
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    baseUrl: https://ai.example.ts.net
```

This layer (the profile patch document, i.e. the user layer) is this plugin's settings namespace, `aperture`. Patch layers **replace the whole row** rather than deep-merging — this row's `config` supersedes the `cordis.patch.yml` this package ships (the composition layer) outright, and since the composition row only declares the row and writes no `config`, what you write is all there is; every key's default lives in the schema, so keys you leave out fall back to the defaults. You can also fill it in from the GUI: on the **Plugins** page open this package, and the first field of its configuration page ("Instance address") writes the same `aperture.baseUrl`; saving lands in the same file.

### 3. Restart DSH

Bundle changes are not hot-reloaded. Before starting, you can look at the composed result:

```sh
npx @deepseek-ai/dsh --profile web --dump-config   # should show a "# == dsh-aperture" layer
```

### 4. Confirm

The models appear in the selector under the route `Aperture`. This package's configuration page at **Plugins → dsh-aperture** is that page — the instance address and sync toggle on top, one row per discovered model below.

```
Instance address  Overridden  Reset to default
[https://ai.example.ts.net                            ]
Where Aperture listens; leave it empty to go dormant and stop discovering models.

Sync automatically                 Overridden  Reset to default   ●━
After each discovery round, write the models into dsh's llm-pi-ai routes.  [Save]

Saved: rediscovered and published.

Models 18                                     ⟳ Refresh now
One model per row; expand a row to edit its overrides, and Save writes only that row. The order comes from discovery, with anything no route can serve last.

● deepseek-v4-flash
  route aperture · protocol openai-completions · context 1,048,576 · output 384,000 · modalities text+image · reasoning on · 1 overridden
● gemini-2.5-flash
  route aperture · protocol openai-completions · context 128,000 · modalities text · reasoning off
● qwen3-vl-32b  unserved
  context 262,144 · modalities text+image · reasoning on

  (expand a row and you get that row's override editor: name and protocol in one group, capacity in another,
   modalities beside reasoning, and Save / Clear overrides / Cancel underneath)
```

**The instance address and the sync toggle** are two fields of one official settings form: where a field says "Overridden", a "Reset to default" right beside it drops that key from your settings file (the same two words in the same position as the official plugin-config page), and Save writes only the fields you actually changed. The per-model override editor is covered under [Usage](#usage). Headings and spacing separate the groups, while a model row is a card (a hairline outline with a large radius, coloured only with theme tokens this page really defines), and the only thing you can expand is a model row.

(English labels are shown above; the page itself is bilingual.)

## Usage

The interface is at **Plugins → dsh-aperture**: open this plugin in the plugin list; the configuration page hangs off the package, so there is no separate Configure button. The page header's name, icon and description come from the package's `locale/*.json` and `package.json`'s `icon`; the page itself is drawn by the Plugins page. The address, the toggle and the per-model parameters stay drafts until you press Save; models are **one row at a time**, and collapsing a row does not throw its draft away — the "unsaved edits" tag stays visible.

| Where | Effect |
| --- | --- |
| Configuration page · Instance address | edits `baseUrl` (written through the settings seam; when it says "Overridden", the "Reset to default" beside it falls back to the default) |
| Configuration page · Sync toggle | edits `sync`: off discovers without writing `llm-pi-ai`, and that round withdraws whatever this plugin had published (only the three keys it owns; every other provider in the section is left alone); carries the same "Overridden / Reset to default" pair |
| Configuration page · Save | below the form: writes the address and toggle drafts into the settings document; it is revision-fenced, so a form that has drifted from the settings document is refused rather than overwriting someone else's edit; it returns only once that round of re-discovery has landed, so the interface shows the new configuration right away |
| Configuration page · Models | one row per model, one card per row: a state dot at its head (green: this round wrote it into the routes; grey: this round synced but did not write it; amber: no route can serve it — hovering it, or a screen reader, hears exactly that), then the name with its "unserved / N overridden / unsaved edits" tags on the first line and labelled facts (route, protocol, capacities, modalities, reasoning, alias) on the second, with long names ellipsised and facts wrapping; expanded, it is that row's override editor — display name, alias and protocol as one group of text fields, context window and max output as the "capacity" group, and two modality checkboxes beside a three-way reasoning switch (follow discovery / on / off); a field keeps only one line naming where its value comes from ("Source: Aperture"), while how-to copy ("Leave it empty to use the discovered name") lives behind the "i" next to the label and only takes up room once opened; the "Refresh now" action at its top right discovers and republishes immediately, and the list and every row's status follow that round |
| Configuration page · Save / Clear overrides / Cancel | write that row only, clear only the fields the backend report says really were overridden, or drop that row's draft; Save likewise waits for a round of re-discovery, so what you see afterwards is the new value |

In-place edits are configuration: capacities and modalities land on the matching `aperture.models` entry, the catalog alias lands on `aperture.modelAliases[id]`, and writes merge per field — a field the interface never mentions (say `reasoningEfforts`) survives untouched, while an emptied field drops that override and falls back to discovery and the catalog. Capacities accept the `1M` / `100K` spelling (decimal suffixes, the same vocabulary as the official Models page: `1M` is 1000000, not 1048576); what gets stored is still a plain token count, and the field spells it back in the shortest form that survives a round trip (`384000` → `384K`, while `1048576` is not a whole thousand and stays written out). The protocol field is the only way out for an unserved model: filling it in publishes a model that only answers on its native endpoint under the matching route.

## Configuration

Every key lives under that row's `config:` in the profile patch document (user layer); anything you leave out falls back to the defaults below. `baseUrl`, `sync` and the per-model parameters inside `models` and `modelAliases` can also be edited in place on the configuration page; every other key needs the file.

| Key | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `''` | Aperture instance root. A trailing `/v1` is tolerated and stripped; empty leaves the plugin dormant |
| `route` | `aperture` | Route key for Chat Completions models; Responses and Anthropic append `-responses` and `-anthropic`, with all three selector labels derived from it |
| `apiKeyEnv` | `''` | Credential-seam reference; non-empty suppresses the placeholder header |
| `headers` | `{}` | Extra request headers; they **win over** the placeholder |
| `enabledModelIds` | `[]` | Non-empty restricts discovery to these ids (explicit `models` entries are exempt) |
| `modelAliases` | `{}` | Gateway id → models.dev id |
| `models` | `[]` | Per-model overrides and extras: `id`, `name`, `api`, `contextWindow`, `maxTokens`, `input`, `thinking`, `reasoningEfforts` |
| `modelMetadataUrl` | `https://models.dev/models.json` | Catalog URL; `''` disables enrichment |
| `images` | `ignore` | `metadata` adopts models.dev input modalities (images) |
| `reasoning` | `auto` | `off` declares every model non-reasoning |
| `sync` | `true` | `false` discovers without writing (the configuration page still reports) |
| `refreshIntervalMinutes` | `0` | Periodic refresh; `0` refreshes only at load and on change |

Missing capacity and reasoning levels are filled in from Aperture's own fields → [models.dev](https://models.dev) → a conservative default (the fallback capacity, 128000, and the 20s per-request timeout are constants in the code, not configuration). An unstated `maxTokens` is deliberately **omitted**: in `llm-pi-ai` it is also the per-request `max_tokens` cap, so inventing a value would truncate every request.

## Troubleshooting

**The first `add` from git fails, saying build scripts were ignored?** Add the `allowBuilds` line from the git part of step 1, then re-run — or install from npm, which needs no authorization at all.

**`Issues with peer dependencies found` during install?** Expected: the `@deepseek-ai/cordis`, `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-settings` packages this plugin peers on ship with DSH and are resolved by DSH itself (they never enter the profile's `node_modules`), so pnpm not seeing them does not affect running the plugin.

**`Failed to resolve dependency: The filename, directory name, or volume label syntax is incorrect. (os error 123)`?** The git spec is scp-style (`git@github.com:he0119/dsh-aperture.git`) — on Windows the colon reads as a drive letter, so it is parsed as a **local path**. Use a spec pnpm recognises: `github:he0119/dsh-aperture`, `git+https://…` or `git+ssh://…`.

**git over HTTPS is unusable on this machine (schannel / `SEC_E_NO_CREDENTIALS`)?**

```sh
git config --global url."git@github.com:".insteadOf "https://github.com/"
```

**Some models never show up in the selector?** Look at the rows tagged `未服务` (unserved) in the Models section of the configuration page. Models that only offer Gemini's native `generateContent` endpoint cannot be attached — this plugin can publish Chat Completions, OpenAI Responses, and Anthropic Messages, but does not translate Gemini's native protocol. Using the wrong endpoint fails loudly, and Aperture names the right one:

```
404 model "gemini-2.5-flash" is available via gemini_generate_content, not openai_chat
404 model "MiniMax-M3" is available via anthropic_messages, not openai_chat
```

**Want more reasoning levels for a model?** Only two conservative levels are offered by default (DeepSeek family `off/high/max`, every other reasoning model `off/high`). Add your own:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
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

**Want a model the gateway did not list?** Add it explicitly with `models` — for instance those four Gemini models, if you know they work on an OpenAI-compatible endpoint after all:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    models:
      - id: gemini-2.5-pro
        api: openai-completions
```

**Capacity or reasoning flags were not filled in?** Gateways rename things, and models.dev may not match (in practice `deepseek-flash` and `k3` are `deepseek/deepseek-v4-flash` and `moonshotai/kimi-k3` there). Bridge it explicitly:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    modelAliases:
      deepseek-flash: deepseek/deepseek-v4-flash
      k3: moonshotai/kimi-k3
```

**The configuration page says `设置：未写入（已处于同步状态）`?** That is the normal steady state: the settings already hold the current catalog.

**Saved but not in effect?** DSH's patch layers stack: above the profile patch document sit higher-priority layers such as `$DSH_HOME/cordis.patch.yml`. If the `aperture` row is written there too, a save from the configuration page lands in the profile patch document but is shadowed by that layer (the settings service may also refuse the write outright, in which case the page says so). Delete the row from the higher-priority layer, or edit it there instead.

**Upgrading from 0.2 — where did my `settings.yaml` go?** As of 0.1.7 settings no longer live in a file of their own; they live in the profile patch document. On the first start `$DSH_HOME/settings.yaml` is renamed to `settings.yaml.imported` and each section is moved into the patch document under its settings namespace — the `aperture:` section moves as-is, and every key and value that still passes the schema is unchanged, so the address and the per-model overrides are all still there. From then on only the patch document is read, and `settings.yaml.imported` is just an archive; editing it does nothing. A section whose values no longer validate stays in that archive too, with a line in the log saying so.

**No Plugins page / no GUI in this deployment?** The configuration page only exists in the Web GUI (it works over Typert Remote endpoints). A headless profile still discovers and still writes, it just has no clickable page. If the deployment has no manageable profile at all, the `settings` service does not exist and the plugin stays `PENDING` on its hard dependency — its only job is writing settings, so with nowhere to write it deliberately does nothing.

**Need a real key instead of the placeholder header?** Aperture authenticates by network identity (Tailscale) and needs none; the plugin writes `authorization: Bearer dsh-aperture` / `x-api-key: dsh-aperture` only to make the adapter willing to send the request. It is **not a key**. When a real credential is needed, point `apiKeyEnv` at a credential-seam record and no placeholder is written.

**The old route is still there after changing `route`?** The plugin only knows the three keys it currently owns (`route`, `route` + `-responses`, and `route` + `-anthropic`), not the names it used before, so the old key stays in `llm-pi-ai.providers`. It does no harm and simply stops refreshing; delete the entry by hand to clean it up.

## What it does

```
GET {baseUrl}/v1/models
        │
        ├─ per model: supported_endpoints ──► routing
        │     /v1/chat/completions        ──► route                (openai-completions)
        │     /v1/responses               ──► route + -responses   (openai-responses)
        │     /v1/messages                ──► route + -anthropic   (anthropic-messages)
        │     native generateContent only ──► not published (reported under 未服务)
        │
        ├─ capacity:  Aperture fields ─► models.dev ─► default
        ├─ reasoning: Aperture fields ─► models.dev ─► off
        │
        └─ llm-pi-ai providers.<route>, written into the profile patch document by revision
```

Writes touch only the three keys under `llm-pi-ai.providers` that this plugin owns: an unchanged section is not rewritten; writes are path-addressed so your hand-written providers survive untouched; a failed discovery never wipes the published catalog; a route that lost its models is removed. Design notes — protocol routing, where each fact comes from, lifecycle and dependencies, write behaviour — are in [docs/internals.md](https://github.com/he0119/dsh-aperture/blob/main/docs/internals.md) (Chinese).

## Development

```sh
npm install
npm run build      # tsdown -> lib/index.js + lib/types/index.d.ts + lib/client.js
npm test           # unit tests + end-to-end (offline; devDependencies must be installed)
```

Working on the plugin — build, tests, and a dedicated development instance — is in [docs/development.md](https://github.com/he0119/dsh-aperture/blob/main/docs/development.md) (Chinese); the release process and what the published package contains are in [docs/releasing.md](https://github.com/he0119/dsh-aperture/blob/main/docs/releasing.md) (Chinese).

## Acknowledgements

- [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot): the reference implementation this plugin follows for Aperture model discovery.
- [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup): the reference implementation this plugin follows for the interface wiring — the Remote endpoint shape comes from it, while the way the configuration page is mounted now comes from the Plugins page's slot contract as of 0.1.7.
- [Aperture](https://tailscale.com/kb/1542/aperture) (Tailscale): the gateway being discovered.
- [models.dev](https://models.dev): enriches capacity and capabilities Aperture does not declare.
- `@deepseek-ai/dsh-llm-pi-ai`: this plugin only discovers; the adapter does the protocol work.

## License

MIT
