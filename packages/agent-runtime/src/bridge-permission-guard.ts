/**
 * Bridge Permission Guard — enforces OpenSlack permission boundaries at the
 * bridge interface. Wraps every outbound request and inbound response,
 * stripping denied tools, rejecting forbidden action results.
 *
 * Double enforcement: ToolGuard (per-call) + BridgePermissionGuard (envelope boundary).
 *
 * AR-2.5D: Permission Boundary
 */

import type { AgentPermissionProfile } from './types.js';
import { SUBAGENT_ALWAYS_FORBIDDEN } from './permissions.js';
import type { RunRecorder } from './recorder.js';
import type { BridgeEnvelope } from './bridge-contract.js';
import { normalizeToolName } from './tool-name.js';

/**
 * Guards bridge envelopes against permission violations.
 *
 * Operates independently of external runtime cooperation.
 * Denied inbound tool events are recorded as denial evidence,
 * but their payloads are not persisted until redaction/secret
 * scanning succeeds.
 */
export class BridgePermissionGuard {
  private readonly profile: AgentPermissionProfile;
  private readonly recorder: RunRecorder;
  private readonly runId: string;

  constructor(profile: AgentPermissionProfile, recorder: RunRecorder, runId: string) {
    this.profile = profile;
    this.recorder = recorder;
    this.runId = runId;
  }

  /**
   * Filter outbound tool list for capability negotiation.
   * Removes SUBAGENT_ALWAYS_FORBIDDEN actions even if they
   * appear in the profile's allowedTools.
   */
  filterOutboundTools(requestedTools: string[]): {
    allowed: string[];
    denied: string[];
  } {
    const allowed: string[] = [];
    const denied: string[] = [];

    for (const tool of requestedTools) {
      if (this.isToolAllowed(tool)) {
        allowed.push(tool);
      } else {
        denied.push(tool);
      }
    }

    if (denied.length > 0) {
      this.recorder.progress(this.runId, {
        step: 'bridge_permission_filter',
        deniedTools: denied,
        allowedTools: allowed,
        reason: 'Outbound tool denied by BridgePermissionGuard',
      });
    }

    return { allowed, denied };
  }

  /**
   * Validate an inbound bridge response envelope.
   * Rejects responses that contain tool results from denied tools
   * or forbidden actions.
   */
  validateInboundResponse(envelope: BridgeEnvelope): {
    valid: boolean;
    violation?: string;
  } {
    const payload = envelope.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return { valid: false, violation: 'Missing payload in bridge response' };
    }

    // Check for tool name in tool_response and tool_request envelopes.
    // Also check any envelope kind that carries a toolName field for defense-in-depth.
    // Currently only tool_response and tool_request are expected to carry tool identifiers;
    // if a future envelope kind adds a toolName field, it will be caught here.
    if (envelope.kind === 'tool_response' || envelope.kind === 'tool_request' || payload.toolName) {
      const toolName = payload.toolName as string | undefined;
      if (toolName && typeof toolName === 'string' && !this.isToolAllowed(toolName)) {
        this.recordDenialEvidence(toolName, envelope.kind);
        return {
          valid: false,
          violation: `Inbound ${envelope.kind} for denied tool: ${toolName}`,
        };
      }
    }

    // Check for forbidden actions in any payload
    const forbiddenAction = this.findForbiddenAction(payload);
    if (forbiddenAction) {
      this.recordDenialEvidence(forbiddenAction, 'forbidden_action_detected');
      return {
        valid: false,
        violation: `Inbound response contains forbidden action: ${forbiddenAction}`,
      };
    }

    return { valid: true };
  }

  /**
   * Validate a list of inbound tool events (from bridge-reported events).
   * Returns valid events and records violations for denied ones.
   */
  filterInboundToolEvents(events: Array<{ toolName: string; payload?: unknown }>): {
    valid: Array<{ toolName: string; payload?: unknown }>;
    violations: Array<{ toolName: string; reason: string }>;
  } {
    const valid: Array<{ toolName: string; payload?: unknown }> = [];
    const violations: Array<{ toolName: string; reason: string }> = [];

    for (const event of events) {
      if (this.isToolAllowed(event.toolName)) {
        valid.push(event);
      } else {
        violations.push({
          toolName: event.toolName,
          reason: `Tool "${event.toolName}" is not allowed by the permission profile`,
        });
        this.recordDenialEvidence(event.toolName, 'inbound_tool_denied');
      }
    }

    return { valid, violations };
  }

  /**
   * Hardcoded always-false for sensitive permissions.
   * These must never be true regardless of external runtime claims.
   */
  get canApprovePR(): false {
    return false;
  }

  get canMerge(): false {
    return false;
  }

  get canReadSecrets(): false {
    return false;
  }

  get canBypassRulesets(): false {
    return false;
  }

  /**
   * Check if a tool is allowed by the permission profile,
   * including SUBAGENT_ALWAYS_FORBIDDEN enforcement.
   */
  private isToolAllowed(toolName: string): boolean {
    const normalized = normalizeToolName(toolName);
    if (SUBAGENT_ALWAYS_FORBIDDEN.has(normalized)) return false;
    if (this.profile.deniedTools.map(normalizeToolName).includes(normalized)) return false;
    return this.profile.allowedTools.map(normalizeToolName).includes(normalized);
  }

  /**
   * Scan payload for forbidden actions by checking specific known field names
   * for exact matches. Avoids false positives from substring scanning arbitrary
   * string content in unrelated payload fields (e.g., documentation or error
   * messages that mention forbidden action names).
   */
  private findForbiddenAction(payload: Record<string, unknown>): string | null {
    // Fields that are known to carry action/tool identifiers
    const actionFields = ['action', 'toolName', 'tool', 'command', 'type', 'method'];

    for (const field of actionFields) {
      const value = payload[field];
      if (typeof value === 'string' && SUBAGENT_ALWAYS_FORBIDDEN.has(normalizeToolName(value))) {
        return value;
      }
    }

    // Recursively check nested objects (limited depth to prevent unbounded traversal)
    return this.findForbiddenInNested(payload, 3);
  }

  /**
   * Recursively search nested payload objects for forbidden actions in known fields.
   */
  private findForbiddenInNested(obj: unknown, depth: number): string | null {
    if (depth <= 0 || typeof obj !== 'object' || obj === null) return null;

    const record = obj as Record<string, unknown>;
    const actionFields = ['action', 'toolName', 'tool', 'command', 'type', 'method'];

    for (const field of actionFields) {
      const value = record[field];
      if (typeof value === 'string' && SUBAGENT_ALWAYS_FORBIDDEN.has(normalizeToolName(value))) {
        return value;
      }
    }

    for (const value of Object.values(record)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const found = this.findForbiddenInNested(value, depth - 1);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * Record denial evidence in the transcript.
   * The evidence is recorded but the payload is NOT persisted.
   */
  private recordDenialEvidence(toolName: string, context: string): void {
    this.recorder.progress(this.runId, {
      step: 'bridge_permission_denied',
      toolName,
      normalizedToolName: normalizeToolName(toolName),
      context,
      reason: `Tool "${toolName}" is denied by BridgePermissionGuard`,
    });
  }
}
