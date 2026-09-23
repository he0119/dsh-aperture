/**
 * The endpoint interrogation: `GET {instance}/v1/models`.
 *
 * This is the only network call the plugin makes for discovery, and it is
 * deliberately the same listing endpoint `dsh-llm-pi-ai`'s own "fetch available
 * models" action reads — that action adopts one draft at a time, while this
 * plugin is what makes the catalog refresh itself.
 *
 * @module dsh-aperture/aperture
 */

import { asRecord } from './metadata/utils.ts';
import { buildModelsEndpoint } from './url.ts';

/** Bounded read: a model listing far beyond this is not one. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** One successful listing. */
export interface ModelsListing {
  /** Raw model entries, in endpoint order. */
  readonly entries: readonly unknown[];
  /** The URL that answered. */
  readonly endpoint: string;
}

/** Request options for one interrogation. */
export interface FetchModelsOptions {
  /** Headers sent with the request, beyond `accept`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Abort the request after this many milliseconds. */
  readonly timeoutMs?: number;
  /** Caller cancellation, composed with the timeout. */
  readonly signal?: AbortSignal;
}

/**
 * Interrogate one Aperture instance for the models it serves.
 *
 * @param instanceRoot - a normalized instance root.
 * @param options - headers, timeout, and caller cancellation.
 * @returns the raw entries in endpoint order.
 * @throws Error naming the endpoint when the request fails, the endpoint
 *   refuses it, the reply is too large, or the body is not a model listing.
 */
export async function fetchModelsListing(
  instanceRoot: string,
  options: FetchModelsOptions = {},
): Promise<ModelsListing> {
  const endpoint = buildModelsEndpoint(instanceRoot);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...options.headers,
      },
      signal,
    });
  } catch (error) {
    throw new Error(`${endpoint} could not be reached: ${describeError(error)}`, { cause: error });
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`${endpoint} answered HTTP ${response.status}${detail === undefined ? '' : `: ${detail}`}`);
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${endpoint} answered ${declaredLength} bytes, beyond the ${MAX_RESPONSE_BYTES}-byte listing bound`);
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(`${endpoint} answered ${text.length} bytes, beyond the ${MAX_RESPONSE_BYTES}-byte listing bound`);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`${endpoint} did not answer JSON: ${describeError(error)}`, { cause: error });
  }

  return { entries: readEntries(body, endpoint), endpoint };
}

/**
 * Read the model rows out of a listing body.
 *
 * A `data` array wins when present; otherwise a `models` object is read, and
 * only its object-valued properties count as models. Every other shape is
 * refused rather than silently read as an empty catalog, because an empty
 * catalog would be written over a working one.
 *
 * @param body - the parsed response.
 * @param endpoint - the URL that answered, for the diagnostic.
 * @returns the raw model rows in endpoint order.
 * @throws Error when the body is not a recognizable listing.
 */
export function readEntries(body: unknown, endpoint: string): readonly unknown[] {
  const record = asRecord(body);
  if (!record) {
    throw new Error(`${endpoint} did not answer a JSON object`);
  }
  if (Array.isArray(record.data)) {
    return record.data;
  }
  const models = asRecord(record.models);
  if (models) {
    return Object.values(models).filter((value) => asRecord(value) !== undefined);
  }
  throw new Error(`${endpoint} answered neither a "data" array nor a "models" object`);
}

/** Read a bounded slice of an error body for the diagnostic. */
async function readErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    return trimmed.length === 0 ? undefined : trimmed.slice(0, 500);
  } catch {
    return undefined;
  }
}

/** Render an unknown throwable as a one-line reason. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    return cause instanceof Error && cause.message !== error.message
      ? `${error.message} (${cause.message})`
      : error.message;
  }
  return String(error);
}
