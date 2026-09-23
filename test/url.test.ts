import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildModelsEndpoint, buildRouteBaseUrl, normalizeBaseUrl } from '../src/url.ts';

describe('normalizeBaseUrl', () => {
  it('keeps a clean HTTPS root as-is', () => {
    assert.equal(normalizeBaseUrl('https://ai.long-antares.ts.net'), 'https://ai.long-antares.ts.net');
  });

  it('strips trailing slashes', () => {
    assert.equal(normalizeBaseUrl('https://ai.long-antares.ts.net/'), 'https://ai.long-antares.ts.net');
    assert.equal(normalizeBaseUrl('  https://ai.long-antares.ts.net///  '), 'https://ai.long-antares.ts.net');
  });

  it('tolerates the trailing /v1 the VS Code extension documents', () => {
    assert.equal(normalizeBaseUrl('https://ai.long-antares.ts.net/v1'), 'https://ai.long-antares.ts.net');
    assert.equal(normalizeBaseUrl('https://ai.long-antares.ts.net/v1/'), 'https://ai.long-antares.ts.net');
  });

  it('assumes HTTPS for a bare host', () => {
    assert.equal(normalizeBaseUrl('ai.long-antares.ts.net'), 'https://ai.long-antares.ts.net');
  });

  it('drops the query and fragment and keeps a path prefix', () => {
    assert.equal(normalizeBaseUrl('https://gateway.example/llm/?x=1#frag'), 'https://gateway.example/llm');
  });

  it('keeps an http root', () => {
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  });

  it('rejects an empty or unusable value', () => {
    assert.equal(normalizeBaseUrl(''), undefined);
    assert.equal(normalizeBaseUrl('   '), undefined);
    assert.equal(normalizeBaseUrl(undefined), undefined);
    assert.equal(normalizeBaseUrl('ftp://gateway.example'), undefined);
  });
});

describe('endpoint construction', () => {
  it('builds the listing endpoint under /v1', () => {
    assert.equal(buildModelsEndpoint('https://ai.long-antares.ts.net'), 'https://ai.long-antares.ts.net/v1/models');
  });

  it('gives the OpenAI-compatible route the /v1 root', () => {
    assert.equal(
      buildRouteBaseUrl('https://ai.long-antares.ts.net', 'openai-completions'),
      'https://ai.long-antares.ts.net/v1',
    );
  });

  it('gives the Anthropic route the bare root, because its SDK appends /v1 itself', () => {
    assert.equal(
      buildRouteBaseUrl('https://ai.long-antares.ts.net', 'anthropic-messages'),
      'https://ai.long-antares.ts.net',
    );
  });
});
