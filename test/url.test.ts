import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildModelsEndpoint, buildRouteBaseUrl, normalizeBaseUrl } from '../src/url.ts';

describe('normalizeBaseUrl', () => {
  it('原样保留干净的 HTTPS 根地址', () => {
    assert.equal(normalizeBaseUrl('https://ai.long-antares.ts.net'), 'https://ai.long-antares.ts.net');
  });

  it('去掉结尾的斜杠', () => {
    assert.equal(normalizeBaseUrl('https://ai.long-antares.ts.net/'), 'https://ai.long-antares.ts.net');
    assert.equal(normalizeBaseUrl('  https://ai.long-antares.ts.net///  '), 'https://ai.long-antares.ts.net');
  });

  it('容忍 VS Code 扩展所记录的结尾 /v1', () => {
    assert.equal(normalizeBaseUrl('https://ai.long-antares.ts.net/v1'), 'https://ai.long-antares.ts.net');
    assert.equal(normalizeBaseUrl('https://ai.long-antares.ts.net/v1/'), 'https://ai.long-antares.ts.net');
  });

  it('只给主机名时按 HTTPS 假定', () => {
    assert.equal(normalizeBaseUrl('ai.long-antares.ts.net'), 'https://ai.long-antares.ts.net');
  });

  it('丢弃查询串与片段，并保留路径前缀', () => {
    assert.equal(normalizeBaseUrl('https://gateway.example/llm/?x=1#frag'), 'https://gateway.example/llm');
  });

  it('保留 http 根地址', () => {
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  });

  it('拒绝空值或不可用的值', () => {
    assert.equal(normalizeBaseUrl(''), undefined);
    assert.equal(normalizeBaseUrl('   '), undefined);
    assert.equal(normalizeBaseUrl(undefined), undefined);
    assert.equal(normalizeBaseUrl('ftp://gateway.example'), undefined);
  });
});

describe('端点构造', () => {
  it('在 /v1 下构造清单端点', () => {
    assert.equal(buildModelsEndpoint('https://ai.long-antares.ts.net'), 'https://ai.long-antares.ts.net/v1/models');
  });

  it('给 OpenAI 兼容路由带 /v1 的根地址', () => {
    assert.equal(
      buildRouteBaseUrl('https://ai.long-antares.ts.net', 'openai-completions'),
      'https://ai.long-antares.ts.net/v1',
    );
  });

  it('给 Anthropic 路由裸根地址，因为它的 SDK 自己会追加 /v1', () => {
    assert.equal(
      buildRouteBaseUrl('https://ai.long-antares.ts.net', 'anthropic-messages'),
      'https://ai.long-antares.ts.net',
    );
  });
});
