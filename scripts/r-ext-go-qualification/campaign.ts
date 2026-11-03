import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { CANDIDATE_SHA, SAFE_ID, SHA256, exactKeys, timestamp } from './evidence.js';
import { parseWorkflowEffectJson } from '../../packages/workflows/src/workflow-effect-json.js';

const LIMITS = Object.freeze({ attempts: 4, tokensPerAttempt: 8192, totalTokens: 32768 });
type Purpose = 'initial' | 'resume' | 'preflight' | 'replacement';
type Outcome = 'reported' | 'failed' | 'not_sent' | 'unknown';
interface Settlement {
  outcome: Outcome;
  totalTokens?: number;
  receiptHash?: string;
}
interface Attempt {
  id: string;
  purpose: Purpose;
  startedAt: string;
  reservedTokens: 8192;
  settlement?: Settlement;
  replacementOf?: string;
}
export interface Campaign {
  schema: 'openslack.r_ext_campaign.v1';
  candidate: string;
  runId: string;
  createdAt: string;
  limits: typeof LIMITS;
  attempts: Attempt[];
}

export function newCampaign(input: {
  candidate: string;
  runId: string;
  createdAt: string;
}): Campaign {
  return validateCampaign({
    schema: 'openslack.r_ext_campaign.v1',
    ...input,
    limits: LIMITS,
    attempts: [],
  });
}

/** Validate persisted bytes on every transition. Never reset an existing campaign. */
export function validateCampaign(value: unknown): Campaign {
  exactKeys(value, ['schema', 'candidate', 'runId', 'createdAt', 'limits', 'attempts']);
  if (
    value.schema !== 'openslack.r_ext_campaign.v1' ||
    typeof value.candidate !== 'string' ||
    !CANDIDATE_SHA.test(value.candidate) ||
    typeof value.runId !== 'string' ||
    !SAFE_ID.test(value.runId)
  ) {
    throw new Error('Invalid campaign identity.');
  }
  timestamp(value.createdAt);
  exactKeys(value.limits, ['attempts', 'tokensPerAttempt', 'totalTokens']);
  if (
    value.limits.attempts !== 4 ||
    value.limits.tokensPerAttempt !== 8192 ||
    value.limits.totalTokens !== 32768 ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > 4
  )
    throw new Error('Campaign limit drift.');
  const ids = new Set<string>();
  const main = new Set<string>();
  let total = 0;
  let unresolved = false;
  let previousTime = Date.parse(String(value.createdAt));
  for (const attempt of value.attempts) {
    exactKeys(
      attempt,
      ['id', 'purpose', 'startedAt', 'reservedTokens'],
      ['settlement', 'replacementOf'],
    );
    if (unresolved)
      throw new Error('An unresolved attempt requires reconciliation before further attempts.');
    if (
      typeof attempt.id !== 'string' ||
      !SAFE_ID.test(attempt.id) ||
      ids.has(attempt.id) ||
      typeof attempt.purpose !== 'string' ||
      !['initial', 'resume', 'preflight', 'replacement'].includes(attempt.purpose) ||
      attempt.reservedTokens !== 8192
    ) {
      throw new Error('Invalid or duplicate attempt.');
    }
    if (attempt.purpose === 'replacement') {
      if (
        typeof attempt.replacementOf !== 'string' ||
        !ids.has(attempt.replacementOf) ||
        value.attempts.find((prior) => prior.id === attempt.replacementOf)?.settlement?.outcome !==
          'not_sent' ||
        value.attempts.some(
          (prior) => ids.has(prior.id) && prior.replacementOf === attempt.replacementOf,
        )
      ) {
        throw new Error('Replacement requires one exact previously confirmed not-sent attempt.');
      }
    } else if (attempt.replacementOf !== undefined)
      throw new Error('Only replacements carry a predecessor.');
    ids.add(attempt.id);
    timestamp(attempt.startedAt);
    const started = Date.parse(String(attempt.startedAt));
    if (started < previousTime) throw new Error('Campaign attempt time moved backwards.');
    previousTime = started;
    if (attempt.purpose === 'initial' || attempt.purpose === 'resume') {
      if (main.has(attempt.purpose))
        throw new Error(
          'Duplicate main-chain attempt; replacement requires an independently confirmed decision.',
        );
      main.add(attempt.purpose);
    }
    if (attempt.settlement === undefined) {
      unresolved = true;
      continue;
    }
    exactKeys(attempt.settlement, ['outcome'], ['totalTokens', 'receiptHash']);
    const settlement = attempt.settlement;
    if (
      typeof settlement.outcome !== 'string' ||
      !['reported', 'failed', 'not_sent', 'unknown'].includes(settlement.outcome)
    )
      throw new Error('Invalid attempt outcome.');
    if (
      settlement.receiptHash !== undefined &&
      (typeof settlement.receiptHash !== 'string' || !SHA256.test(settlement.receiptHash))
    )
      throw new Error('Invalid usage receipt hash.');
    if (settlement.outcome === 'unknown') {
      if (settlement.totalTokens !== undefined)
        throw new Error('Unknown usage cannot be invented.');
      unresolved = true;
    } else {
      if (
        !Number.isSafeInteger(settlement.totalTokens) ||
        Number(settlement.totalTokens) < 0 ||
        (settlement.outcome === 'not_sent' && settlement.totalTokens !== 0) ||
        (settlement.outcome !== 'not_sent' && settlement.receiptHash === undefined)
      )
        throw new Error('Invalid usage evidence; reconciliation required.');
      total += Number(settlement.totalTokens);
      // Preserve measured overage as evidence instead of relabeling it as an
      // in-budget result or discarding it. It freezes every subsequent attempt.
      if (Number(settlement.totalTokens) > 8192 || total > 32768) unresolved = true;
    }
  }
  if (!Number.isSafeInteger(total)) throw new Error('Campaign usage cannot be represented safely.');
  return structuredClone(value) as unknown as Campaign;
}

export function beginAttempt(
  value: Campaign,
  id: string,
  purpose: Purpose,
  startedAt: string,
  replacementOf?: string,
): Campaign {
  const campaign = validateCampaign(value);
  if (
    campaign.attempts.some(
      (attempt) =>
        !attempt.settlement ||
        attempt.settlement.outcome === 'unknown' ||
        Number(attempt.settlement.totalTokens) > 8192,
    )
  ) {
    throw new Error('Unresolved attempt requires reconciliation; no automatic retry.');
  }
  if (purpose === 'preflight' || purpose === 'replacement') {
    const missingMain = ['initial', 'resume'].filter(
      (kind) => !campaign.attempts.some((attempt) => attempt.purpose === kind),
    ).length;
    if (campaign.attempts.length + 1 + missingMain > 4)
      throw new Error('Preserve the main-chain attempt slots.');
  }
  campaign.attempts.push({
    id,
    purpose,
    startedAt,
    reservedTokens: 8192,
    ...(replacementOf === undefined ? {} : { replacementOf }),
  });
  return validateCampaign(campaign);
}

export function settleAttempt(value: Campaign, id: string, settlement: Settlement): Campaign {
  const campaign = validateCampaign(value);
  const attempt = campaign.attempts.find((entry) => entry.id === id);
  if (!attempt || attempt.settlement) throw new Error('No open attempt with that exact identity.');
  attempt.settlement = settlement;
  return validateCampaign(campaign);
}

const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const MAX_BYTES = 16_384;

/** New evidence only: exclusive creation refuses overwrite/reset of old attempts. */
export async function createCampaignFile(path: string, value: Campaign): Promise<void> {
  const encoded = `${JSON.stringify(validateCampaign(value))}\n`;
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  try {
    await file.writeFile(encoded);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Read-only recovery: malformed/unsafe data never becomes a fresh allowance. */
export async function readCampaignFile(path: string): Promise<Campaign> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES)
    throw new Error('Unsafe campaign evidence file.');
  const file = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const bound = await file.stat();
    if (before.dev !== bound.dev || before.ino !== bound.ino || before.size !== bound.size)
      throw new Error('Campaign evidence changed while opening.');
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bound.size !== after.size || bound.mtimeMs !== after.mtimeMs || bytes.length > MAX_BYTES)
      throw new Error('Campaign evidence changed while reading.');
    return validateCampaign(parseWorkflowEffectJson(bytes));
  } finally {
    await file.close();
  }
}

// Deliberately no live send/update entrypoint: #433 blocks this preparation.
// A future live driver must durably persist each reservation before sending;
// these pure transitions and exclusive initial evidence do not implement that gate.
