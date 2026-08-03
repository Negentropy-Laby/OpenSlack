import { TextDecoder } from 'node:util';
import {
  WORKFLOW_RUNNER_CONTRACT_LIMITS,
  parseWorkflowRunnerMessageBytes,
  type WorkflowRunnerMessage,
} from './workflow-runner-contract.js';

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
export class WorkflowRunnerJsonlDecoder {
  #pending = Buffer.alloc(0);

  push(chunkValue: Uint8Array): readonly Buffer[] {
    const chunk = Buffer.from(chunkValue);
    if (chunk.length === 0) return Object.freeze([]);
    if (chunk.includes(0x0d)) {
      throw new WorkflowRunnerFramingError(
        'WORKFLOW_RUNNER_FRAME_INVALID',
        'Carriage returns are forbidden on the canonical JSONL transport.',
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
        throw new WorkflowRunnerFramingError(
          'WORKFLOW_RUNNER_FRAME_INVALID',
          'Blank protocol frames are forbidden.',
        );
      }
      if (frame.length > WORKFLOW_RUNNER_CONTRACT_LIMITS.maxMessageBytes) {
        throw new WorkflowRunnerFramingError(
          'WORKFLOW_RUNNER_FRAME_LIMIT_EXCEEDED',
          'Protocol frame exceeds the message byte limit.',
        );
      }
      frames.push(Buffer.from(frame));
    }
    if (this.#pending.length >= WORKFLOW_RUNNER_CONTRACT_LIMITS.maxMessageBytes) {
      throw new WorkflowRunnerFramingError(
        'WORKFLOW_RUNNER_FRAME_LIMIT_EXCEEDED',
        'Unterminated protocol frame exceeds the message byte limit.',
      );
    }
    return Object.freeze(frames);
  }

  finish(): void {
    if (this.#pending.length !== 0) {
      throw new WorkflowRunnerFramingError(
        'WORKFLOW_RUNNER_FRAME_INCOMPLETE',
        'Protocol input ended with a partial frame.',
      );
    }
  }
}

export function decodeWorkflowRunnerFrame(frame: Uint8Array): WorkflowRunnerMessage {
  const bytes = Buffer.from(frame);
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) {
    throw new WorkflowRunnerFramingError(
      'WORKFLOW_RUNNER_FRAME_INVALID',
      'Protocol frame must end with exactly one LF.',
    );
  }
  if (bytes.length >= 4 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new WorkflowRunnerFramingError(
      'WORKFLOW_RUNNER_FRAME_INVALID',
      'UTF-8 BOM is forbidden on the protocol transport.',
    );
  }
  try {
    // Perform an explicit fatal decode before the stricter contract parser so
    // invalid byte sequences never pass through a replacement character.
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorkflowRunnerFramingError(
      'WORKFLOW_RUNNER_FRAME_INVALID',
      'Protocol frame is not valid UTF-8.',
    );
  }
  return parseWorkflowRunnerMessageBytes(bytes);
}
