# dsh-aperture

Discover the models an [Aperture](https://tailscale.com/kb/1542/aperture) gateway serves and, by the endpoint each one answers on, register them as this plugin's own provider routes in DeepSeek Harness — so they simply appear in the model selector. Once installed, one Aperture address is all you configure.

## Install

Requirements: Node ^22.19.0 or ≥24.0.0 (matching DSH), and an Aperture instance you can reach.

### 1. Add the plugin

```sh
# npm (recommended): the published artifact ships a compiled lib/, so no build script has to be authorized
npx @deepseek-ai/dsh plugin --profile web add dsh-aperture

# git: pulls source, compiled by a prepare script during install; pins a commit
npx @deepseek-ai/dsh plugin --profile web add github:he0119/dsh-aperture#<sha>

# a local checkout: run pnpm run build first
npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-aperture
```

pnpm ≥10 refuses to run a git dependency's build scripts, so the git line **fails the first time**: dsh prints the package key you need, which you write into the profile's `pnpm-workspace.yaml` before running it again (the key takes the **map** form with `true`).

```yaml
# ~/.dsh/profiles/web/pnpm-workspace.yaml
allowBuilds:
  dsh-aperture: true
```

> That authorization lets this package run code on your machine at install time, outside any agent sandbox. Authorize only source you trust.

### 2. Point it at your instance

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    baseUrl: https://ai.example.ts.net
```

This row is the plugin's settings namespace, `aperture`. Patch layers **replace the whole row** rather than deep-merging: what you write is all there is, and keys you leave out fall back to the schema's defaults. You can also fill it in from the GUI: on the **Plugins** page open this package, and its "Instance address" writes the same `aperture.baseUrl`; saving lands in the same file.

### 3. Restart DSH

Bundle changes are not hot-reloaded. Before starting, you can look at the composed result:

```sh
npx @deepseek-ai/dsh --profile web --dump-config   # should show a "# == dsh-aperture" layer
```

### 4. Confirm

The models appear in the selector under the route `Aperture`. The interface lives in two places:

- **Plugins → dsh-aperture**: the instance address, the registration toggle and "Refresh now". The settings page hangs off the package, so there is no separate Configure button.
- **Settings → Models**: every route this plugin registers is one row on that page, and the row carries a **collapsed** model list — unfold it to get the models that route really serves and the per-model override editor (display name, catalog alias, protocol, capacity, input types, reasoning). Models no route can serve take up no seat there; the Plugins page says one sentence about them: how many, which ones, and where to give them a protocol.

How the interface is laid out, and where each limit comes from, is in [docs/internals.md](https://github.com/he0119/dsh-aperture/blob/main/docs/internals.md) (Chinese).

## Usage

The address, the toggle and the per-model parameters stay drafts until you press Save; models are **one row at a time**, and collapsing a row does not throw its draft away.

- **Plugins page · instance address and registration toggle**: Save writes only the fields you actually changed, and a form that has drifted from the settings document is refused rather than overwriting someone else's edit; where a field says "overridden", the "Reset to default" beside it drops that key from your settings file (the same two words in the same position as the official plugin-config page).
- **Plugins page · Refresh now**: writes no settings and simply runs one round of discovery and registration; success, or the reason it failed, lands on the same page.
- **Plugins page · registration toggle**: off discovers without registering — that round withdraws the three routes this plugin had registered, while routes of the same name registered elsewhere are left alone.
- **Models page · Save / Clear overrides / Cancel**: write that row only; clear only the fields the backend report says really were overridden; or drop that row's draft. Save likewise waits for a round of re-discovery, so what you see afterwards is the new value.
- **Capacities**: accept the `1M` / `100K` spelling (decimal suffixes: `1M` is 1000000, not 1048576); an emptied field drops that override and falls back to discovery and the catalog.

In-place edits are configuration: capacities and input types land on the matching `aperture.models` entry, the catalog alias lands on `aperture.modelAliases[id]`, and writes merge per field — a field the interface never mentions (say `reasoningEfforts`) survives untouched.

## Configuration

Every key lives under that row's `config:` in the profile patch document; anything you leave out falls back to the defaults below. `baseUrl` and `sync` can be edited in place on the Plugins page, and the per-model parameters inside `models` and `modelAliases` on the Settings → Models page; every other key needs the file.

| Key | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `''` | Aperture instance root. A trailing `/v1` is tolerated and stripped; empty leaves the plugin dormant (no discovery, no registration) |
| `routePrefix` | `aperture` | Common prefix of the three route names: a route key is the prefix plus its protocol name in lowercase with dashes (`aperture-openai-chat-completions`, `aperture-openai-responses`, `aperture-anthropic-messages`), and the three selector labels come from the same prefix, spelling out the official Models page's product names for the protocols word for word: `Aperture (OpenAI Chat Completions)`, `Aperture (OpenAI Responses)`, `Aperture (Anthropic Messages)` |
| `apiKeyEnv` | `''` | Credential-seam reference; non-empty stops sending the placeholder credential |
| `headers` | `{}` | Extra request headers; on a name collision the **attribution header** and the **placeholder credential** are still filled in per protocol |
| `enabledModelIds` | `[]` | Non-empty restricts discovery to these ids (explicit `models` entries are exempt) |
| `modelAliases` | `{}` | Gateway id → models.dev id |
| `models` | `[]` | Per-model overrides and extras: `id`, `name`, `protocol`, `contextWindow`, `maxTokens`, `input`, `thinking`, `reasoningEfforts` |
| `modelMetadataUrl` | `https://models.dev/models.json` | Catalog URL; `''` disables enrichment |
| `images` | `ignore` | `metadata` adopts models.dev input types (images) |
| `reasoning` | `auto` | `off` declares every model non-reasoning |
| `sync` | `true` | `false` discovers without registering routes (the configuration page still reports) |
| `refreshIntervalMinutes` | `0` | Periodic refresh; `0` refreshes only at load and on change |

Three common examples:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    models:
      # more reasoning levels for one model (only two conservative ones are offered by default)
      - id: deepseek-v4-pro
        reasoningEfforts: { off: disabled, minimal: minimal, low: low, medium: medium, high: high, max: max }
      # a model the gateway did not list
      - id: gemini-2.5-pro
        api: openai-completions
    modelAliases:
      # the gateway renamed it, so models.dev does not match
      deepseek-flash: deepseek/deepseek-v4-flash
      k3: moonshotai/kimi-k3
```

Missing capacity and reasoning levels are filled in from Aperture's own fields → [models.dev](https://models.dev) → a conservative default (the fallback capacity, 128000, the 20s per-request timeout, and the five-minute streaming idle cap are constants in the code, not configuration); `maxTokens` is reported to the Host as a default output cap only when the model declares one itself, and nothing is reported when it does not.

## Troubleshooting

### The first `add` from git fails, saying build scripts were ignored?

Add the `allowBuilds` line from the git part of step 1, then re-run — or install from npm, which needs no authorization at all.

### `Issues with peer dependencies found` during install?

Expected: the `@deepseek-ai/cordis`, `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-settings` packages this plugin peers on ship with DSH and are resolved by DSH itself (they never enter the profile's `node_modules`), so pnpm not seeing them does not affect running the plugin.

### `Failed to resolve dependency: The filename, directory name, or volume label syntax is incorrect. (os error 123)`?

The git spec is scp-style (`git@github.com:he0119/dsh-aperture.git`) — on Windows the colon reads as a drive letter, so it is parsed as a **local path**. Use a spec pnpm recognises: `github:he0119/dsh-aperture`, `git+https://…` or `git+ssh://…`.

### git over HTTPS is unusable on this machine (schannel / `SEC_E_NO_CREDENTIALS`)?

```sh
git config --global url."git@github.com:".insteadOf "https://github.com/"
```

### Some models never show up in the selector?

Look at the sentence on this plugin's configuration page at **Plugins → dsh-aperture**: it says how many models have no route to serve them and what they are called (the route cards list only the models that route really serves). Models that only offer Gemini's native `generateContent` endpoint cannot be attached — this plugin publishes OpenAI Chat Completions, OpenAI Responses and Anthropic Messages only. Using the wrong endpoint fails loudly, for instance `404 model "gemini-2.5-flash" is available via gemini_generate_content, not openai_chat`.

### Want more reasoning levels for a model?

Only two conservative levels are offered by default (DeepSeek family `off/high/max`, every other reasoning model `off/high`); give that `models` entry a `reasoningEfforts`, as in [Configuration](#configuration).

### Want a model the gateway did not list?

Add it explicitly to `models` — for instance the Gemini models that sentence on the configuration page reports, if you know they work on an OpenAI-compatible endpoint after all; see [Configuration](#configuration).

### Capacity or reasoning flags were not filled in?

Gateways rename things, and models.dev may not match (in practice `deepseek-flash` and `k3` are `deepseek/deepseek-v4-flash` and `moonshotai/kimi-k3` there); bridge it with `modelAliases`, as in [Configuration](#configuration).

### The interface says `没注册（路由 aperture-openai-responses 已被另一个适配器注册…）`?

One of the route keys it asks for is already served by someone else, most often by an **older version of this plugin** (0.2 and earlier only discovered, and it wrote the routes it found into `llm-pi-ai.providers`). This plugin will not rewrite someone else's configuration for you: delete the matching `providers.<key>` from the `llm-pi-ai` section following the key name that line gives you, or, if that route name belongs to another plugin, change this plugin's `routePrefix` (all three route keys move with it). The next change to the adapter set — a reload after that edit, or pressing "Refresh now" — retries registration; no restart is needed. (The host writes that line in Chinese, as do its action summaries.)

### Coming from 0.2 or earlier, do I have to delete those `aperture*` keys in `llm-pi-ai.providers` myself?

Yes — and this time no key will point them out for you: the route keys are now the prefix plus the protocol name (by default `aperture-openai-chat-completions`, `aperture-openai-responses`, `aperture-anthropic-messages`), none of which matches the `aperture`, `aperture-responses` or `aperture-anthropic` written back then, so registration never collides. Leaving them behind only lets `llm-pi-ai` keep serving a stale route (duplicate models in the selector).

### Where did the `route` key go?

It was renamed to `routePrefix`. The old key raises no error — the schema ignores it, so the prefix quietly falls back to the default `aperture`. If you had renamed the prefix (`route: my-gateway`), copy it onto `routePrefix`; if you only ever wrote the default, just delete the old key.

### Saved but not in effect?

DSH's patch layers stack: above the profile patch document sit higher-priority layers such as `$DSH_HOME/cordis.patch.yml`. If the `aperture` row is written there too, a save from the configuration page lands in the profile patch document but is shadowed by that layer (the settings service may also refuse the write outright, in which case the page says so). Delete the row from the higher-priority layer, or edit it there instead.

### Upgrading from 0.2 — where did my `settings.yaml` go?

As of 0.1.7 settings no longer live in a file of their own; they live in the profile patch document. On the first start `$DSH_HOME/settings.yaml` is renamed to `settings.yaml.imported` and each section is moved into the patch document under its settings namespace — the `aperture:` section moves as-is, and every key and value that still passes the schema is unchanged, so the address and the per-model overrides are all still there. From then on only the patch document is read, and that archive does nothing when edited; a section whose values no longer validate stays in the archive too, with a line in the log saying so.

### No Plugins page / no GUI in this deployment?

Both interfaces only exist in the Web GUI. A headless profile still discovers and still registers routes, it just has no clickable page — edit the configuration instead. The models also show up as rows on the official Models page; that row's own editor is read-only for this plugin (its settings section is `aperture`), and what you do edit is the block this plugin hangs inside it.

### Need a real key instead of the placeholder credential?

No: Aperture authenticates by network identity (Tailscale). The plugin sends `authorization: Bearer dsh-aperture` on every request (the Anthropic route sends `x-api-key: dsh-aperture`), only to make pi-ai willing to send the request — this is **not a key**. When a real credential is needed, point `apiKeyEnv` at a credential-seam record and the placeholder credential is no longer sent.

### Is the old route still there after changing `routePrefix`?

The plugin only knows the three keys it currently asks for; once the process exits, the old key has no one serving it. It no longer appears in the selector and needs no cleanup, unless another adapter takes that key over.

## What it does

The plugin asks the gateway for one `GET {baseUrl}/v1/models` listing and routes each model by its `supported_endpoints`: `/v1/chat/completions` to `openai-completions`, `/v1/responses` to `openai-responses`, `/v1/messages` to `anthropic-messages`, each on one of the three routes sharing the same prefix; a model that only offers native `generateContent` is not published, and the configuration page's sentence names it.

Each route carries exactly one protocol, and a model id is the gateway's id; the plugin writes no configuration at all, so a discovery result only lives in that one registration. When another adapter already holds a route key, the plugin does not force its way in: it skips registration, names the key in the report, and retries whenever the adapter set changes. Why each decision is what it is — and which alternatives were rejected — is in [.agents/notes/implemented/](https://github.com/he0119/dsh-aperture/tree/main/.agents/notes/implemented) (Chinese); current mechanisms and known limits are in [docs/internals.md](https://github.com/he0119/dsh-aperture/blob/main/docs/internals.md) (Chinese).

## Development

```sh
pnpm install
pnpm run build      # tsdown -> lib/index.js + lib/types/index.d.ts + lib/client.js
pnpm test           # unit tests + end-to-end (offline; devDependencies must be installed)
```

Working on the plugin — build, tests, and a dedicated development instance — is in [docs/development.md](https://github.com/he0119/dsh-aperture/blob/main/docs/development.md) (Chinese); the release process and what the published package contains are in [docs/releasing.md](https://github.com/he0119/dsh-aperture/blob/main/docs/releasing.md) (Chinese).

## Acknowledgements

- [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot): the reference implementation this plugin follows for Aperture model discovery.
- [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup): the reference implementation this plugin follows for the interface wiring — the Remote endpoint shape comes from it, while the way the configuration page is mounted now comes from the Plugins page's slot contract as of 0.1.7.
- [Aperture](https://tailscale.com/kb/1542/aperture) (Tailscale): the gateway being discovered.
- [models.dev](https://models.dev): enriches capacity and capabilities Aperture does not declare.
- [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) (`@earendil-works/pi-ai`): it implements the three wire protocols; this plugin only translates discovery results into its model descriptors.

## License

MIT
