import type { AutoClaimFn, NormalizedIssueEvent } from '@openslack/github';

function recordBlockedEvent(
  recEvt: (p: Parameters<typeof import('@openslack/collaboration').recordEvent>[0]) => void,
  event: NormalizedIssueEvent,
  agentId: string,
  reason: string,
): void {
  try {
    recEvt({
      type: 'task.blocked',
      actor: { id: agentId, kind: 'agent', provider: 'github' },
      object: {
        kind: 'issue',
        id: `${event.owner}/${event.repo}#${event.issueNumber}`,
        url: event.url,
      },
      source: { kind: 'github', ref: 'github.watch.auto_claim' },
      summary: `Auto-claim blocked: ${agentId} on ${event.owner}/${event.repo}#${event.issueNumber} — ${reason}`,
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
    });
  } catch {
    // best-effort event recording
  }
}

export function buildAutoClaimFn(root: string): AutoClaimFn {
  return async (event: NormalizedIssueEvent, agentIds: string[]) => {
    const { resolveAgentPrincipal } = await import('@openslack/runtime');
    const { authorizeAgentAction } = await import('@openslack/kernel');
    const { recordEvent: recEvt } = await import('@openslack/collaboration');
    const { claimIssueTask, runAutoClaimGates } = await import('@openslack/github');
    const { parseAgentRegistry } = await import('@openslack/workspace');

    for (const agentId of agentIds) {
      // 1. Resolve agent principal
      const resolved = resolveAgentPrincipal({ root, agentId, provider: 'github' });
      if ('error' in resolved) {
        console.warn(`[Auto-Claim] ${agentId}: ${resolved.error}`);
        recordBlockedEvent(
          recEvt,
          event,
          agentId,
          `principal resolution failed: ${resolved.error}`,
        );
        continue;
      }

      // 2. Parse agent registry for capabilities and max risk
      const registry = parseAgentRegistry(root, agentId);
      const agentCapabilities = registry
        ? { primary: registry.capabilities.primary, secondary: registry.capabilities.secondary }
        : { primary: [] as string[], secondary: [] as string[] };
      const agentMaxRiskLevel = registry?.task_matching?.max_risk_level ?? 'medium';

      // 3. Run manifest gates (extract + validate + filter)
      const gateResult = runAutoClaimGates({
        body: event.body,
        agentCapabilities,
        agentMaxRiskLevel,
      });
      if (!gateResult.allowed) {
        console.warn(`[Auto-Claim] ${agentId}: blocked by gate — ${gateResult.reason}`);
        recordBlockedEvent(recEvt, event, agentId, gateResult.reason);
        continue;
      }

      // 4. Authorize with changedPaths and riskZone
      const auth = authorizeAgentAction({
        snapshot: resolved.snapshot,
        action: 'task.claim',
        changedPaths: gateResult.changedPaths,
        riskZone: gateResult.riskZone,
      });
      if (auth.decision !== 'allow') {
        console.warn(`[Auto-Claim] ${agentId}: denied — ${auth.diagnostics.join('; ')}`);
        recordBlockedEvent(recEvt, event, agentId, auth.evidence.reason);
        continue;
      }

      // 5. Claim with event owner/repo
      try {
        const claimResult = await claimIssueTask({
          issueNumber: event.issueNumber,
          agentId,
          owner: event.owner,
          repo: event.repo,
          ttlMinutes: 60,
          principal: resolved.principal,
        });
        if (claimResult.claimStatus === 'granted') {
          console.log(
            `[Auto-Claim] ${agentId} claimed ${event.owner}/${event.repo}#${event.issueNumber}`,
          );
          try {
            recEvt({
              type: 'task.claimed',
              actor: { id: agentId, kind: 'agent', provider: 'github' },
              object: {
                kind: 'issue',
                id: `${event.owner}/${event.repo}#${event.issueNumber}`,
                url: event.url,
              },
              source: { kind: 'github', ref: 'github.watch.auto_claim' },
              summary: `Auto-claim: ${agentId} claimed ${event.owner}/${event.repo}#${event.issueNumber}`,
              visibility: 'local',
              redacted: false,
              containsSensitiveData: false,
            });
          } catch {
            // best-effort event recording
          }
        } else {
          console.warn(
            `[Auto-Claim] ${agentId}: claim denied — ${claimResult.reason ?? 'unknown'}`,
          );
          recordBlockedEvent(
            recEvt,
            event,
            agentId,
            `claim denied: ${claimResult.reason ?? 'unknown'}`,
          );
        }
      } catch (err) {
        console.warn(`[Auto-Claim] ${agentId}: claim failed — ${(err as Error).message}`);
        recordBlockedEvent(recEvt, event, agentId, `claim error: ${(err as Error).message}`);
      }
    }
  };
}
