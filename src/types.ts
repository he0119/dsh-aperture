/**
 * Aperture 发现流水线的共享词汇表。
 *
 * 该流水线是一条纯函数链 —— 端点响应进，provider profile 出 —— 因此每个阶段都
 * 在这里命名自己的类型，而不去碰 Cordis 或设置的接缝：只有 `src/index.ts` 和
 * `src/sync.ts` 会接触服务。
 *
 * @module dsh-aperture/types
 */

/** 一个已发现模型可以声明的一种请求模态。 */
export type Modality = 'text' | 'image';

/**
 * 本插件发布的协议格式。两者都由已安装的 `dsh-llm-pi-ai` 适配器服务，这就是发现
 * 过程从不转换载荷的原因：它只决定每个模型在网关的哪些端点上应答。
 */
export type ApertureProtocol = 'openai-completions' | 'anthropic-messages';

/** 一项已归一化的事实的来源，用于 `/aperture` 报告中的诊断。 */
export type FactSource = 'aperture' | 'models.dev' | 'config' | 'default';

/** 已发现模型携带的每个值的来源。 */
export interface ModelProvenance {
  /** `contextWindow` 与 `maxTokens` 的来源。 */
  readonly limits: FactSource;
  /** `reasoning` 的来源。 */
  readonly reasoning: FactSource;
  /** `input` 的来源。 */
  readonly input: FactSource;
  /** `name` 的来源。 */
  readonly name: FactSource;
}

/** 经过归一化、补全与配置合并后的一个模型。 */
export interface DiscoveredModel {
  /** Aperture 接受的模型 id。 */
  readonly id: string;
  /** 供选择器使用的显示名。 */
  readonly name: string;
  /**
   * 模型可访问所用的协议，由网关的 `supported_endpoints` 推导得出。网关没有提供
   * 本插件可服务的端点时缺失。
   */
  readonly protocol?: ApertureProtocol;
  /** 网关为该模型通告的每一个端点，用于诊断。 */
  readonly endpoints: readonly string[];
  /** 请求与响应合计的最大上下文长度，以 token 计。 */
  readonly contextWindow?: number;
  /** 最大输出 token 数。 */
  readonly maxTokens?: number;
  /** 为该模型声明的请求模态。 */
  readonly input: readonly Modality[];
  /** 该模型是否接受推理档位控制。 */
  readonly reasoning: boolean;
  /** 网关上报的上游 provider id，在上报时提供。 */
  readonly provider?: string;
  /** 每项事实的来源。 */
  readonly provenance: ModelProvenance;
}

/**
 * 插件 `models` 配置列表中的一条条目。
 *
 * id 也被端点通告的条目只覆盖它声明的字段；命名未知 id 的条目会作为额外模型加入，
 * 网关少报时正是靠这一点保持可用。
 */
export interface ConfiguredModel {
  /** 模型 id；与端点通告的 id 匹配，或新增一个。 */
  readonly id: string;
  /** 显示名。 */
  readonly name?: string;
  /** 协议覆盖；也是服务 Aperture 只在未服务端点上通告的模型的唯一方式。 */
  readonly api?: string;
  /** 上下文容量，以 token 计。 */
  readonly contextWindow?: number;
  /** 输出容量，以 token 计。 */
  readonly maxTokens?: number;
  /** 请求模态。 */
  readonly input?: readonly Modality[];
  /** 强制打开（`true`）或关闭（`false`）推理能力。 */
  readonly thinking?: boolean;
  /** 显式可选的推理档位：key = 档位，value = 协议格式中的写法。 */
  readonly reasoningEfforts?: Readonly<Record<string, string | null>>;
}

/** 流水线把一个网关变成 provider profile 所需的全部内容。 */
export interface BuildOptions {
  /** 配置的覆盖项与额外项。 */
  readonly models: readonly ConfiguredModel[];
  /** 非空时把清单限制为这些 id。 */
  readonly enabledModelIds: readonly string[];
  /**
   * 网关模型 id → 清单模型 id，在两者不一致时使用。
   *
   * 网关会改名：这个网关把 DeepSeek 的 flash 模型服务为 `deepseek-flash`，把 Kimi
   * 的服务为 `k3`，任何评分规则都无法在不猜测的情况下弥合这一差异。
   */
  readonly modelAliases: Readonly<Record<string, string>>;
  /** 没有任何来源设定容量的模型的兜底上下文容量。 */
  readonly defaultContextWindow: number;
  /** 是否采纳 models.dev 的输入模态（图像）。 */
  readonly images: 'ignore' | 'metadata';
  /** `auto` 映射推理能力；`off` 把每个模型都声明为非推理。 */
  readonly reasoning: 'auto' | 'off';
}

/** 一次清单查找可以为模型贡献的元数据。 */
export interface CatalogMetadata {
  /** 上下文容量，以 token 计。 */
  readonly contextWindow?: number;
  /** 输出容量，以 token 计。 */
  readonly maxTokens?: number;
  /** 该模型是否接受推理档位控制。 */
  readonly reasoning?: boolean;
  /** 请求模态。 */
  readonly input?: readonly Modality[];
  /** 人类可读的名称。 */
  readonly name?: string;
}

/** 为一个端点通告的模型查找清单元数据。 */
export type CatalogLookup = (model: {
  readonly id: string;
  readonly provider?: string;
  readonly providerName?: string;
}) => CatalogMetadata | undefined;
