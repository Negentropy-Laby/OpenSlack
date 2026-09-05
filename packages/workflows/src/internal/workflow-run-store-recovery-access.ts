const RECOVERY_ACCESS = new WeakSet<object>();

/** @internal Opaque access minted only for the sealed Go-authority recovery projection. */
export interface WorkflowRunStoreRecoveryAccess {
  readonly kind: 'go-authority-recovery-projection';
}

/** @internal Not exported from the package root or worker public subpath. */
export function createWorkflowRunStoreRecoveryAccess(): WorkflowRunStoreRecoveryAccess {
  const access = Object.freeze({
    kind: 'go-authority-recovery-projection' as const,
  });
  RECOVERY_ACCESS.add(access);
  return access;
}

export function isWorkflowRunStoreRecoveryAccess(
  value: unknown,
): value is WorkflowRunStoreRecoveryAccess {
  return typeof value === 'object' && value !== null && RECOVERY_ACCESS.has(value);
}
