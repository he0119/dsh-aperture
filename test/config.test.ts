/**
 * 配置 schema 与解析测试。
 *
 * 这里有两条原则：schema 只留部署真的要改的东西（能推出来的、只该是常量的都不在
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

/**
 * 一个字段的 schema 元数据。
 *
 * 用来核**声明**本身（角色、有没有默认值），与解析出来的值无关：这两件事都写在 schema 上，
 * 而消费这份 schema 的是别的进程。
 *
 * @param name - 段内的字段名。
 * @returns 该字段的 `meta`，字段不存在时给一个空对象。
 */
function schemaMeta(name: string): { readonly role?: unknown; readonly default?: unknown } {
  const dict = (Config as unknown as {
    dict: Record<string, { meta?: { role?: unknown; default?: unknown } }>;
  }).dict;
  return dict[name]?.meta ?? {};
}

describe('配置 schema', () => {
  it('为裸行填充每一项默认值', () => {
    const value = defaults();
    // 键集本身就是一条承诺：能推出来的（另一条路由、两个显示名）、只该是常量的
    // （容量、超时、占位凭据）都不在这里，加回来得是一次刻意的决定。
    assert.deepEqual(Object.keys(value).sort(), [
      'baseUrl',
      'enabledModelIds',
      'headers',
      'images',
      'modelAliases',
      'modelMetadataUrl',
      'models',
      'reasoning',
      'refreshIntervalMinutes',
      'routePrefix',
      'sync',
    ]);
    assert.equal(value.baseUrl, '');
    assert.equal(value.routePrefix, 'aperture');
    // `apiKeyEnv` 不在名单里，也没有默认值：未设置就是整项缺失，不是空串（下一条用例）。
    assert.equal('apiKeyEnv' in value, false);
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

  it('把 apiKeyEnv 声明成凭据引用，未设置时整项缺失', () => {
    // 设置段的值会原样流到别的插件那里，而空串不是合法的引用名（`^[A-Za-z_][A-Za-z0-9_]*$`）：
    // 只要这一项存在，把「字符串」当成引用批量查询的客户端就会让整次查询被拒。
    assert.equal(schemaMeta('apiKeyEnv').role, 'credential-ref');
    assert.equal('default' in schemaMeta('apiKeyEnv'), false);
    assert.equal('apiKeyEnv' in defaults(), false);
    // 显式写过的那一份照旧原样保留，修剪留给 `resolveConfig`。
    assert.equal(configured({ apiKeyEnv: 'APERTURE_API_KEY' }).apiKeyEnv, 'APERTURE_API_KEY');
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
    assert.equal(resolved.routePrefix, 'aperture');
    assert.deepEqual(
      resolved.routes.map((route) => route.id),
      ['aperture-openai-chat-completions', 'aperture-openai-responses', 'aperture-anthropic-messages'],
    );
  });

  it('三条路由键与三个显示名都从前缀推出来，且每条都写出自己的协议', () => {
    // 一个部署要换的只是前缀：换成 `my-gateway` 之后三条路由的名字必须一起换，而不是各写各的。
    const derived = resolveConfig(configured({ routePrefix: 'my-gateway' }));
    assert.deepEqual(derived.routes.map((route) => route.id), [
      'my-gateway-openai-chat-completions',
      'my-gateway-openai-responses',
      'my-gateway-anthropic-messages',
    ]);
    assert.deepEqual(derived.routes.map((route) => route.displayName), [
      'My Gateway (OpenAI Chat Completions)',
      'My Gateway (OpenAI Responses)',
      'My Gateway (Anthropic Messages)',
    ]);

    const bare = resolveConfig(defaults());
    assert.deepEqual(bare.routes.map((route) => route.id), [
      'aperture-openai-chat-completions',
      'aperture-openai-responses',
      'aperture-anthropic-messages',
    ]);
    assert.deepEqual(bare.routes.map((route) => route.displayName), [
      'Aperture (OpenAI Chat Completions)',
      'Aperture (OpenAI Responses)',
      'Aperture (Anthropic Messages)',
    ]);
  });

  it('在 baseUrl 缺失时让插件保持休眠，而不是失败', () => {
    // profile 可以在任何人填写之前就带有该行 —— 这也正是设置命名空间最初变得可编辑的方式。
    assert.equal(resolveConfig(defaults()).instanceRoot, undefined);
    assert.equal(resolveConfig(configured({ baseUrl: 'not a url' })).instanceRoot, undefined);
  });

  it('拒绝永远无法匹配 provider 语法的路由名前缀', () => {
    assert.throws(
      () => resolveConfig(configured({ routePrefix: 'Aperture Route' })),
      /必须是小写连字符形式的路由名前缀/,
    );
    assert.throws(() => resolveConfig(configured({ routePrefix: '-x' })), /必须是小写连字符形式的路由名前缀/);
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
      () => resolveConfig(configured({ models: [{ id: 'gemini-2.5-pro', protocol: 'gemini' }] })),
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
