import { types as nodeTypes } from 'node:util';

export interface WorkflowEffectShadowObservationPort {
  /** Fire-and-forget: transport failure never changes TypeScript authority. */
  observeAuthority(runId: string, approvalId: string): void;
  /** Rebuilds journal entries for every durable authority record. */
  synchronize(): Promise<void>;
  /** Revalidates and drains every complete durable journal prefix. */
  replay(): Promise<void>;
  /** Qualification seam for currently scheduled observer work. */
  flush(): Promise<void>;
}

const PORTS = new WeakSet<object>();

export function registerWorkflowEffectShadowObservationPort(
  value: WorkflowEffectShadowObservationPort,
): WorkflowEffectShadowObservationPort {
  if (
    !value ||
    typeof value !== 'object' ||
    nodeTypes.isProxy(value) ||
    typeof value.observeAuthority !== 'function' ||
    typeof value.synchronize !== 'function' ||
    typeof value.replay !== 'function' ||
    typeof value.flush !== 'function'
  ) {
    throw new TypeError('Workflow effect shadow observation port is invalid.');
  }
  const port = Object.freeze(value);
  PORTS.add(port);
  return port;
}

export function isWorkflowEffectShadowObservationPort(
  value: unknown,
): value is WorkflowEffectShadowObservationPort {
  return Boolean(
    value && typeof value === 'object' && !nodeTypes.isProxy(value) && PORTS.has(value),
  );
}
