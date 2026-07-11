export type DeliveryState =
  | 'PREPARED'
  | 'PUSHED'
  | 'PR_CREATED'
  | 'PR_UPDATED'
  | 'HEAD_SYNCHRONIZED'
  | 'AWAITING_GATES';

export interface DeliveryToken {
  value: string;
  expiresAt: string;
  installationId: string;
  permissions: Readonly<Record<string, string>>;
}

export interface DeliveryTokenProvider {
  acquire(options?: { forceRefresh?: boolean }): Promise<DeliveryToken>;
  invalidate(reason: 'authentication_failed' | 'operator_refresh'): void;
}

export interface DeliveryPermissionCheck {
  capability: 'contents' | 'pull_requests' | 'issues';
  required: 'write';
  actual: string | null;
  status: 'PASS' | 'FAIL' | 'WARN';
}

export interface DeliveryPullRequest {
  number: number;
  url: string;
  headOwner: string;
  headRepo: string;
  headRef: string;
  headSha: string;
}

export interface DeliveryCheckSnapshot {
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
}

export interface DeliveryGitHubApi {
  findOpenPullRequests(input: {
    owner: string;
    repo: string;
    headOwner: string;
    head: string;
  }): Promise<DeliveryPullRequest[]>;
  createDraftPullRequest(input: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<DeliveryPullRequest>;
  updatePullRequest(input: {
    owner: string;
    repo: string;
    number: number;
    base: string;
    title: string;
    body: string;
  }): Promise<DeliveryPullRequest>;
  getPullRequest(input: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<DeliveryPullRequest>;
  listChecks(input: { owner: string; repo: string; ref: string }): Promise<DeliveryCheckSnapshot[]>;
}

export interface GitBranchPublisher {
  push(input: {
    rootDir: string;
    remote: string;
    branch: string;
    owner: string;
    repo: string;
    token: string;
    timeoutMs: number;
  }): { branchSha: string; remoteSha: string };
  readRemoteSha(input: {
    rootDir: string;
    remote: string;
    branch: string;
    owner: string;
    repo: string;
    token: string;
    timeoutMs: number;
  }): string;
}

export interface GitHubDeliveryInput {
  rootDir: string;
  owner: string;
  repo: string;
  branch: string;
  base?: string;
  title: string;
  body: string;
  remote?: string;
  timeoutMs?: number;
  requireIssuesWrite?: boolean;
}

export interface GitHubDeliveryResult {
  state: 'AWAITING_GATES';
  history: readonly DeliveryState[];
  action: 'created' | 'updated';
  prNumber: number;
  prUrl: string;
  branchSha: string;
  prHeadSha: string;
  checks: DeliveryCheckSnapshot[];
  checksStatus: 'empty' | 'observed';
  permissions: DeliveryPermissionCheck[];
  evidenceTimestamp: string;
}
