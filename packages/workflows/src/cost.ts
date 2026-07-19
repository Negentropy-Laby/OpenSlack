import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const WORKFLOW_COST_SCHEMA = 'openslack.workflow_cost.v1';
export const DEFAULT_BUDGET_WARNING_THRESHOLD = 0.8;

export interface WorkflowCostRate {
  provider: string;
  model: string;
  total_per_1m_tokens_usd: number;
}

export interface WorkflowCostConfig {
  schema: typeof WORKFLOW_COST_SCHEMA;
  warning_threshold?: number;
  rates: WorkflowCostRate[];
}

export type WorkflowCostEstimate =
  | {
      known: true;
      provider: string;
      model: string;
      tokens: number;
      estimatedUsd: number;
      source: 'config';
      rate: number;
    }
  | {
      known: false;
      provider?: string;
      model?: string;
      tokens: number;
      source: 'missing-config' | 'unknown-rate';
      reason: string;
    };

export async function loadWorkflowCostConfig(
  rootDir: string = process.cwd(),
): Promise<WorkflowCostConfig | null> {
  const configPath = resolve(rootDir, '.openslack', 'workflows', 'cost.yaml');
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === 'ENOENT') return null;
    throw err;
  }

  const parsed = parseYaml(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${join('.openslack', 'workflows', 'cost.yaml')} must contain a YAML object.`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema !== WORKFLOW_COST_SCHEMA) {
    throw new Error(`Workflow cost config schema must be ${WORKFLOW_COST_SCHEMA}.`);
  }

  const rates = parseRates(obj.rates);
  const warningThreshold =
    typeof obj.warning_threshold === 'number' ? obj.warning_threshold : undefined;
  if (warningThreshold !== undefined && (warningThreshold <= 0 || warningThreshold > 1)) {
    throw new Error('Workflow cost config warning_threshold must be > 0 and <= 1.');
  }

  return {
    schema: WORKFLOW_COST_SCHEMA,
    warning_threshold: warningThreshold,
    rates,
  };
}

export function getBudgetWarningThreshold(config: WorkflowCostConfig | null): number {
  return config?.warning_threshold ?? DEFAULT_BUDGET_WARNING_THRESHOLD;
}

export function estimateWorkflowAgentCost(options: {
  config: WorkflowCostConfig | null;
  provider?: string;
  model?: string;
  tokens: number;
}): WorkflowCostEstimate {
  const tokens = Math.max(0, options.tokens);
  const provider = options.provider;
  const model = options.model;
  if (!options.config) {
    return {
      known: false,
      provider,
      model,
      tokens,
      source: 'missing-config',
      reason: 'Workflow cost config not found.',
    };
  }
  if (!provider || !model) {
    return {
      known: false,
      provider,
      model,
      tokens,
      source: 'unknown-rate',
      reason: 'Agent provider or model was not recorded.',
    };
  }
  const rate = options.config.rates.find(
    (item) => item.provider === provider && item.model === model,
  );
  if (!rate) {
    return {
      known: false,
      provider,
      model,
      tokens,
      source: 'unknown-rate',
      reason: `No workflow cost rate configured for ${provider}/${model}.`,
    };
  }
  return {
    known: true,
    provider,
    model,
    tokens,
    estimatedUsd: (tokens / 1_000_000) * rate.total_per_1m_tokens_usd,
    source: 'config',
    rate: rate.total_per_1m_tokens_usd,
  };
}

function parseRates(value: unknown): WorkflowCostRate[] {
  if (!Array.isArray(value)) return [];
  const rates: WorkflowCostRate[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (
      typeof row.provider === 'string' &&
      typeof row.model === 'string' &&
      typeof row.total_per_1m_tokens_usd === 'number' &&
      row.total_per_1m_tokens_usd >= 0
    ) {
      rates.push({
        provider: row.provider,
        model: row.model,
        total_per_1m_tokens_usd: row.total_per_1m_tokens_usd,
      });
    }
  }
  return rates;
}
