import { parseIntent } from './intent.js';
import type { Intent, IntentKind } from './types.js';
import { listRegisteredActions, type RegisteredActionCall } from './tool-registry.js';

export const LLM_PLANNER_MAX_TOOL_STEPS = 6;
export const LLM_PLANNER_MAX_REPLANS = 2;
export const LLM_PLANNER_MAX_RETRIES = 1;

export interface LLMPlannerRequest {
  query: string;
  maxToolSteps: number;
  maxReplans: number;
  actions: Array<{
    id: string;
    description: string;
    inputSchema: unknown;
  }>;
}

export interface LLMPlannerResponse {
  intent?: Intent;
  actions?: RegisteredActionCall[];
}

export interface LLMPlannerProvider {
  id: string;
  classifyAndPlan(request: LLMPlannerRequest): Promise<LLMPlannerResponse>;
}

const providers = new Map<string, LLMPlannerProvider>();

const KNOWN_INTENTS: IntentKind[] = [
  'status',
  'doctor',
  'create_task',
  'claim_task',
  'checkout_task',
  'sync_task',
  'issue_done',
  'pr_status',
  'pr_doctor',
  'pr_review',
  'pr_watch',
  'pr_merge',
  'governance_audit',
  'workflow_recommended',
  'workflow_not_needed',
  'workflow_draft_required',
  'unknown',
];

function isIntentKind(value: unknown): value is IntentKind {
  return typeof value === 'string' && KNOWN_INTENTS.includes(value as IntentKind);
}

function normalizeIntent(value: unknown): Intent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<Intent>;
  if (!isIntentKind(candidate.kind)) return undefined;
  const slots = candidate.slots && typeof candidate.slots === 'object' ? candidate.slots : {};
  const confidence = typeof candidate.confidence === 'number' ? Math.max(0, Math.min(1, candidate.confidence)) : 0.5;
  return { kind: candidate.kind, slots: slots as Intent['slots'], confidence };
}

function buildLLMRequest(query: string): LLMPlannerRequest {
  return {
    query,
    maxToolSteps: LLM_PLANNER_MAX_TOOL_STEPS,
    maxReplans: LLM_PLANNER_MAX_REPLANS,
    actions: listRegisteredActions().map((action) => ({
      id: action.id,
      description: action.description,
      inputSchema: action.inputSchema,
    })),
  };
}

export function registerLLMPlannerProvider(provider: LLMPlannerProvider): void {
  providers.set(provider.id, provider);
}

export function clearLLMPlannerProviders(): void {
  providers.clear();
}

export function getLLMPlannerProvider(id: string): LLMPlannerProvider | undefined {
  return providers.get(id);
}

export function getConfiguredLLMPlannerProvider(): LLMPlannerProvider | undefined {
  const provider = process.env.OPENSLACK_LLM_PROVIDER;
  if (!provider) return undefined;
  if (provider === 'openai' || provider === 'openai-compatible') {
    return createOpenAICompatiblePlannerProvider({
      id: provider,
      apiKey: process.env.OPENSLACK_LLM_API_KEY,
      model: process.env.OPENSLACK_LLM_MODEL,
      baseUrl: process.env.OPENSLACK_LLM_BASE_URL,
    });
  }
  return getLLMPlannerProvider(provider);
}

export async function resolveIntent(
  text: string,
  options: { provider?: LLMPlannerProvider; confidenceThreshold?: number } = {},
): Promise<Intent> {
  const parsed = parseIntent(text);
  const threshold = options.confidenceThreshold ?? 0.55;
  if (parsed.kind !== 'unknown' && parsed.confidence >= threshold) return parsed;

  const provider = options.provider ?? getConfiguredLLMPlannerProvider();
  if (!provider) return parsed;

  let attempts = 0;
  while (attempts <= LLM_PLANNER_MAX_RETRIES) {
    try {
      const response = await provider.classifyAndPlan(buildLLMRequest(text));
      const intent = normalizeIntent(response.intent);
      return intent ?? parsed;
    } catch {
      attempts++;
      if (attempts > LLM_PLANNER_MAX_RETRIES) return parsed;
    }
  }
  return parsed;
}

export function createOpenAICompatiblePlannerProvider(options: {
  id: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}): LLMPlannerProvider {
  return {
    id: options.id,
    async classifyAndPlan(request) {
      if (!options.apiKey) throw new Error('OPENSLACK_LLM_API_KEY is required');
      if (!options.model) throw new Error('OPENSLACK_LLM_MODEL is required');

      const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Return JSON only. Classify the OpenSlack user request into a known intent and slots. Never return shell commands.',
            },
            {
              role: 'user',
              content: JSON.stringify(request),
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(`LLM provider failed: ${response.status}`);
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error('LLM provider returned no content');
      const parsed = JSON.parse(content) as LLMPlannerResponse;
      return parsed;
    },
  };
}
