import { isAbsolute, join, relative, resolve } from 'node:path';

export interface WorkflowLocalShadowConfig {
  readonly endpoint: URL;
  readonly journalRoot: string;
}

function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

export function validateWorkflowLocalShadowEndpoint(value: string, routes: readonly string[]): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new TypeError('Workflow local shadow endpoint is invalid.', { cause: error });
  }
  const exactValues =
    endpoint.pathname === '/'
      ? [endpoint.origin, `${endpoint.origin}/`]
      : [`${endpoint.origin}${endpoint.pathname}`];
  if (
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
    endpoint.port === '' ||
    !routes.includes(endpoint.pathname) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    !exactValues.includes(value)
  ) {
    throw new TypeError('Workflow local shadow endpoint must be an exact loopback URL.');
  }
  return endpoint;
}

/** Shared, side-effect-free validation for every local Workflow shadow port. */
export function validateWorkflowLocalShadowConfig(options: {
  readonly workspaceRoot: string;
  readonly journalRoot: string;
  readonly endpoint: string;
  readonly routes: readonly string[];
  readonly protectedRelativeRoots?: readonly string[];
}): WorkflowLocalShadowConfig {
  if (
    !isAbsolute(options.workspaceRoot) ||
    resolve(options.workspaceRoot) !== options.workspaceRoot ||
    !isAbsolute(options.journalRoot) ||
    resolve(options.journalRoot) !== options.journalRoot
  ) {
    throw new TypeError('Workflow local shadow paths must be normalized and absolute.');
  }
  const endpoint = validateWorkflowLocalShadowEndpoint(options.endpoint, options.routes);
  validateWorkflowLocalShadowJournalRoot(options);
  return Object.freeze({ endpoint, journalRoot: options.journalRoot });
}

export function validateWorkflowLocalShadowJournalRoot(options: {
  readonly workspaceRoot: string;
  readonly journalRoot: string;
  readonly protectedRelativeRoots?: readonly string[];
}): string {
  if (
    !isAbsolute(options.workspaceRoot) ||
    resolve(options.workspaceRoot) !== options.workspaceRoot ||
    !isAbsolute(options.journalRoot) ||
    resolve(options.journalRoot) !== options.journalRoot
  ) {
    throw new TypeError('Workflow local shadow paths must be normalized and absolute.');
  }
  const localRoot = join(options.workspaceRoot, '.openslack.local');
  if (!within(localRoot, options.journalRoot) || options.journalRoot === localRoot) {
    throw new TypeError('Workflow local shadow journal must be below .openslack.local.');
  }
  for (const relativeRoot of options.protectedRelativeRoots ?? []) {
    const protectedRoot = join(localRoot, relativeRoot);
    if (within(protectedRoot, options.journalRoot) || within(options.journalRoot, protectedRoot)) {
      throw new TypeError('Workflow local shadow journal overlaps protected authority evidence.');
    }
  }
  return options.journalRoot;
}
