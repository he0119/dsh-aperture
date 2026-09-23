/**
 * 本插件夹在中间的两个设置命名空间。
 *
 * 从 `config.ts` 里分出来，是为了让发布路径不依赖配置 schema——也让这条纯函数
 * 流水线能在不加载 schema 库的情况下被测试。
 *
 * @module dsh-aperture/namespaces
 */

/** 本插件拥有、并可通过它配置的设置命名空间。 */
export const APERTURE_NAMESPACE = 'aperture';

/** pi-ai 适配器注册的设置命名空间，也是本插件写入的那一个。 */
export const PI_AI_NAMESPACE = 'llm-pi-ai';
