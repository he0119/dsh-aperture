/**
 * 配置 schema 与解析测试。
 *
 * 写在这里的两半：schema 只留部署真的要改的东西（能推出来的、只该是常量的都不在
 * 里面），且非法配置必须在加载时失败，而不是静默降级。因此本文件检验 schema 的
 * 键集、默认值与拒绝行为，以及 `resolveConfig` 在其之上添加的推导与跨字段规则。
 *
 * 根级 volatile 把 schema 的返回值变成活引用，但**没有**把校验挪走：非法值仍然在
 * `Config(raw)` 当场抛出。因此这里读值统一走 `configValue`（`get()` 加空值兜底），而
 * 拒绝用例照旧只看调用是否抛出。
 *
 * @module dsh-aperture/test/config
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Config,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL_METADATA_URL,
  DEFAULT_TIMEOUT_MS,
  configValue,
  memoizedConfig,
  resolveConfig,
  type FilledConfig,
} from '../src/config.ts';

/**
 * 把一段手写的配置段（YAML 里那一行 `config:` 的内容）解析成补齐默认值的普通值。
 *
 * @param value - schema 接受的原始配置段。
 * @returns 补齐默认值后的配置值。
 */
function configured(value: Parameters<typeof Config>[0]): FilledConfig {
  return configValue(Config(value));
}

/** 一条裸组合行所产生的、全部取默认值的配置。 */
function defaults(): FilledConfig {
  return configured({});
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
    // 键集本身就是一条承诺：能推出来的（另一条路由、两个显示名）、只该是常量的
    // （容量、超时、占位凭据）都不在这里，加回来得是一次刻意的决定。
    assert.deepEqual(Object.keys(value).sort(), [
      'apiKeyEnv',
      'baseUrl',
      'enabledModelIds',
      'headers',
      'images',
      'modelAliases',
      'modelMetadataUrl',
      'models',
      'reasoning',
      'refreshIntervalMinutes',
      'route',
      'sync',
    ]);
    assert.equal(value.baseUrl, '');
    assert.equal(value.route, 'aperture');
    assert.equal(value.apiKeyEnv, '');
    assert.deepEqual(value.headers, {});
    assert.deepEqual(value.enabledModelIds, []);
    assert.deepEqual(value.modelAliases, {});
    assert.deepEqual(value.models, []);
    assert.equal(value.modelMetadataUrl, DEFAULT_MODEL_METADATA_URL);
    assert.equal(value.images, 'ignore');
    assert.equal(value.reasoning, 'auto');
    assert.equal(value.sync, true);
    assert.equal(value.refreshIntervalMinutes, 0);
  });

  it('不再是配置项的那两个数字仍然钉着值', () => {
    assert.equal(DEFAULT_CONTEXT_WINDOW, 128_000);
    assert.equal(DEFAULT_TIMEOUT_MS, 20_000);
  });

  it('保留部署所设置的内容', () => {
    const value = configured({
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
    assert.equal(accepts({ refreshIntervalMinutes: 'soon' }), false);
    assert.equal(accepts({ sync: 'no' }), false);
    assert.equal(accepts({ models: 'deepseek-flash' }), false);
  });

  it('拒绝缺少 id 的模型条目', () => {
    assert.equal(accepts({ models: [{ name: 'nameless' }] }), false);
  });
});

describe('resolveConfig', () => {
  it('规范化实例根地址', () => {
    const resolved = resolveConfig(configured({ baseUrl: 'https://ai.example.ts.net/v1/' }));
    assert.equal(resolved.instanceRoot, 'https://ai.example.ts.net');
    assert.equal(resolved.rawBaseUrl, 'https://ai.example.ts.net/v1/');
    assert.equal(resolved.route, 'aperture');
  });

  it('另一条路由与两个显示名都从路由键推出来', () => {
    // 一个部署要换的只是前缀：换成 `my-gateway` 之后四处名字必须一起换，而不是各写各的。
    const derived = resolveConfig(configured({ route: 'my-gateway' }));
    assert.equal(derived.anthropicRoute, 'my-gateway-anthropic');
    assert.equal(derived.displayName, 'My Gateway');
    assert.equal(derived.anthropicDisplayName, 'My Gateway (Anthropic)');

    const bare = resolveConfig(defaults());
    assert.equal(bare.anthropicRoute, 'aperture-anthropic');
    assert.equal(bare.displayName, 'Aperture');
    assert.equal(bare.anthropicDisplayName, 'Aperture (Anthropic)');
  });

  it('在 baseUrl 缺失时让插件保持休眠，而不是失败', () => {
    // profile 可以在任何人填写之前就带有该行 —— 这也正是设置命名空间最初变得可编辑的方式。
    assert.equal(resolveConfig(defaults()).instanceRoot, undefined);
    assert.equal(resolveConfig(configured({ baseUrl: 'not a url' })).instanceRoot, undefined);
  });

  it('拒绝永远无法匹配 provider 语法的路由键', () => {
    assert.throws(() => resolveConfig(configured({ route: 'Aperture Route' })), /必须是小写连字符形式的 provider 路由名/);
    assert.throws(() => resolveConfig(configured({ route: '-x' })), /必须是小写连字符形式的 provider 路由名/);
  });

  it('拒绝重复或为空的模型 id', () => {
    assert.throws(
      () => resolveConfig(configured({ models: [{ id: 'a' }, { id: 'a' }] })),
      /重复列出了 "a"/,
    );
    assert.throws(() => resolveConfig(configured({ models: [{ id: '   ' }] })), /不能为空/);
  });

  it('拒绝被钉到无人可服务协议上的模型', () => {
    assert.throws(
      () => resolveConfig(configured({ models: [{ id: 'gemini-2.5-pro', api: 'gemini' }] })),
      /无法服务/,
    );
  });

  it('把空白的 apiKeyEnv 视为未配置', () => {
    assert.equal(resolveConfig(configured({ apiKeyEnv: '   ' })).apiKeyEnv, undefined);
  });

  it('修剪传入的凭据引用', () => {
    assert.equal(resolveConfig(configured({ apiKeyEnv: ' APERTURE_API_KEY ' })).apiKeyEnv, 'APERTURE_API_KEY');
  });

  it('把已禁用的清单 URL 默认为空值，而非内置值', () => {
    assert.equal(resolveConfig(configured({ modelMetadataUrl: '' })).modelMetadataUrl, '');
    assert.equal(resolveConfig(defaults()).modelMetadataUrl, DEFAULT_MODEL_METADATA_URL);
  });
});

describe('memoizedConfig', () => {
  it('源没换时给同一个对象，换了就是新版本', () => {
    // 活引用的 `get()` 只在值真的变了之后才换一份快照：这正是这里当作「配置版本」的东西。
    let current = configured({ baseUrl: 'https://ai.example.ts.net' });
    const read = memoizedConfig(() => current);

    const first = read();
    assert.equal(read(), first, '设置服务没提交时，解析结果还是同一份');

    // 设置服务每次提交都换一份深冻结的解析结果；换了对象才是新版本。
    current = configured({ baseUrl: 'https://other.example.ts.net' });
    const second = read();
    assert.notEqual(second, first, '换了源就得重新解析');
    assert.equal(second.rawBaseUrl, 'https://other.example.ts.net');
  });
});
