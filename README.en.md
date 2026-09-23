# dsh-aperture

Discover the models an [Aperture](https://tailscale.com/kb/1542/aperture) gateway serves, and publish them to DeepSeek Harness as `llm-pi-ai` provider routes — so they simply appear in the model selector.

The reference implementation is [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot). The difference is that the extension had to implement a provider from scratch, while DSH already ships `@deepseek-ai/dsh-llm-pi-ai` — an adapter that speaks OpenAI Chat Completions and Anthropic Messages, which is exactly what Aperture exposes. So this plugin **only discovers; it converts no API format**. It translates a discovery result into `llm-pi-ai` provider profiles and lets the existing adapter do the rest.

```yaml
# ~/.dsh/settings.yaml — written by the plugin; you do not hand-write this
llm-pi-ai:
  providers:
    aperture:
      api: openai-completions
      baseURL: https://ai.example.ts.net/v1
      models:
        - id: deepseek-flash
          name: DeepSeek V4.1 Flash
          contextWindow: 1048576
          maxTokens: 384000
```

## Features

- **Zero-configuration discovery.** One `baseUrl` is enough. `GET {baseUrl}/v1/models` needs no key; Aperture authenticates by network identity (Tailscale).
- **Per-model protocol routing.** Each model's `supported_endpoints` decides which route it is published on, instead of publishing models that 404 on every request.
- **Capacity and capability completion.** Aperture's own fields win, [models.dev](https://models.dev) answers what Aperture left out, and a configurable conservative default answers last.
- **Reasoning mapping.** Only levels the upstream actually accepts are offered, with the DeepSeek `thinking` dialect expressed through `compat`.
- **Writes only what it owns.** Writes are path-addressed, so your hand-written providers survive untouched; an unchanged section is not rewritten; a failed discovery never wipes the published catalog.
- **A `/aperture` command** for status, model listing, forced refresh, and route removal.

## Install

```sh
# from a local checkout
dsh plugin --profile web add /path/to/dsh-aperture

# or from git
dsh plugin --profile web add git@github.com:he0119/dsh-aperture.git
```

`dsh plugin add` adds the package to the profile and reconciles `dsh.profile.bundles`: any dependency declaring `dsh.bundle.patch` joins the layer stack automatically. **Restart DSH afterwards** — bundle changes are not hot-reloaded.

> A local-directory install is a symlink and does **not** build for you: run `npm install && npm run build` first, and re-run `npm run build` after every source change. A git install runs `prepare` and builds itself.

Then point it at your instance, either in the user layer:

```yaml
# ~/.dsh/settings.yaml (recommended)
aperture:
  baseUrl: https://ai.example.ts.net
```

…or in the profile's `cordis.patch.yml` (composition layer). The user layer wins.

After the restart the models appear in the selector under the route `Aperture`. Confirm with `/aperture`:

```
Aperture: https://ai.example.ts.net
  last refresh: load · 2026-09-22T16:31:02.184Z · 412ms · ok
  catalog: 422 entries
  endpoint: https://ai.example.ts.net/v1/models listed 16 row(s)
  route aperture: 11 model(s) via openai-completions → https://ai.example.ts.net/v1
  route aperture-anthropic: 1 model(s) via anthropic-messages → https://ai.example.ts.net
  unserved: 4 model(s) (gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.5-pro, gemini-3.1-flash-image-preview)
  settings: wrote 2 op(s) to llm-pi-ai (aperture, aperture-anthropic)
```

## How it works

```
GET {baseUrl}/v1/models
        │
        ├─ per model: supported_endpoints ──► route
        │     /v1/chat/completions        ──► route            (openai-completions)
        │     /v1/messages                ──► anthropicRoute   (anthropic-messages)
        │     native generateContent only ──► not published (reported as unserved)
        │
        ├─ capacity:  Aperture fields ─► models.dev ─► default
        ├─ reasoning: Aperture fields ─► models.dev ─► off
        │
        └─ llm-pi-ai providers.<route>, written to settings.yaml by revision
```

### Why two routes

Aperture is an endpoint-aware gateway: a given model does not accept every protocol. Measured against a live instance:

| Models | `supported_endpoints` | Result |
| --- | --- | --- |
| 11 (DeepSeek / MiMo / Grok / Qwen / LongCat …) | `/v1/chat/completions` | route `aperture` |
| `MiniMax-M3` | `/v1/messages` | route `aperture-anthropic` |
| 4 Gemini models | `/v1beta/models/{model}:generateContent` | not published |

Using the wrong endpoint fails loudly, and Aperture names the right one:

```
404 model "gemini-2.5-flash" is available via gemini_generate_content, not openai_chat
404 model "MiniMax-M3" is available via anthropic_messages, not openai_chat
```

`llm-pi-ai` speaks OpenAI-compatible and Anthropic Messages only, so those four Gemini models **cannot** be attached through it. The plugin reports them instead of publishing models that are guaranteed to fail.

### The placeholder credential

`llm-pi-ai` — more precisely the pi-ai SDK beneath it — throws `No API key for provider` when no credential exists at all. Aperture authenticates by network identity and needs none, so the plugin writes a placeholder header:

- route `aperture` → `authorization: Bearer dsh-aperture`
- route `aperture-anthropic` → `x-api-key: dsh-aperture`

**It is not a key**; it only makes the adapter willing to send the request, and a live Aperture instance answers a garbage bearer with 200. When a real credential is needed, point `apiKeyEnv` at a credential-seam record and no placeholder is written.

### Where each fact comes from

| Fact | Precedence |
| --- | --- |
| `contextWindow` | Aperture `context_window_tokens` / `max_input_tokens` / `limit.context` → models.dev → `defaultContextWindow` |
| `maxTokens` | Aperture `max_output_tokens` / `limit.output` → models.dev → **nothing** |
| `input` (modalities) | with `images: metadata`: Aperture capability fields → models.dev → `["text"]`; with `images: ignore`: always `["text"]` |
| `reasoning` | Aperture capability fields → models.dev → off |

An unstated `maxTokens` is deliberately **omitted**: in `llm-pi-ai` it is both the declared output capability and the per-request `max_tokens` cap, so inventing 16384 would truncate every request.

### Reasoning levels are conservative

A level in `reasoningEfforts` is the value sent on the wire. Measured:

- DeepSeek accepts `minimal/low/medium/high/xhigh/max/none`, returns `reasoning_content` by default, and needs `thinking: {type: disabled}` to suppress it;
- MiMo (`mimo-v2.6-pro`) answers **HTTP 400** for `minimal`, `xhigh`, and `max`.

So only two levels are offered by default:

| Model | `reasoningEfforts` | `compat` |
| --- | --- | --- |
| DeepSeek family (id/name/provider contains `deepseek`) | `{off: disabled, high: high, max: max}` | `{supportsReasoningEffort: true, thinkingFormat: deepseek}` |
| every other reasoning model | `{off: null, high: high}` | `{supportsReasoningEffort: true}` |

More levels are one configuration entry away:

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

The Anthropic route declares **no reasoning levels** by default: Anthropic thinking is a different switch (it takes a budget), so `reasoning_effort` would mean nothing there. Opt in explicitly with `thinking: true`.

### When a models.dev id does not match

Gateways rename things. In practice `deepseek-flash` and `k3` have no models.dev entry (the catalog calls them `deepseek/deepseek-v4-flash` and `moonshotai/kimi-k3`), and no scoring rule can bridge that without guessing. Bridge it explicitly:

```yaml
aperture:
  modelAliases:
    deepseek-flash: deepseek/deepseek-v4-flash
    k3: moonshotai/kimi-k3
```

Only then do those two pick up the catalog's reasoning flag and capacity.

## Commands

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

`models` both overrides discovered entries (only the fields you state) and adds models the gateway did not list — for instance those four Gemini models, if you know they work on an OpenAI-compatible endpoint after all:

```yaml
aperture:
  models:
    - id: gemini-2.5-pro
      api: openai-completions
```

## Write behaviour

The plugin touches exactly two keys under `llm-pi-ai.providers` (`route` and `anthropicRoute`), and:

- **writes nothing when nothing changed** — each refresh compares against the resolved section, so there is no rewrite churn and no watcher feedback loop;
- **writes with path ops** — not one field of your other providers is touched;
- **writes nothing after a failed discovery** — a transient gateway outage keeps the catalog that is already serving;
- **writes by revision** — a conflict with another writer (the Models page, another process) re-reads once and retries;
- **removes a route that lost its models** — no empty route pointing at a stale catalog is left behind.

`settings: no write (already in sync)` in `/aperture` is the normal steady state.

## Development

```sh
npm install                # if the machine-level npm cache is not writable: npm install --cache ./.npm-cache --ignore-scripts
npm run build              # tsc -> lib/
npm run typecheck          # includes test/
npm test                   # offline unit tests (79)
npm run test:live          # end-to-end: real harness stack + real gateway
npm run inspect            # print the generated settings.yaml and its resolutions
```

`npm run test:live` needs a gateway address:

```sh
DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run test:live
```

It boots the real `dsh-settings-file`, `dsh-llm`, `dsh-llm-pi-ai`, and this plugin, performs a real discovery, and then asserts that the settings file was written, both routes registered, `ctx.llm.listModels()` can see the models, and capacity and reasoning levels match. It is the only test that proves the adapter actually accepts what was written.

## Known boundaries

- **No API-format conversion**, by design rather than by omission — and therefore only the two protocols `llm-pi-ai` speaks. Native Gemini endpoints cannot be attached.
- `supported_endpoints` is the only protocol signal. A gateway that reports none is treated as OpenAI-compatible.
- models.dev is best-effort enrichment: if it cannot be fetched, discovery still succeeds.
- The plugin registers no provider directory (`registerConfigurableProviders`) — `llm-pi-ai` already claims that, and a duplicate registration throws.

## License

MIT
