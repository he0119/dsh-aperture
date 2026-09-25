/**
 * 容量与计数的写法：输入框里认 `1M` / `100K`，写回去取能原样读回来的最短形式。
 *
 * 与官方「模型」页同一套词汇（它的 `parseCapacity` / `formatCapacity`），两边是一套说法。
 *
 * @module dsh-aperture/client/format
 */

/** token 计数的千位分隔符；跟随浏览器语言。 */
export function formatCount(value: number): string {
  return value.toLocaleString();
}

/** 容量能写成的样子：十进制数加一个可选的 K/M 后缀。 */
const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
/** 后缀是十进制的：`1M` 就是 1000K，跟容量平时的说法一致。 */
const CAPACITY_SCALE = { k: 1e3, m: 1e6 };

/**
 * 读输入框里的容量，好让人写 `1M`、`100K` 而不必去数零。与官方「模型」页同一套写法（它的
 * `parseCapacity`）：空串是「这一项不覆盖」，读不出来的返回 `NaN`，由调用方在本地挡下来。
 *
 * @returns {number|undefined} token 数；空串给 `undefined`，读不出来给 `NaN`。
 */
export function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const match = CAPACITY_PATTERN.exec(trimmed);
  if (match === null) return NaN;
  const suffix = match[2] === undefined ? '' : match[2].toLowerCase();
  const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1;
  const scaled = Number(match[1]) * scale;
  const rounded = Math.round(scaled);
  // 浮点误差落在整数边上的（`1.0000001M`）吃掉；真不是整数的（`0.5`）原样返回，交给
  // 调用方按「必须是不小于 1 的整数」拒绝。
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
}

/**
 * 把存下来的 token 数写回输入框，取能原样读回来的最短写法：`1000000` 写成 `1M`、`384000`
 * 写成 `384K`，`1048576` 不是整千就照原样写——官方 `formatCapacity` 同此，两边是一套词汇。
 *
 * @returns {string} 输入框文本；没有值时是空串。
 */
export function formatCapacity(value: number | undefined): string {
  if (value === undefined) return '';
  if (!Number.isInteger(value) || value <= 0) return String(value);
  if (value % CAPACITY_SCALE.m === 0) return `${String(value / CAPACITY_SCALE.m)}M`;
  if (value % CAPACITY_SCALE.k === 0) return `${String(value / CAPACITY_SCALE.k)}K`;
  return String(value);
}
