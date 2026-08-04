import { describe, expect, it } from 'vitest';
import {
  encodeWorkflowRunnerMessage,
  type WorkflowRunnerMessage,
} from '../workflow-runner-contract.js';
import {
  decodeWorkflowRunnerFrame,
  WorkflowRunnerFramingError,
  WorkflowRunnerJsonlDecoder,
} from '../workflow-runner-framing.js';

const hello: WorkflowRunnerMessage = {
  protocolVersion: 'openslack.workflow_runner.v1',
  kind: 'hello',
  workspaceId: 'workspace.test',
  jobId: null,
  workflowRunId: null,
  attemptId: null,
  leaseId: null,
  fencingToken: null,
  sequence: null,
  eventId: 'hello.test',
  correlationId: 'session.test',
  sentAt: '2026-08-04T01:00:00.000Z',
  payload: {
    runtimeName: 'node',
    runtimeVersion: '22.0.0',
    runnerBuildHash: 'a'.repeat(64),
    supportedProtocolVersions: ['openslack.workflow_runner.v1'],
    capabilities: ['cancel_ack', 'effect_receipts', 'lease_heartbeat'],
    maxConcurrentJobs: 1,
  },
};

describe('GS8-B canonical JSONL framing', () => {
  it('reassembles fragmented frames and preserves their exact LF', () => {
    const body = Buffer.from(encodeWorkflowRunnerMessage(hello), 'utf8');
    const decoder = new WorkflowRunnerJsonlDecoder();
    expect(decoder.push(body.subarray(0, 7))).toEqual([]);
    const frames = decoder.push(body.subarray(7));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(body);
    expect(decodeWorkflowRunnerFrame(frames[0]!)).toEqual(hello);
    decoder.finish();
  });

  it('extracts multiple frames without rebuilding their bytes', () => {
    const body = Buffer.from(encodeWorkflowRunnerMessage(hello), 'utf8');
    const decoder = new WorkflowRunnerJsonlDecoder();
    expect(decoder.push(Buffer.concat([body, body]))).toEqual([body, body]);
    decoder.finish();
  });

  it('rejects CRLF, blank, partial, BOM, invalid UTF-8, and oversized frames', () => {
    expect(() => new WorkflowRunnerJsonlDecoder().push(Buffer.from('{}\r\n'))).toThrow(
      WorkflowRunnerFramingError,
    );
    expect(() => new WorkflowRunnerJsonlDecoder().push(Buffer.from('\n'))).toThrow(
      WorkflowRunnerFramingError,
    );
    const partial = new WorkflowRunnerJsonlDecoder();
    partial.push(Buffer.from('{}'));
    expect(() => partial.finish()).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_RUNNER_FRAME_INCOMPLETE' }),
    );
    expect(() =>
      decodeWorkflowRunnerFrame(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a])),
    ).toThrow(WorkflowRunnerFramingError);
    expect(() => decodeWorkflowRunnerFrame(Buffer.from([0xc3, 0x28, 0x0a]))).toThrow(
      WorkflowRunnerFramingError,
    );
    expect(() =>
      new WorkflowRunnerJsonlDecoder().push(Buffer.alloc(256 * 1024, 0x61)),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_RUNNER_FRAME_LIMIT_EXCEEDED' }));
  });
});
