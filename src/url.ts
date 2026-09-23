/**
 * URL normalization for one Aperture instance.
 *
 * The configured value is an instance root — `https://ai.example.ts.net` — and
 * every endpoint this plugin or the pi-ai adapter reaches is derived from it.
 * A trailing `/v1` is tolerated and stripped rather than rejected, because the
 * reference extension for VS Code documents the opposite convention and a user
 * arriving with that habit should not get a doubled `/v1/v1`.
 *
 * @module dsh-aperture/url
 */

/** Strip every trailing forward slash from a URL string. */
function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '');
}

/**
 * Normalize a configured instance root, or report that none is usable.
 *
 * A bare host is assumed HTTPS, the query and fragment are dropped, and a
 * trailing `/v1` (with any number of trailing slashes) is removed so callers
 * always build paths from the instance root.
 *
 * @param raw - the configured value, verbatim.
 * @returns the normalized root without a trailing slash, or `undefined` when
 *   the value is empty or not an absolute HTTP(S) URL.
 */
export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withScheme = /^[a-z][a-z\d+\-.]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  url.hash = '';
  url.search = '';
  const path = stripTrailingSlashes(url.pathname).replace(/\/v1$/u, '');
  url.pathname = path || '/';
  return stripTrailingSlashes(url.toString());
}

/**
 * The endpoint that lists the models one instance serves.
 * @param instanceRoot - a normalized instance root.
 * @returns the absolute models URL.
 */
export function buildModelsEndpoint(instanceRoot: string): string {
  return `${stripTrailingSlashes(instanceRoot)}/v1/models`;
}

/**
 * The `baseURL` a pi-ai route must carry for one protocol.
 *
 * `openai-completions` appends `/chat/completions` to the route's `baseURL`, so
 * it receives the `/v1` root; `anthropic-messages` uses the provider SDK, which
 * appends `/v1/messages` itself, so it receives the bare instance root.
 * @param instanceRoot - a normalized instance root.
 * @param protocol - the route's wire protocol.
 * @returns the `baseURL` for that route.
 */
export function buildRouteBaseUrl(instanceRoot: string, protocol: 'openai-completions' | 'anthropic-messages'): string {
  const root = stripTrailingSlashes(instanceRoot);
  return protocol === 'openai-completions' ? `${root}/v1` : root;
}
