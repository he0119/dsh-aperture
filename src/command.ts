/**
 * The `/aperture` command.
 *
 * Discovery is silent by design — it runs at load and on configuration change
 * and publishes what it finds — so the command is the surface that makes it
 * observable and the only way to force a refresh without editing a file.
 *
 * @module dsh-aperture/command
 */

import type { Context } from '@deepseek-ai/cordis';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import type { ResolvedConfig } from './config.ts';
import { formatModels, formatStatus } from './report.ts';
import { message, type ApertureRuntime } from './runtime.ts';

/** Registered command name, without the leading slash. */
export const COMMAND_NAME = 'aperture';

/** The sub-commands the command accepts. */
const USAGE = [
  'usage: /aperture [status|models|refresh|remove]',
  '  status   what the last refresh did (default)',
  '  models   every discovered model, its route, and where each fact came from',
  '  refresh  discover again and republish',
  '  remove   withdraw this plugin\'s routes from the llm-pi-ai settings section',
].join('\n');

/**
 * Register `/aperture` on the command registry.
 *
 * @param ctx - a context that has the `commands` service.
 * @param runtime - the discovery runtime.
 * @param config - thunk returning the currently authoritative configuration.
 */
export function registerApertureCommand(
  ctx: Context,
  runtime: ApertureRuntime,
  config: () => ResolvedConfig,
): void {
  ctx.commands.register({
    name: COMMAND_NAME,
    description: 'Aperture model discovery: status, discovered models, refresh, remove',
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
            const outcome = await runtime.refresh('command');
            const text = formatStatus(outcome, config());
            return outcome.ok ? { kind: 'success', text } : { kind: 'error', text };
          }
          case 'remove':
            return { kind: 'success', text: await runtime.remove() };
          default:
            return { kind: 'error', text: `unknown sub-command "${subCommand}"\n${USAGE}` };
        }
      } catch (error) {
        return { kind: 'error', text: `/aperture ${subCommand ?? ''} failed: ${message(error)}` };
      }
    },
  });
}
