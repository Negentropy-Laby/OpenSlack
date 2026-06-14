import { parseIntent } from './intent.js';
import type { Intent, IntentKind } from './types.js';
import { KNOWN_INTENTS } from './intent-kinds.js';
import { listRegisteredActions, type RegisteredActionCall } from './tool-registry.js';

export const LLM_PLANNER_MAX_TOOL_STEPS = 6;
export const LLM_PLANNER_MAX_REPLANS = 2;
export const LLM_PLANNER_MAX_RETRIES = 1;

const DEFAULT_LLM_TIMEOUT_MS = 8000;

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
  classifyAndPlan(request: LLMPlannerRequest, signal?: AbortSignal): Promise<LLMPlannerResponse>;
}

export interface ResolvedIntent {
  intent: Intent;
  source: 'keyword' | 'llm' | 'keyword-fallback';
  fallbackReason?: string;
}

const providers = new Map<string, LLMPlannerProvider>();

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

function buildSystemPrompt(): string {
  const intentList = KNOWN_INTENTS.filter(k => k !== 'unknown').join(', ');
  const actions = listRegisteredActions().map(a => `  - ${a.id}: ${a.description}`).join('\n');
  return [
    'You are the OpenSlack intent classifier. Classify the user request into exactly one intent kind.',
    '',
    `Available intents: ${intentList}`,
    '',
    'Registered actions:',
    actions,
    '',
    'Extract these slots when present:',
    '  - prNumber: number from "PR #N" or "pull request #N"',
    '  - issueNumber: number from "issue #N"',
    '  - agentId: string from "--agent-id X" or "agent: X"',
    '  - paths: string from "--paths ..." (glob pattern)',
    '  - title: string from quoted text or --title flag',
    '  - query: the original text for workflow/profile-sync intents',
    '  - scope: string context like "workspace", "metrics", "eval", "scorecard"',
    '  - action: "check" | "preview" | "create-pr" for profile_sync',
    '',
    'Return JSON matching this structure:',
    '{',
    '  "intent": {',
    '    "kind": "status",',
    '    "slots": {},',
    '    "confidence": 0.9',
    '  }',
    '}',
    '',
    'Support both English and Chinese input.',
    'NEVER return shell commands or actions not in the registered actions list.',
    'If the request is ambiguous, pick the most specific matching intent and set a lower confidence.',
  ].join('\n');
}

function mergeSlots(llmSlots: Intent['slots'], parsedSlots: Intent['slots']): Intent['slots'] {
  const merged = { ...llmSlots };
  for (const [key, value] of Object.entries(parsedSlots)) {
    if (value !== null && value !== undefined && merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function getTimeoutMs(): number {
  const env = process.env.OPENSLACK_LLM_TIMEOUT_MS;
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_LLM_TIMEOUT_MS;
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
): Promise<ResolvedIntent> {
  // 1. ALWAYS run keyword parser first — serves as fallback and slot source
  const parsed = parseIntent(text);

  // 2. Try to get provider
  const provider = options.provider ?? getConfiguredLLMPlannerProvider();
  if (!provider) {
    return { intent: parsed, source: 'keyword' };
  }

  const timeoutMs = getTimeoutMs();

  // 3. Retry loop with AbortController timeout per attempt
  let attempts = 0;
  while (attempts <= LLM_PLANNER_MAX_RETRIES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await provider.classifyAndPlan(buildLLMRequest(text), controller.signal);
      clearTimeout(timer);

      const intent = normalizeIntent(response.intent);

      if (!intent) {
        return {
          intent: parsed,
          source: 'keyword-fallback',
          fallbackReason: 'LLM returned invalid intent, using keyword fallback',
        };
      }

      if (intent.kind === 'unknown' && parsed.kind !== 'unknown') {
        return {
          intent: parsed,
          source: 'keyword-fallback',
          fallbackReason: 'LLM returned unknown for a keyword-recognized request, using keyword fallback',
        };
      }

      // Merge slots: LLM slots as base, fill from parsed where LLM didn't provide
      const mergedSlots = mergeSlots(intent.slots, parsed.slots);
      const merged: Intent = { kind: intent.kind, slots: mergedSlots, confidence: intent.confidence };

      return { intent: merged, source: 'llm' };
    } catch (err) {
      clearTimeout(timer);
      attempts++;
      if (attempts > LLM_PLANNER_MAX_RETRIES) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          intent: parsed,
          source: 'keyword-fallback',
          fallbackReason: `LLM unavailable: ${message}, using keyword fallback`,
        };
      }
    }
  }

  return { intent: parsed, source: 'keyword-fallback', fallbackReason: 'LLM retries exhausted, using keyword fallback' };
}

export function createOpenAICompatiblePlannerProvider(options: {
  id: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}): LLMPlannerProvider {
  return {
    id: options.id,
    async classifyAndPlan(request, signal) {
      if (!options.apiKey) throw new Error('OPENSLACK_LLM_API_KEY is required');
      if (!options.model) throw new Error('OPENSLACK_LLM_MODEL is required');

      const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      const endpoint = baseUrl.endsWith('/chat/completions')
        ? baseUrl
        : `${baseUrl}/chat/completions`;

      const response = await fetch(endpoint, {
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
              content: buildSystemPrompt(),
            },
            {
              role: 'user',
              content: JSON.stringify(request),
            },
          ],
        }),
        signal,
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
