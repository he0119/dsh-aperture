# dsh-aperture

Discover the models an [Aperture](https://tailscale.com/kb/1542/aperture) gateway serves and, by the endpoint each one answers on, register them as this plugin's own provider routes in DeepSeek Harness — so they simply appear in the model selector. Once installed, one Aperture address is all you configure.

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

When editing the code locally, install the checkout directory instead (run `pnpm run build` first):

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

The models appear in the selector under the route `Aperture`. Settings live in two places: this package's configuration page at **Plugins → dsh-aperture** carries the instance address, the registration toggle and a "Refresh now" button, while the model list is on the official **Settings → Models** page, in this plugin's route cards.

```
(Plugins → dsh-aperture)
Instance address  overridden  Reset to default
[https://ai.example.ts.net                            ]
Where Aperture listens; leave it empty to go dormant and stop discovering models.

Sync automatically                 overridden  Reset to default   ●━
After each discovery round, register these models as this plugin’s own provider routes in dsh.  [Save]

Saved: rediscovered and published.

The model list and its per-model overrides live on the Settings → Models page, in this plugin’s route cards: open that row and the models are listed below it.   ⟳ Refresh now
1 more model has no route to serve it (gemini-2.5-flash): give it a models[].protocol in the configuration and it gets a route;
anything that cannot be served can simply be deleted.
```

```
(Settings → Models)
DeepSeek                                            Edit
Aperture (OpenAI Chat Completions)  Custom                  Edit
  ────────────────────────────────────────────────────
  Models  18                                         ⌄
  One model per row; expand a row to edit its overrides, and Save writes only that row. The order comes from discovery.

  ● deepseek-v4-flash
    context 1,048,576 · output 384,000 · input types text+image · reasoning on · 1 overridden

    (expand a row and you get that row's override editor: name and protocol in one group, capacity in another,
     input types and reasoning each on a row of their own, and Save / Clear overrides / Cancel underneath. Every
     row in one card serves the same route, which the card head already names, so the rows leave "route / protocol" out)

+ Add model provider
```

**The instance address and the registration toggle** are two fields of one official settings form: where a field says "overridden", a "Reset to default" right beside it drops that key from your settings file (the same two words in the same position as the official plugin-config page), and Save writes only the fields you actually changed. Headings and spacing separate the groups, while a model row is a card (a hairline outline with a large radius, coloured only with theme tokens this page really defines), and the only thing you can expand is a model row.

(English labels are shown above; both pages are bilingual.)

**The model list hangs off an extension seat inside this plugin's own rows on the official Models page** (the page owner's own name for them is Extension slots): every route this plugin registers is one row on that page, and that row gets a block of its own drawing **that one route's** models — so a model listed on that page always really has a route. The models no route can serve (the ones written by hand in the configuration, the ones the catalog never listed) take up no seat there; the Plugins page says one sentence about them instead: how many, which ones, and where to give them a protocol. That block **starts collapsed**: the header (a row of this plugin's own drawing, under a hairline) carries the title and the model count on the left and a permanent chevron on the right, and one click unfolds this block — every row on that page has this block, and unfolded it is a dozen lines, so collapsed is what keeps it from taking over. Inside a route card every row serves the same route, which the card head already names, so those rows leave "route / protocol" out.

## Usage

The interface lives in two places, each minding its own business:

- **Plugins → dsh-aperture**: open this plugin in the plugin list; the settings page hangs off the package, so there is no separate Configure button. The page header's name, icon and description come from the package's `locale/*.json` and `package.json`'s `icon`; the page itself is drawn by the Plugins page. This page holds two things only: the instance address and the registration toggle.
- **Settings → Models**: this plugin's model list hangs off that official page — one block inside each route's row (that row's own models); the models no route can serve do not appear on that page at all, the Plugins page's sentence covers them. The page owner declares that seat's name; this plugin only registers content into it.

The address, the toggle and the per-model parameters stay drafts until you press Save; models are **one row at a time**, and collapsing a row does not throw its draft away — the "unsaved edits" tag stays visible.

| Where | Effect |
| --- | --- |
| Plugins page · Instance address | edits `baseUrl` (written through the settings seam; when it says "overridden", the "Reset to default" beside it falls back to the default) |
| Plugins page · Registration toggle | edits `sync`: off discovers without registering, and that round withdraws the three routes this plugin had registered — routes of the same name registered elsewhere are left alone; carries the same "overridden / Reset to default" pair |
| Plugins page · Save | below the form: writes the address and toggle drafts into the settings document; it is revision-fenced, so a form that has drifted from the settings document is refused rather than overwriting someone else's edit; it returns only once that round of re-discovery has landed, so the interface shows the new configuration right away |
| Plugins page · Refresh now | the button beside Save: it writes no settings and simply runs one round of discovery and registration; the outcome (success, or the reason it failed) lands on the same page, and the "what went wrong this round" line follows it |
| Models page · Models in a route card | one row per model, one card per row: a state dot at its head (green: this round registered it as a route; grey: registration ran this round but did not include it — hovering it, or a screen reader, hears exactly that), then the name with its "N overridden / unsaved edits" tags on the first line and labelled facts (capacities, input types, reasoning, alias; route and protocol are identical across a card and already named by its head, so rows leave them out) on the second, with long names ellipsised and facts wrapping; expanded, it is that row's override editor — display name, catalog alias and API protocol as one group of text fields, context window and max output tokens as the "capacity" group, and two input-type checkboxes and a three-way reasoning switch (follow discovery / on / off) each on a row of its own; a field keeps only one line naming where its value comes from ("Source: Aperture"), while how-to copy ("Leave it empty to use the discovered name") lives behind the "i" next to the label and only takes up room once opened |
| Models page · Save / Clear overrides / Cancel | write that row only, clear only the fields the backend report says really were overridden, or drop that row's draft; Save likewise waits for a round of re-discovery, so what you see afterwards is the new value |
| Plugins page · Unserved models | how many models the report found with no route to serve them, and their names (at most five, then "and N more"): give them a `models[].protocol` and they get a route, anything that cannot be served can simply be deleted; when no route got registered at all, one sentence says that instead |

In-place edits are configuration: capacities and input types land on the matching `aperture.models` entry, the catalog alias lands on `aperture.modelAliases[id]`, and writes merge per field — a field the interface never mentions (say `reasoningEfforts`) survives untouched, while an emptied field drops that override and falls back to discovery and the catalog. Capacities accept the `1M` / `100K` spelling (decimal suffixes, the same vocabulary as the official Models page: `1M` is 1000000, not 1048576); what gets stored is still a plain token count, and the field spells it back in the shortest form that survives a round trip (`384000` → `384K`, while `1048576` is not a whole thousand and stays written out). An unserved model does not appear on this page; its way out is in the configuration — write a `protocol` on that `models` entry and a model that only answers on its native endpoint gets published under the matching route.

## Configuration

Every key lives under that row's `config:` in the profile patch document (user layer); anything you leave out falls back to the defaults below. `baseUrl` and `sync` can be edited in place on the Plugins page, and the per-model parameters inside `models` and `modelAliases` on the Settings → Models page; every other key needs the file.

| Key | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `''` | Aperture instance root. A trailing `/v1` is tolerated and stripped; empty leaves the plugin dormant (no discovery, no registration) |
| `routePrefix` | `aperture` | Common prefix of the three route names: a route key is the prefix plus its protocol name in lowercase with dashes — `aperture-openai-chat-completions`, `aperture-openai-responses`, `aperture-anthropic-messages`; the three selector labels come from the same prefix and spell out the same protocol names: `Aperture (OpenAI Chat Completions)`, `Aperture (OpenAI Responses)`, `Aperture (Anthropic Messages)` — those three names are the official Models page's product names for the protocols, word for word |
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

Missing capacity and reasoning levels are filled in from Aperture's own fields → [models.dev](https://models.dev) → a conservative default (the fallback capacity, 128000, the 20s per-request timeout, and the five-minute streaming idle cap are constants in the code, not configuration). `maxTokens` is reported to the Host as a **default output cap** only when the model declares one itself: nothing is reported when it does not, and inventing a value would truncate every request to it.

## Troubleshooting

**The first `add` from git fails, saying build scripts were ignored?** Add the `allowBuilds` line from the git part of step 1, then re-run — or install from npm, which needs no authorization at all.

**`Issues with peer dependencies found` during install?** Expected: the `@deepseek-ai/cordis`, `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-settings` packages this plugin peers on ship with DSH and are resolved by DSH itself (they never enter the profile's `node_modules`), so pnpm not seeing them does not affect running the plugin.

**`Failed to resolve dependency: The filename, directory name, or volume label syntax is incorrect. (os error 123)`?** The git spec is scp-style (`git@github.com:he0119/dsh-aperture.git`) — on Windows the colon reads as a drive letter, so it is parsed as a **local path**. Use a spec pnpm recognises: `github:he0119/dsh-aperture`, `git+https://…` or `git+ssh://…`.

**git over HTTPS is unusable on this machine (schannel / `SEC_E_NO_CREDENTIALS`)?**

```sh
git config --global url."git@github.com:".insteadOf "https://github.com/"
```

**Some models never show up in the selector?** Look at the sentence on this plugin's configuration page at **Plugins → dsh-aperture** — it says how many models have no route to serve them and what they are called (the route cards on the Models page list only the models that route really serves). Models that only offer Gemini's native `generateContent` endpoint cannot be attached — this plugin can publish OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages, but does not translate Gemini's native protocol. Using the wrong endpoint fails loudly, and Aperture names the right one:

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

**Want a model the gateway did not list?** Add it explicitly with `models` — for instance the Gemini models that sentence on the configuration page reports, if you know they work on an OpenAI-compatible endpoint after all:

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

**The interface says `没注册（路由 aperture-openai-responses 已被另一个适配器注册…）`?** One of the route keys it asks for is already served by someone else — most often by an **older version of this plugin**: 0.2 and earlier only discovered, and it wrote the routes it found into `llm-pi-ai.providers`. This plugin will not rewrite someone else's configuration for you, so fix it by hand following the key name that line gives you: delete the matching `providers.<key>` from the `llm-pi-ai` section, or, if that route name belongs to another plugin, change this plugin's `routePrefix` (all three route keys move with it). The next change to the adapter set — a reload after that edit, or pressing the "Refresh now" action on the Plugins page — retries registration; no restart is needed. (The host writes that line in Chinese, as do its action summaries.)

**Coming from 0.2 or earlier, do I have to delete those `aperture*` keys in `llm-pi-ai.providers` myself?** Yes — and this time no key will point them out for you: the plugin's route keys are now the prefix plus the protocol name (by default `aperture-openai-chat-completions`, `aperture-openai-responses`, `aperture-anthropic-messages`), none of which matches the `aperture`, `aperture-responses` or `aperture-anthropic` written back then, so registration never collides. Leaving them behind only lets `llm-pi-ai` keep serving a stale route (duplicate models in the selector); delete them while upgrading.

**Where did the `route` key go?** It was renamed to `routePrefix`. The old key raises no error — the schema ignores it, so the prefix quietly falls back to the default `aperture`. If you had renamed the prefix (`route: my-gateway`), copy it onto `routePrefix` after upgrading; if you only ever wrote the default, just delete the old key.

**Saved but not in effect?** DSH's patch layers stack: above the profile patch document sit higher-priority layers such as `$DSH_HOME/cordis.patch.yml`. If the `aperture` row is written there too, a save from the configuration page lands in the profile patch document but is shadowed by that layer (the settings service may also refuse the write outright, in which case the page says so). Delete the row from the higher-priority layer, or edit it there instead.

**Upgrading from 0.2 — where did my `settings.yaml` go?** As of 0.1.7 settings no longer live in a file of their own; they live in the profile patch document. On the first start `$DSH_HOME/settings.yaml` is renamed to `settings.yaml.imported` and each section is moved into the patch document under its settings namespace — the `aperture:` section moves as-is, and every key and value that still passes the schema is unchanged, so the address and the per-model overrides are all still there. From then on only the patch document is read, and `settings.yaml.imported` is just an archive; editing it does nothing. A section whose values no longer validate stays in that archive too, with a line in the log saying so.

**No Plugins page / no GUI in this deployment?** Both interfaces only exist in the Web GUI (the Plugins-page half works over Typert Remote endpoints). A headless profile still discovers and still registers routes, it just has no clickable page. The models also show up as rows on the official Models page (only the protocols that really carry models take a row): that row's own editor is read-only for this plugin (its settings section is `aperture`, not the Models page's generic form), but this plugin hangs one editor of its own inside that row, so editing a model is still that page's business (models no route can serve do not appear there; when the GUI is around, the Plugins page's sentence covers them); with no GUI, edit the configuration.

**Need a real key instead of the placeholder credential?** Aperture authenticates by network identity (Tailscale) and needs none; the plugin sends `authorization: Bearer dsh-aperture` on every request (the Anthropic route sends `x-api-key: dsh-aperture`), only to make pi-ai willing to send the request. It is **not a key**. When a real credential is needed, point `apiKeyEnv` at a credential-seam record and the placeholder credential is no longer sent.

**Is the old route still there after changing `routePrefix`?** The plugin only knows the three keys it currently asks for (`<prefix>-openai-chat-completions`, `<prefix>-openai-responses`, `<prefix>-anthropic-messages`); once the process exits, the old key has no one serving it. It no longer appears in the selector and needs no cleanup, unless another adapter takes that key over.

## What it does

```
GET {baseUrl}/v1/models
        │
        ├─ per model: supported_endpoints ──► routing
        │     /v1/chat/completions        ──► routePrefix + -openai-chat-completions  (openai-completions)
        │     /v1/responses               ──► routePrefix + -openai-responses        (openai-responses)
        │     /v1/messages                ──► routePrefix + -anthropic-messages      (anthropic-messages)
        │     native generateContent only ──► not published (named by the Plugins page)
        │
        ├─ capacity:  Aperture fields ─► models.dev ─► default
        ├─ reasoning: Aperture fields ─► models.dev ─► off
        │
        └─ registered as three provider routes (<routePrefix> + the protocol name, lowercased with dashes)
```

Each route carries exactly one protocol, and a model id is the gateway's id; the plugin writes no configuration at all, so a discovery result only lives in that one registration (after a restart the first discovery round decides again). When another adapter already holds a route key, the plugin does not force its way in: it skips registration, names the key in the report, and retries on its own whenever the adapter set changes. Why each decision is what it is — and which alternatives were rejected — is in [.agents/notes/implemented/](https://github.com/he0119/dsh-aperture/tree/main/.agents/notes/implemented) (Chinese); current mechanisms and known limits are in [docs/internals.md](https://github.com/he0119/dsh-aperture/blob/main/docs/internals.md) (Chinese).

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
