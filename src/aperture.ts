/**
 * 端点问询：`GET {instance}/v1/models`。
 *
 * 这是插件为发现过程发出的唯一网络调用。它与 `dsh-llm-pi-ai` 自己的 "fetch available
 * models" 动作读的是同一个端点——区别在于那个动作一次只采纳一份草稿，而本插件才是让
 * 清单自行刷新的东西。
 *
 * @module dsh-aperture/aperture
 */

import { asRecord } from './metadata/utils.ts';
import { buildModelsEndpoint } from './url.ts';

/** 有界读取：远超此值的模型清单不是模型清单。 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 一份成功的清单。 */
export interface ModelsListing {
  /** 按端点顺序排列的原始模型条目。 */
  readonly entries: readonly unknown[];
  /** 应答的 URL。 */
  readonly endpoint: string;
}

/** 一次问询的请求选项。 */
export interface FetchModelsOptions {
  /** 随请求发送的、`accept` 之外的请求头。 */
  readonly headers?: Readonly<Record<string, string>>;
  /** 经过这么多毫秒后中止请求。 */
  readonly timeoutMs?: number;
  /** 调用方的取消信号，与超时组合使用。 */
  readonly signal?: AbortSignal;
}

/**
 * 问询一个 Aperture 实例，获取它服务的模型。
 *
 * @param instanceRoot - 一个已归一化的实例根。
 * @param options - 请求头、超时与调用方取消信号。
 * @returns 按端点顺序排列的原始条目。
 * @throws 当请求失败、端点拒绝、应答过大，或响应体不是模型清单时，抛出带端点名的 Error。
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
    throw new Error(`${endpoint} 无法访问：${describeError(error)}`, { cause: error });
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`${endpoint} 应答 HTTP ${response.status}${detail === undefined ? '' : `: ${detail}`}`);
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${endpoint} 应答了 ${declaredLength} 字节，超出 ${MAX_RESPONSE_BYTES} 字节的清单上限`);
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(`${endpoint} 应答了 ${text.length} 字节，超出 ${MAX_RESPONSE_BYTES} 字节的清单上限`);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`${endpoint} 没有应答 JSON：${describeError(error)}`, { cause: error });
  }

  return { entries: readEntries(body, endpoint), endpoint };
}

/**
 * 从清单响应体中读取出模型行。
 *
 * 存在 `data` 数组时以它为准；否则读取 `models` 对象，且只有值为对象的属性才算模型。
 * 其他形状一律拒绝而不是当作空清单——空清单会覆盖掉一份可用的清单。
 *
 * @param body - 已解析的响应。
 * @param endpoint - 应答的 URL，用于诊断。
 * @returns 按端点顺序排列的原始模型行。
 * @throws 当响应体不是可识别的清单时抛出 Error。
 */
export function readEntries(body: unknown, endpoint: string): readonly unknown[] {
  const record = asRecord(body);
  if (!record) {
    throw new Error(`${endpoint} 没有应答 JSON 对象`);
  }
  if (Array.isArray(record.data)) {
    return record.data;
  }
  const models = asRecord(record.models);
  if (models) {
    return Object.values(models).filter((value) => asRecord(value) !== undefined);
  }
  throw new Error(`${endpoint} 既没有应答 "data" 数组，也没有应答 "models" 对象`);
}

/** 读取错误响应体的一小段，用于诊断。 */
async function readErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    return trimmed.length === 0 ? undefined : trimmed.slice(0, 500);
  } catch {
    return undefined;
  }
}

/** 把一个未知的可抛出对象渲染成单行原因。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    return cause instanceof Error && cause.message !== error.message
      ? `${error.message} (${cause.message})`
      : error.message;
  }
  return String(error);
}
