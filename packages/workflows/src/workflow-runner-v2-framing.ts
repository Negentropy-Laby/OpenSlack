import { TextDecoder } from 'node:util';
import {
  WORKFLOW_CONTROL_AUTHORITY_LIMITS,
  parseWorkflowControlAuthorityMessageBytes,
  prepareWorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityMessage,
} from './workflow-control-authority-contract.js';

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

export class WorkflowRunnerV2JsonlDecoder {
  #pending = Buffer.alloc(0);

  push(chunkValue: Uint8Array): readonly Buffer[] {
    const chunk = Buffer.from(chunkValue);
    if (chunk.length === 0) return Object.freeze([]);
    if (chunk.includes(0x0d)) {
      throw new WorkflowRunnerV2FramingError(
        'WORKFLOW_RUNNER_V2_FRAME_INVALID',
        'Carriage returns are forbidden on the v2 transport.',
      );
    }
    this.#pending = Buffer.concat([this.#pending, chunk]);
    const frames: Buffer[] = [];
    while (true) {
      const lf = this.#pending.indexOf(0x0a);
      if (lf < 0) break;
      const frame = this.#pending.subarray(0, lf + 1);
      this.#pending = this.#pending.subarray(lf + 1);
      if (frame.length === 1) {
        throw new WorkflowRunnerV2FramingError(
          'WORKFLOW_RUNNER_V2_FRAME_INVALID',
          'Blank v2 protocol frames are forbidden.',
        );
      }
      if (frame.length > WORKFLOW_CONTROL_AUTHORITY_LIMITS.maxMessageBytes) {
        throw new WorkflowRunnerV2FramingError(
          'WORKFLOW_RUNNER_V2_FRAME_LIMIT_EXCEEDED',
          'V2 protocol frame exceeds its byte limit.',
        );
      }
      frames.push(Buffer.from(frame));
    }
    if (this.#pending.length >= WORKFLOW_CONTROL_AUTHORITY_LIMITS.maxMessageBytes) {
      throw new WorkflowRunnerV2FramingError(
        'WORKFLOW_RUNNER_V2_FRAME_LIMIT_EXCEEDED',
        'Unterminated v2 protocol frame exceeds its byte limit.',
      );
    }
    return Object.freeze(frames);
  }

  finish(): void {
    if (this.#pending.length !== 0) {
      throw new WorkflowRunnerV2FramingError(
        'WORKFLOW_RUNNER_V2_FRAME_INCOMPLETE',
        'V2 protocol input ended with a partial frame.',
      );
    }
  }
}

export function decodeWorkflowRunnerV2Frame(frame: Uint8Array): WorkflowControlAuthorityMessage {
  const bytes = Buffer.from(frame);
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) {
    throw new WorkflowRunnerV2FramingError(
      'WORKFLOW_RUNNER_V2_FRAME_INVALID',
      'V2 protocol frame must end with exactly one LF.',
    );
  }
  if (bytes.includes(0x0d)) {
    throw new WorkflowRunnerV2FramingError(
      'WORKFLOW_RUNNER_V2_FRAME_INVALID',
      'Carriage returns are forbidden on the v2 transport.',
    );
  }
  if (bytes.length >= 4 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new WorkflowRunnerV2FramingError(
      'WORKFLOW_RUNNER_V2_FRAME_INVALID',
      'UTF-8 BOM is forbidden on the v2 transport.',
    );
  }
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorkflowRunnerV2FramingError(
      'WORKFLOW_RUNNER_V2_FRAME_INVALID',
      'V2 protocol frame is not valid UTF-8.',
    );
  }
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
