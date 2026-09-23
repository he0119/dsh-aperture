/**
 * Human-readable rendering for the `/aperture` command.
 *
 * A command result is the only place a deployment can see what discovery
 * decided without reading `settings.yaml`: which endpoint answered, which
 * models went to which route, which one no route could serve, and where each
 * fact came from. So the report says all of that, and says it in the same shape
 * the failures use — one line per fact, no tables to align.
 *
 * @module dsh-aperture/report
 */

import type { ResolvedConfig } from './config.ts';
import { formatModalities, describeProvenance } from './registry.ts';
import type { RefreshOutcome } from './runtime.ts';
import type { DiscoveredModel } from './types.ts';

/** Thousands separators for token counts. */
const COUNT = new Intl.NumberFormat('en-US');

/** One-line status of the last refresh, plus the routes it published. */
export function formatStatus(outcome: RefreshOutcome | undefined, config: ResolvedConfig): string {
  const where = config.instanceRoot ?? (config.rawBaseUrl.length === 0 ? '(no baseUrl configured)' : config.rawBaseUrl);
  const lines: string[] = [`Aperture: ${where}`];

  if (outcome === undefined) {
    lines.push('  no refresh has completed yet');
    return lines.join('\n');
  }

  lines.push(
    `  last refresh: ${outcome.trigger} · ${outcome.at.toISOString()} · ${outcome.durationMs}ms · ${outcome.ok ? 'ok' : 'failed'}`,
  );
  if (outcome.error !== undefined) {
    lines.push(`  error: ${outcome.error}`);
  }
  lines.push(
    outcome.catalog.lookup === undefined
      ? `  catalog: unavailable (${outcome.catalog.reason ?? 'unknown reason'})`
      : `  catalog: ${outcome.catalog.entries} entries`,
  );
  if (outcome.endpoint !== undefined) {
    lines.push(`  endpoint: ${outcome.endpoint} listed ${outcome.listed} row(s)`);
  }

  if (outcome.routes.length === 0) {
    lines.push('  routes: none');
  } else {
    for (const route of outcome.routes) {
      lines.push(
        `  route ${route.provider}: ${route.models.length} model(s) via ${route.profile.api} → ${route.profile.baseURL}`,
      );
    }
  }

  if (outcome.unserved.length > 0) {
    lines.push(
      `  unserved: ${outcome.unserved.length} model(s) (${outcome.unserved.map((model) => model.id).join(', ')})`,
    );
  }

  const sync = outcome.sync;
  if (sync !== undefined) {
    lines.push(
      sync.applied
        ? `  settings: wrote ${sync.ops} op(s) to llm-pi-ai (${sync.routes.join(', ') || 'removals only'})`
        : `  settings: no write (${sync.reason ?? 'unknown reason'})`,
    );
  }
  return lines.join('\n');
}

/** Per-model listing, grouped by route, with provenance. */
export function formatModels(outcome: RefreshOutcome | undefined): string {
  if (outcome === undefined) {
    return 'no refresh has completed yet; run /aperture refresh';
  }
  if (outcome.models.length === 0) {
    return outcome.error === undefined ? 'no models were discovered' : `nothing discovered: ${outcome.error}`;
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
    lines.push('unserved (no endpoint this plugin can publish)');
    for (const model of unserved) {
      const endpoints = model.endpoints.length === 0 ? 'no advertised endpoints' : model.endpoints.join(', ');
      lines.push(`  ${model.id} — ${endpoints}`);
    }
  }
  return lines.join('\n');
}

/** One model line: name, sizes, modalities, reasoning, provenance. */
function formatModel(model: DiscoveredModel): string {
  const facts = [
    `${COUNT.format(model.contextWindow ?? 0)} ctx`,
    model.maxTokens === undefined ? undefined : `${COUNT.format(model.maxTokens)} out`,
    formatModalities(model.input),
    model.reasoning ? 'reasoning' : 'no reasoning',
    describeProvenance(model.provenance),
  ].filter((fact): fact is string => fact !== undefined);
  const label = model.name === model.id ? '' : ` (${model.name})`;
  return `${model.id}${label} — ${facts.join(' · ')}`;
}
