import {
  WORKFLOW_CONTROL_AUTHORITY_LIMITS,
  parseWorkflowControlAuthorityMessageBytes,
  prepareWorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityMessage,
} from './workflow-control-authority-contract.js';
import {
  validateWorkflowRunnerJsonlFrameBytes,
  WorkflowRunnerJsonlDecoderCore,
  type WorkflowRunnerJsonlFailure,
  type WorkflowRunnerJsonlPolicy,
} from './workflow-runner-jsonl.js';

export class WorkflowRunnerV2FramingError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_V2_FRAME_INVALID'
      | 'WORKFLOW_RUNNER_V2_FRAME_LIMIT_EXCEEDED'
      | 'WORKFLOW_RUNNER_V2_FRAME_INCOMPLETE',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowRunnerV2FramingError';
  }
}

const POLICY: WorkflowRunnerJsonlPolicy = Object.freeze({
  maxFrameBytes: WORKFLOW_CONTROL_AUTHORITY_LIMITS.maxMessageBytes,
  failure: (kind: WorkflowRunnerJsonlFailure, message: string) =>
    new WorkflowRunnerV2FramingError(
      kind === 'limit'
        ? 'WORKFLOW_RUNNER_V2_FRAME_LIMIT_EXCEEDED'
        : kind === 'incomplete'
          ? 'WORKFLOW_RUNNER_V2_FRAME_INCOMPLETE'
          : 'WORKFLOW_RUNNER_V2_FRAME_INVALID',
      message,
    ),
  messages: Object.freeze({
    carriageReturn: 'Carriage returns are forbidden on the v2 transport.',
    blank: 'Blank v2 protocol frames are forbidden.',
    frameLimit: 'V2 protocol frame exceeds its byte limit.',
    pendingLimit: 'Unterminated v2 protocol frame exceeds its byte limit.',
    incomplete: 'V2 protocol input ended with a partial frame.',
    missingLf: 'V2 protocol frame must end with exactly one LF.',
    bom: 'UTF-8 BOM is forbidden on the v2 transport.',
    utf8: 'V2 protocol frame is not valid UTF-8.',
  }),
});

export class WorkflowRunnerV2JsonlDecoder {
  readonly #core = new WorkflowRunnerJsonlDecoderCore(POLICY);

  push(chunkValue: Uint8Array): readonly Buffer[] {
    return this.#core.push(chunkValue);
  }

  finish(): void {
    this.#core.finish();
  }
}

export function decodeWorkflowRunnerV2Frame(frame: Uint8Array): WorkflowControlAuthorityMessage {
  const bytes = validateWorkflowRunnerJsonlFrameBytes(frame, POLICY);
  const message = parseWorkflowControlAuthorityMessageBytes(bytes);
  const prepared = prepareWorkflowControlAuthorityMessage(message);
  if (!bytes.equals(Buffer.from(prepared.body, 'utf8'))) {
    throw new WorkflowRunnerV2FramingError(
      'WORKFLOW_RUNNER_V2_FRAME_INVALID',
      'V2 protocol frame is not exact canonical JSON followed by one LF.',
    );
  }
  return message;
}
