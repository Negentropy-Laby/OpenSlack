import { TextDecoder } from 'node:util';

export type WorkflowRunnerJsonlFailure = 'invalid' | 'limit' | 'incomplete';

export interface WorkflowRunnerJsonlPolicy {
  readonly maxFrameBytes: number;
  readonly failure: (kind: WorkflowRunnerJsonlFailure, message: string) => Error;
  readonly messages: {
    readonly carriageReturn: string;
    readonly blank: string;
    readonly frameLimit: string;
    readonly pendingLimit: string;
    readonly incomplete: string;
    readonly missingLf: string;
    readonly bom: string;
    readonly utf8: string;
  };
}

/** Shared bounded JSONL scanner used by both frozen runner transports. */
export class WorkflowRunnerJsonlDecoderCore {
  readonly #policy: WorkflowRunnerJsonlPolicy;
  #pending = Buffer.alloc(0);

  constructor(policy: WorkflowRunnerJsonlPolicy) {
    this.#policy = policy;
  }

  push(chunkValue: Uint8Array): readonly Buffer[] {
    const chunk = Buffer.from(chunkValue);
    if (chunk.length === 0) return Object.freeze([]);
    if (chunk.includes(0x0d)) {
      throw this.#policy.failure('invalid', this.#policy.messages.carriageReturn);
    }
    this.#pending = Buffer.concat([this.#pending, chunk]);
    const frames: Buffer[] = [];
    while (true) {
      const lf = this.#pending.indexOf(0x0a);
      if (lf < 0) break;
      const frame = this.#pending.subarray(0, lf + 1);
      this.#pending = this.#pending.subarray(lf + 1);
      if (frame.length === 1) {
        throw this.#policy.failure('invalid', this.#policy.messages.blank);
      }
      if (frame.length > this.#policy.maxFrameBytes) {
        throw this.#policy.failure('limit', this.#policy.messages.frameLimit);
      }
      frames.push(Buffer.from(frame));
    }
    if (this.#pending.length >= this.#policy.maxFrameBytes) {
      throw this.#policy.failure('limit', this.#policy.messages.pendingLimit);
    }
    return Object.freeze(frames);
  }

  finish(): void {
    if (this.#pending.length !== 0) {
      throw this.#policy.failure('incomplete', this.#policy.messages.incomplete);
    }
  }
}

export function validateWorkflowRunnerJsonlFrameBytes(
  frame: Uint8Array,
  policy: WorkflowRunnerJsonlPolicy,
): Buffer {
  const bytes = Buffer.from(frame);
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) {
    throw policy.failure('invalid', policy.messages.missingLf);
  }
  if (bytes.includes(0x0d)) {
    throw policy.failure('invalid', policy.messages.carriageReturn);
  }
  if (bytes.length >= 4 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw policy.failure('invalid', policy.messages.bom);
  }
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw policy.failure('invalid', policy.messages.utf8);
  }
  return bytes;
}
