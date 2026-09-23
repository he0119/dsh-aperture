/**
 * 配置 schema 与解析测试。
 *
 * harness 的约定是：部署可能需要改动的任何内容都是配置字段，且非法配置必须在加载时
 * 失败，而不是静默降级。这两半只有在被钉死时才成立，因此本文件检验 schema 的默认值
 * 与拒绝行为，以及 `resolveConfig` 在其之上添加的跨字段规则。
 *
 * @module dsh-aperture/test/config
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Config,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL_METADATA_URL,
  resolveConfig,
} from '../src/config.ts';

/** 一条裸组合行所产生的、全部取默认值的配置。 */
function defaults() {
  return Config({});
}

/**
 * schema 是否接受某一个值。
 *
 * 入参刻意使用宽松类型：这些用例正是手写 YAML 文档可能包含的内容，而必须拒绝它们的
 * 是 schema，不是 TypeScript 签名。
 */
function accepts(value: Record<string, unknown>): boolean {
  try {
    Config(value as Parameters<typeof Config>[0]);
    return true;
  } catch {
    return false;
  }
}

describe('配置 schema', () => {
  it('为裸行填充每一项默认值', () => {
    const value = defaults();
    assert.equal(value.baseUrl, '');
    assert.equal(value.route, 'aperture');
    assert.equal(value.anthropicRoute, 'aperture-anthropic');
    assert.equal(value.displayName, 'Aperture');
    assert.equal(value.anthropicDisplayName, 'Aperture (Anthropic)');
    assert.equal(value.apiKeyEnv, '');
    assert.equal(value.placeholderCredential, 'dsh-aperture');
    assert.deepEqual(value.headers, {});
    assert.deepEqual(value.enabledModelIds, []);
    assert.deepEqual(value.modelAliases, {});
    assert.deepEqual(value.models, []);
    assert.equal(value.modelMetadataUrl, DEFAULT_MODEL_METADATA_URL);
    assert.equal(value.defaultContextWindow, DEFAULT_CONTEXT_WINDOW);
    assert.equal(value.images, 'ignore');
    assert.equal(value.reasoning, 'auto');
    assert.equal(value.sync, true);
    assert.equal(value.refreshIntervalMinutes, 0);
    assert.equal(value.timeoutMs, 20_000);
  });

  it('保留部署所设置的内容', () => {
    const value = Config({
      baseUrl: 'https://ai.example.ts.net',
      reasoning: 'off',
      images: 'metadata',
      sync: false,
      refreshIntervalMinutes: 30,
      modelAliases: { k3: 'moonshotai/kimi-k3' },
      models: [{ id: 'deepseek-flash', thinking: true, reasoningEfforts: { off: 'disabled', high: 'high' } }],
    });
    assert.equal(value.baseUrl, 'https://ai.example.ts.net');
    assert.equal(value.reasoning, 'off');
    assert.equal(value.images, 'metadata');
    assert.equal(value.sync, false);
    assert.equal(value.refreshIntervalMinutes, 30);
    assert.equal(value.modelAliases.k3, 'moonshotai/kimi-k3');
    assert.equal(value.models[0]?.thinking, true);
  });

  it('拒绝词表之外的枚举值，而不是回退', () => {
    assert.equal(accepts({ images: 'yes' }), false);
    assert.equal(accepts({ reasoning: 'maybe' }), false);
  });

  it('拒绝类型错误的原始值', () => {
    assert.equal(accepts({ timeoutMs: 'soon' }), false);
    assert.equal(accepts({ sync: 'no' }), false);
    assert.equal(accepts({ models: 'deepseek-flash' }), false);
  });

  it('拒绝缺少 id 的模型条目', () => {
    assert.equal(accepts({ models: [{ name: 'nameless' }] }), false);
  });
});

describe('resolveConfig', () => {
  it('规范化实例根地址并拆分两个路由', () => {
    const resolved = resolveConfig(Config({ baseUrl: 'https://ai.example.ts.net/v1/' }));
    assert.equal(resolved.instanceRoot, 'https://ai.example.ts.net');
    assert.equal(resolved.rawBaseUrl, 'https://ai.example.ts.net/v1/');
    assert.equal(resolved.route, 'aperture');
    assert.equal(resolved.anthropicRoute, 'aperture-anthropic');
  });

  it('在 baseUrl 缺失时让插件保持休眠，而不是失败', () => {
    // profile 可以在任何人填写之前就带有该行 —— 这也正是设置命名空间最初变得可编辑的方式。
    assert.equal(resolveConfig(defaults()).instanceRoot, undefined);
    assert.equal(resolveConfig(Config({ baseUrl: 'not a url' })).instanceRoot, undefined);
  });

  it('拒绝永远无法匹配 provider 语法的路由键', () => {
    assert.throws(() => resolveConfig(Config({ route: 'Aperture Route' })), /必须是小写连字符形式的 provider 路由名/);
    assert.throws(() => resolveConfig(Config({ anthropicRoute: '-x' })), /anthropicRoute/);
  });

  it('拒绝两个路由使用同一个键', () => {
    assert.throws(() => resolveConfig(Config({ anthropicRoute: 'aperture' })), /不能相同/);
  });

  it('拒绝重复或为空的模型 id', () => {
    assert.throws(
      () => resolveConfig(Config({ models: [{ id: 'a' }, { id: 'a' }] })),
      /重复列出了 "a"/,
    );
    assert.throws(() => resolveConfig(Config({ models: [{ id: '   ' }] })), /不能为空/);
  });

  it('拒绝被钉到无人可服务协议上的模型', () => {
    assert.throws(
      () => resolveConfig(Config({ models: [{ id: 'gemini-2.5-pro', api: 'gemini' }] })),
      /无法服务/,
    );
  });

  it('把空白的 apiKeyEnv 与空白显示名视为未设置', () => {
    const resolved = resolveConfig(Config({ apiKeyEnv: '   ', displayName: '  ', anthropicDisplayName: '' }));
    assert.equal(resolved.apiKeyEnv, undefined);
    assert.equal(resolved.displayName, 'Aperture');
    assert.equal(resolved.anthropicDisplayName, 'Aperture (Anthropic)');
  });

  it('保留真实凭据引用并修剪传入的名称', () => {
    const resolved = resolveConfig(
      Config({ apiKeyEnv: ' APERTURE_API_KEY ', displayName: ' Aperture ', anthropicDisplayName: 'Aperture (A)' }),
    );
    assert.equal(resolved.apiKeyEnv, 'APERTURE_API_KEY');
    assert.equal(resolved.displayName, 'Aperture');
    assert.equal(resolved.anthropicDisplayName, 'Aperture (A)');
  });

  it('把已禁用的清单 URL 默认为空值，而非内置值', () => {
    assert.equal(resolveConfig(Config({ modelMetadataUrl: '' })).modelMetadataUrl, '');
    assert.equal(resolveConfig(defaults()).modelMetadataUrl, DEFAULT_MODEL_METADATA_URL);
  });
});
