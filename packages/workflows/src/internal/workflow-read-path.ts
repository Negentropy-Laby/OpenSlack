import { lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BigIntStats } from 'node:fs';
import {
  assertNoWindowsReparseComponents,
  productionJournalSecurity,
} from '../workflow-control-shadow.js';
import {
  WorkflowRunReadError,
  type WorkflowRunReadDiagnostic,
} from '../workflow-run-read-errors.js';

type ReadScope = Omit<WorkflowRunReadDiagnostic, 'code'>;

/** Internal object identity; never serialize this as a public read result. */
export interface WorkflowDirectoryIdentity {
  readonly path: string;
  readonly canonicalPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly revision: string;
}

const validatedDirectory = new AsyncLocalStorage<WorkflowDirectoryIdentity>();
const validationPass = new AsyncLocalStorage<Map<string, Promise<BigIntStats>>>();
/** Reuse component probes only within one validation pass, never across evidence I/O. */
export function withWorkflowReadValidation<T>(read: () => Promise<T>): Promise<T> {
  return validationPass.getStore() ? read() : validationPass.run(new Map(), read);
}
export function workflowReadPathStat(path: string, fresh = false): Promise<BigIntStats> {
  const pass = validationPass.getStore();
  let result = fresh ? undefined : pass?.get(path);
  if (!result) {
    result = lstat(path, { bigint: true });
    pass?.set(path, result);
  }
  return result;
}
export function withValidatedWorkflowDirectory<T>(
  identity: WorkflowDirectoryIdentity,
  read: () => Promise<T>,
): Promise<T> {
  return validatedDirectory.run(identity, read);
}
export function currentWorkflowReadDirectory(): WorkflowDirectoryIdentity | undefined {
  return validatedDirectory.getStore();
}

function fingerprint(stat: BigIntStats, leaf: boolean): string {
  // Unrelated children of /tmp or the drive root are outside this directory's namespace.
  return (
    leaf
      ? [stat.dev, stat.ino, stat.mode, stat.ctimeNs, stat.mtimeNs]
      : [stat.dev, stat.ino, stat.mode]
  ).join(':');
}

/** A query-local proof cache. Every reuse still checks all component identities. */
export class WorkflowReadPathContext {
  readonly #directories = new Map<string, WorkflowDirectoryIdentity>();

  async directory(
    path: string,
    scope: ReadScope,
    validate?: () => Promise<unknown>,
  ): Promise<WorkflowDirectoryIdentity> {
    return withWorkflowReadValidation(() => this.#directory(path, scope, validate));
  }

  async #directory(
    path: string,
    scope: ReadScope,
    validate?: () => Promise<unknown>,
  ): Promise<WorkflowDirectoryIdentity> {
    path = resolve(path);
    try {
      const components: string[] = [];
      for (let current = path; ; current = dirname(current)) {
        components.unshift(current);
        if (dirname(current) === current) break;
      }
      const read = async (fresh = false) => {
        const parts: string[] = [];
        let leaf!: BigIntStats;
        for (const component of components) {
          leaf = await workflowReadPathStat(component, fresh);
          if (!leaf.isDirectory() || leaf.isSymbolicLink())
            throw new WorkflowRunReadError([
              { ...scope, code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID' },
            ]);
          parts.push(fingerprint(leaf, component === path));
        }
        return { leaf, revision: parts.join('/') };
      };
      const before = await read();
      const cached = this.#directories.get(path);
      if (cached?.revision === before.revision) return cached;
      await assertNoWindowsReparseComponents(path, productionJournalSecurity());
      await validate?.();
      const canonicalPath = await realpath(path);
      const canonical = await lstat(canonicalPath, { bigint: true });
      const after = await read(true);
      if (
        canonical.isSymbolicLink() ||
        canonical.dev !== before.leaf.dev ||
        canonical.ino !== before.leaf.ino
      )
        throw new WorkflowRunReadError([{ ...scope, code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID' }]);
      if (before.revision !== after.revision)
        throw new WorkflowRunReadError([{ ...scope, code: 'WORKFLOW_RUN_EVIDENCE_IO_FAILED' }]);
      const identity = Object.freeze({
        path,
        canonicalPath,
        dev: canonical.dev,
        ino: canonical.ino,
        revision: after.revision,
      });
      this.#directories.set(path, identity);
      return identity;
    } catch (error) {
      this.#directories.delete(path);
      if (error instanceof TypeError)
        throw new WorkflowRunReadError([{ ...scope, code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID' }], {
          cause: error,
        });
      throw error;
    }
  }

  async verify(
    identity: WorkflowDirectoryIdentity,
    scope: ReadScope,
  ): Promise<WorkflowDirectoryIdentity> {
    const current = await this.directory(identity.path, scope);
    if (current.dev !== identity.dev || current.ino !== identity.ino)
      throw new WorkflowRunReadError([{ ...scope, code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID' }]);
    return current;
  }
}
