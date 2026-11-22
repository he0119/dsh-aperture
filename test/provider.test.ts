/**
 * 密钥可用性判定：只去掉首尾空白，其它一律在发请求前拒绝。
 *
 * 这条判定必须在 `fetch` 之前失败。否则一个带换行的密钥会让请求头构造抛 `ByteString` 的
 * `TypeError`，被适配器当成「连不上网关」，把一次确定的本地配置错误说成网络问题。
 *
 * @module dsh-aperture/test/provider
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { usableApiKey } from '../src/provider.ts';

const REF = 'APERTURE_API_KEY';

/**
 * 断言一次调用被拒，诊断点名凭据引用，并说清是「值空白」还是「字符带不出去」。
 *
 * 两种拒绝必须能分开：只断言「抛了」的话，把空白分支删掉也照样绿——空串会掉进
 * 非法字符那条分支。
 */
function rejectedAsUnusable(raw: string, reason: '的值是空白' | 'HTTP 头不能携带'): LlmError {
  try {
    usableApiKey(raw, REF);
  } catch (error) {
    assert.ok(error instanceof LlmError, `应当抛出 LlmError，实际 ${String(error)}`);
    assert.equal(error.code, 'INVALID_CREDENTIAL');
    assert.match(error.message, new RegExp(REF));
    assert.match(error.message, new RegExp(reason));
    return error;
  }
  assert.fail('应当拒绝这个密钥');
}

describe('密钥可用性判定', () => {
  it('去掉首尾空白后返回密钥本体', () => {
    assert.equal(usableApiKey('  sk-abc-123\t', REF), 'sk-abc-123');
  });

  it('可见 ASCII 的两端都能通过', () => {
    assert.equal(usableApiKey('!', REF), '!');
    assert.equal(usableApiKey('~', REF), '~');
  });

  it('空白值在发请求前被拒', () => {
    rejectedAsUnusable('   ', '的值是空白');
    rejectedAsUnusable('\n\t', '的值是空白');
  });

  it('中间带空白、换行、非 ASCII 或 DEL 时被拒', () => {
    rejectedAsUnusable('sk-abc 123', 'HTTP 头不能携带');
    rejectedAsUnusable('sk-abc\ndef', 'HTTP 头不能携带');
    rejectedAsUnusable('密钥', 'HTTP 头不能携带');
    rejectedAsUnusable('sk-abc\x7F', 'HTTP 头不能携带');
  });
});
