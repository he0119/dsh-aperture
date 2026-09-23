/**
 * `/aperture` 命令。
 *
 * 发现过程按设计是静默的——它在加载时与配置变更时运行，并发布自己发现的内容——因此
 * 该命令是让它可被观测的界面，也是不编辑文件就能强制刷新的唯一途径。
 *
 * @module dsh-aperture/command
 */

import type { Context } from '@deepseek-ai/cordis';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import type { ResolvedConfig } from './config.ts';
import { formatModels, formatStatus } from './report.ts';
import { message, type ApertureRuntime } from './runtime.ts';

/** 注册的命令名，不含前导斜杠。 */
export const COMMAND_NAME = 'aperture';

/** 该命令接受的子命令。 */
const USAGE = [
  '用法：/aperture [status|models|refresh|remove]',
  '  status   最近一次刷新做了什么（默认）',
  '  models   每个已发现的模型、它所在的路由，以及每条事实的来源',
  '  refresh  重新发现并重新发布',
  '  remove   从 llm-pi-ai 设置配置段中撤出本插件的路由',
].join('\n');

/**
 * 在命令注册表上注册 `/aperture`。
 *
 * @param ctx - 带有 `commands` 服务的上下文。
 * @param runtime - 发现运行时。
 * @param config - 返回当前生效配置的活引用（thunk）。
 */
export function registerApertureCommand(
  ctx: Context,
  runtime: ApertureRuntime,
  config: () => ResolvedConfig,
): void {
  ctx.commands.register({
    name: COMMAND_NAME,
    description: 'Aperture 模型发现：状态、已发现的模型、刷新、移除',
    recordInput: false,
    handler: async ({ rawInput }): Promise<CommandResult> => {
      const [subCommand] = rawInput.trim().split(/\s+/u).filter((token) => token.length > 0);
      try {
        switch (subCommand) {
          case undefined:
          case 'status':
            return { kind: 'success', text: formatStatus(runtime.last(), config()) };
          case 'models':
            return { kind: 'success', text: formatModels(runtime.last()) };
          case 'refresh': {
            const outcome = await runtime.refresh('命令');
            const text = formatStatus(outcome, config());
            return outcome.ok ? { kind: 'success', text } : { kind: 'error', text };
          }
          case 'remove':
            return { kind: 'success', text: await runtime.remove() };
          default:
            return { kind: 'error', text: `未知子命令 "${subCommand}"\n${USAGE}` };
        }
      } catch (error) {
        return { kind: 'error', text: `/aperture ${subCommand ?? ''} 执行失败：${message(error)}` };
      }
    },
  });
}
