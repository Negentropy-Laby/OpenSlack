import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  linkSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { join } from 'node:path';

export class OnboardingError extends Error {
  constructor(
    public readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'OnboardingError';
  }
}
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const recoveryHelp =
  'Administrator: inspect .openslack/agents/onboarding/.hire-<agent-id>; preserve evidence and remove only verified incomplete generation artifacts before retrying. Never remove a deployed registry.';
const blocked = () => new OnboardingError('AGENT_HIRE_RECOVERY_REQUIRED', recoveryHelp);

function regularFile(path: string): boolean {
  return existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink();
}
function ownerIsDead(owner: { pid: number; host: string }): boolean {
  if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Registry is the commit marker. This is recoverable publication, not a multi-file atomic write. */
export function publishOnboarding(
  root: string,
  agentId: string,
  inputHash: string,
  documents: { name: string; content: string }[],
  registryText: string,
): void {
  const agents = join(root, '.openslack', 'agents');
  const parent = join(agents, 'onboarding');
  const target = join(parent, agentId);
  const registry = join(agents, 'registry', `${agentId}.yaml`);
  const transaction = join(parent, `.hire-${agentId}`);
  const journalPath = join(transaction, 'journal.json');
  const recoveryLock = join(transaction, 'recovery.lock');
  const names = [...documents.map((d) => d.name), 'registry.yaml'];
  let recovering = false;
  let owned = false;
  let committed = false;
  let madeTarget = false;
  const created: { path: string; ino: number; dev: number }[] = [];
  let expectedHashes: Record<string, string> = Object.fromEntries(
    [...documents, { name: 'registry.yaml', content: registryText }].map((d) => [
      d.name,
      digest(d.content),
    ]),
  );
  let journalHash: string | undefined;
  let recoveryHash: string | undefined;
  function cleanup() {
    const hashes: Record<string, string> = {
      ...expectedHashes,
      ...(journalHash ? { 'journal.json': journalHash } : {}),
      ...(recoveryHash ? { 'recovery.lock': recoveryHash } : {}),
    };
    const files = readdirSync(transaction);
    for (const name of files) {
      const path = join(transaction, name);
      if (
        !Object.hasOwn(hashes, name) ||
        !regularFile(path) ||
        digest(readFileSync(path, 'utf8')) !== hashes[name]
      )
        throw blocked();
    }
    for (const name of files) {
      const path = join(transaction, name);
      if (!regularFile(path) || digest(readFileSync(path, 'utf8')) !== hashes[name])
        throw blocked();
      unlinkSync(path);
    }
    // Never recursively erase unknown files added during cleanup.
    rmdirSync(transaction);
  }
  try {
    mkdirSync(parent, { recursive: true });
    try {
      mkdirSync(transaction);
      owned = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (
        !lstatSync(transaction).isDirectory() ||
        lstatSync(transaction).isSymbolicLink() ||
        !regularFile(journalPath)
      )
        throw blocked();
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      if (
        !journal ||
        journal.schema !== 1 ||
        journal.agentId !== agentId ||
        journal.inputHash !== inputHash
      )
        throw blocked();
      if (!ownerIsDead(journal.owner ?? {}))
        throw new OnboardingError(
          'AGENT_HIRE_BUSY',
          'A generation owner may still be active; retry after it exits. ' + recoveryHelp,
        );
      // One recovery contender wins. An interrupted recovery requires administrator inspection.
      try {
        writeFileSync(recoveryLock, JSON.stringify({ pid: process.pid, host: hostname() }), {
          flag: 'wx',
        });
      } catch {
        throw blocked();
      }
      recoveryHash = digest(readFileSync(recoveryLock, 'utf8'));
      owned = true;
      recovering = true;
    }
    if (!recovering) {
      if (existsSync(registry) || existsSync(target))
        throw new OnboardingError(
          'AGENT_HIRE_EXISTS',
          'Agent registry or onboarding already exists; use a governed maintenance change.',
        );
      for (const document of documents)
        writeFileSync(join(transaction, document.name), document.content, { flag: 'wx' });
      writeFileSync(join(transaction, 'registry.yaml'), registryText, { flag: 'wx' });
      const hashes = Object.fromEntries(
        names.map((name) => [name, digest(readFileSync(join(transaction, name), 'utf8'))]),
      );
      writeFileSync(
        journalPath,
        JSON.stringify({
          schema: 1,
          agentId,
          inputHash,
          owner: { pid: process.pid, host: hostname() },
          hashes,
        }),
        { flag: 'wx' },
      );
    }
    journalHash = digest(readFileSync(journalPath, 'utf8'));
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const allowedTransactionFiles = [
      ...names,
      'journal.json',
      ...(recovering ? ['recovery.lock'] : []),
    ];
    if (readdirSync(transaction).some((name) => !allowedTransactionFiles.includes(name)))
      throw blocked();
    if (
      JSON.stringify(Object.keys(journal.hashes ?? {}).sort()) !== JSON.stringify([...names].sort())
    )
      throw blocked();
    for (const name of names) {
      const staged = join(transaction, name);
      if (!regularFile(staged) || digest(readFileSync(staged, 'utf8')) !== journal.hashes[name])
        throw blocked();
    }
    expectedHashes = journal.hashes;
    // Inspect every destination before creating anything. Never adopt unknown/manual content.
    if (existsSync(target)) {
      if (!recovering || !lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink())
        throw blocked();
      for (const name of readdirSync(target)) {
        if (
          !documents.some((d) => d.name === name) ||
          !regularFile(join(target, name)) ||
          digest(readFileSync(join(target, name), 'utf8')) !== journal.hashes[name]
        )
          throw blocked();
      }
    }
    if (existsSync(registry)) {
      if (
        !recovering ||
        !regularFile(registry) ||
        digest(readFileSync(registry, 'utf8')) !== journal.hashes['registry.yaml'] ||
        !documents.every(
          (d) =>
            regularFile(join(target, d.name)) &&
            digest(readFileSync(join(target, d.name), 'utf8')) === journal.hashes[d.name],
        )
      )
        throw blocked();
      committed = true;
      return;
    }
    mkdirSync(join(agents, 'registry'), { recursive: true });
    mkdirSync(join(agents, 'prompts'), { recursive: true });
    if (!existsSync(target)) {
      mkdirSync(target);
      madeTarget = true;
    }
    for (const document of documents) {
      const destination = join(target, document.name);
      if (recovering && existsSync(destination)) continue;
      // Hard-link publication is exclusive and exposes only a fully written same-volume file.
      linkSync(join(transaction, document.name), destination);
      const stat = lstatSync(destination);
      created.push({ path: destination, ino: stat.ino, dev: stat.dev });
    }
    linkSync(join(transaction, 'registry.yaml'), registry);
    committed = true;
  } catch (error) {
    if (!committed) {
      for (const { path, ino, dev } of created.reverse()) {
        const name = path
          .slice(path.lastIndexOf('/') + 1)
          .split('\\')
          .pop()!;
        const staged = join(transaction, name);
        // Do not erase a file an administrator changed after publication.
        try {
          if (
            regularFile(path) &&
            lstatSync(path).ino === ino &&
            lstatSync(path).dev === dev &&
            regularFile(staged) &&
            digest(readFileSync(path, 'utf8')) === expectedHashes[name]
          )
            unlinkSync(path);
        } catch {
          /* retain evidence */
        }
      }
      if (madeTarget) {
        try {
          rmdirSync(target);
        } catch {
          /* retain nonempty evidence */
        }
      }
    }
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError(
      'AGENT_HIRE_IO_FAILED',
      'Generation could not be completed. ' + recoveryHelp,
    );
  } finally {
    if (owned) {
      try {
        if (committed || (!recovering && !existsSync(target) && !existsSync(registry))) cleanup();
        else if (recovering) {
          try {
            unlinkSync(recoveryLock);
          } catch {
            /* retain evidence */
          }
        } else if (!regularFile(journalPath)) cleanup();
      } catch {
        throw new OnboardingError(
          'AGENT_HIRE_CLEANUP_REQUIRED',
          (committed
            ? 'Registry publication completed; do not recreate this identity. '
            : 'Publication failed; ') + recoveryHelp,
        );
      }
    }
  }
}
