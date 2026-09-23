/**
 * `/aperture` 命令的人类可读渲染。
 *
 * 在不读 `settings.yaml` 的前提下，命令输出是部署方唯一能看到发现过程决定了什么的
 * 地方：哪个端点应答了、哪些模型进了哪条路由、哪个模型没有任何路由能服务，以及每条
 * 事实来自哪里。因此报告会把这些全部讲出来，并使用与失败信息相同的形态——每条事实
 * 一行，不用表格对齐。
 *
 * @module dsh-aperture/report
 */

import type { ResolvedConfig } from './config.ts';
import { formatModalities, describeProvenance } from './registry.ts';
import type { RefreshOutcome } from './runtime.ts';
import type { DiscoveredModel } from './types.ts';

/** token 计数的千位分隔符。 */
const COUNT = new Intl.NumberFormat('en-US');

/** 最近一次刷新的单行状态，以及它发布的路由。 */
export function formatStatus(outcome: RefreshOutcome | undefined, config: ResolvedConfig): string {
  const where = config.instanceRoot ?? (config.rawBaseUrl.length === 0 ? '(未配置 baseUrl)' : config.rawBaseUrl);
  const lines: string[] = [`Aperture：${where}`];

  if (outcome === undefined) {
    lines.push('  尚未完成任何刷新');
    return lines.join('\n');
  }

  lines.push(
    `  最近一次刷新：${outcome.trigger} · ${outcome.at.toISOString()} · ${outcome.durationMs}ms · ${outcome.ok ? '成功' : '失败'}`,
  );
  if (outcome.error !== undefined) {
    lines.push(`  错误：${outcome.error}`);
  }
  lines.push(
    outcome.catalog.lookup === undefined
      ? `  清单：不可用（${outcome.catalog.reason ?? '原因未知'}）`
      : `  清单：${outcome.catalog.entries} 个条目`,
  );
  if (outcome.endpoint !== undefined) {
    lines.push(`  端点：${outcome.endpoint} 列出了 ${outcome.listed} 行`);
  }

  if (outcome.routes.length === 0) {
    lines.push('  路由：无');
  } else {
    for (const route of outcome.routes) {
      lines.push(
        `  路由 ${route.provider}：${route.models.length} 个模型，经由 ${route.profile.api} → ${route.profile.baseURL}`,
      );
    }
  }

  if (outcome.unserved.length > 0) {
    lines.push(
      `  未服务：${outcome.unserved.length} 个模型（${outcome.unserved.map((model) => model.id).join(', ')}）`,
    );
  }

  const sync = outcome.sync;
  if (sync !== undefined) {
    lines.push(
      sync.applied
        ? `  设置：向 llm-pi-ai 写入 ${sync.ops} 个操作（${sync.routes.join(', ') || '仅移除'}）`
        : `  设置：未写入（${sync.reason ?? '原因未知'}）`,
    );
  }
  return lines.join('\n');
}

/** 按路由分组的逐模型清单，带来源信息。 */
export function formatModels(outcome: RefreshOutcome | undefined): string {
  if (outcome === undefined) {
    return '尚未完成任何刷新；请运行 /aperture refresh';
  }
  if (outcome.models.length === 0) {
    return outcome.error === undefined ? '未发现任何模型' : `未发现任何内容：${outcome.error}`;
  }

  const lines: string[] = [];
  const routed = new Set<string>();
  for (const route of outcome.routes) {
    lines.push(`${route.provider} (${route.profile.api})`);
    for (const model of route.models) {
      routed.add(model.id);
      lines.push(`  ${formatModel(model)}`);
    }
  }

  const unserved = outcome.models.filter((model) => !routed.has(model.id));
  if (unserved.length > 0) {
    lines.push('未服务（没有本插件可发布的端点）');
    for (const model of unserved) {
      const endpoints = model.endpoints.length === 0 ? '未通告任何端点' : model.endpoints.join(', ');
      lines.push(`  ${model.id} — ${endpoints}`);
    }
  }
  return lines.join('\n');
}

/** 单行模型信息：名称、尺寸、模态、推理、来源。 */
function formatModel(model: DiscoveredModel): string {
  const facts = [
    `${COUNT.format(model.contextWindow ?? 0)} 上下文窗口`,
    model.maxTokens === undefined ? undefined : `${COUNT.format(model.maxTokens)} 输出`,
    formatModalities(model.input),
    model.reasoning ? '推理' : '无推理',
    describeProvenance(model.provenance),
  ].filter((fact): fact is string => fact !== undefined);
  const label = model.name === model.id ? '' : ` (${model.name})`;
  return `${model.id}${label} — ${facts.join(' · ')}`;
}
