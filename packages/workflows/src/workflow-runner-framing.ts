import {
  WORKFLOW_RUNNER_CONTRACT_LIMITS,
  parseWorkflowRunnerMessageBytes,
  type WorkflowRunnerMessage,
} from './workflow-runner-contract.js';
import {
  validateWorkflowRunnerJsonlFrameBytes,
  WorkflowRunnerJsonlDecoderCore,
  type WorkflowRunnerJsonlFailure,
  type WorkflowRunnerJsonlPolicy,
} from './workflow-runner-jsonl.js';

export class WorkflowRunnerFramingError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_FRAME_INVALID'
      | 'WORKFLOW_RUNNER_FRAME_LIMIT_EXCEEDED'
      | 'WORKFLOW_RUNNER_FRAME_INCOMPLETE',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowRunnerFramingError';
  }
}

/**
 * Bounded exact-byte JSONL decoder. It deliberately does not use readline:
 * readline discards the delimiter and would make canonical framing impossible
 * to prove. Every returned frame includes its one required LF byte.
 */
const POLICY: WorkflowRunnerJsonlPolicy = Object.freeze({
  maxFrameBytes: WORKFLOW_RUNNER_CONTRACT_LIMITS.maxMessageBytes,
  failure: (kind: WorkflowRunnerJsonlFailure, message: string) =>
    new WorkflowRunnerFramingError(
      kind === 'limit'
        ? 'WORKFLOW_RUNNER_FRAME_LIMIT_EXCEEDED'
        : kind === 'incomplete'
          ? 'WORKFLOW_RUNNER_FRAME_INCOMPLETE'
          : 'WORKFLOW_RUNNER_FRAME_INVALID',
      message,
    ),
  messages: Object.freeze({
    carriageReturn: 'Carriage returns are forbidden on the canonical JSONL transport.',
    blank: 'Blank protocol frames are forbidden.',
    frameLimit: 'Protocol frame exceeds the message byte limit.',
    pendingLimit: 'Unterminated protocol frame exceeds the message byte limit.',
    incomplete: 'Protocol input ended with a partial frame.',
    missingLf: 'Protocol frame must end with exactly one LF.',
    bom: 'UTF-8 BOM is forbidden on the protocol transport.',
    utf8: 'Protocol frame is not valid UTF-8.',
  }),
});

export class WorkflowRunnerJsonlDecoder {
  readonly #core = new WorkflowRunnerJsonlDecoderCore(POLICY);

  push(chunkValue: Uint8Array): readonly Buffer[] {
    return this.#core.push(chunkValue);
  }

  finish(): void {
    this.#core.finish();
  }
}

export function decodeWorkflowRunnerFrame(frame: Uint8Array): WorkflowRunnerMessage {
  const bytes = validateWorkflowRunnerJsonlFrameBytes(frame, POLICY);
  return parseWorkflowRunnerMessageBytes(bytes);
}
