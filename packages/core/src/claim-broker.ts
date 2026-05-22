import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface Lease {
  leaseId: string;
  taskId: string;
  agentId: string;
  status: 'active' | 'expired' | 'released';
  createdAt: string;
  expiresAt: string;
  heartbeatAt: string;
  releasedAt?: string;
  ttlMinutes: number;
  allowedPaths: string[];
}

export interface ClaimRequest {
  agentId: string;
  taskId: string;
  ttlMinutes?: number;
  capabilities: string[];
}

export interface ClaimResult {
  claimStatus: 'granted' | 'denied';
  taskId: string;
  leaseId?: string;
  lease?: Lease;
  expiresAt?: string;
  reason?: 'NOT_READY' | 'ALREADY_CLAIMED' | 'CAPABILITY_MISMATCH' | 'RISK_EXCEEDED' | 'BUDGET_EXCEEDED' | 'AGENT_PAUSED' | 'LOCK_TIMEOUT';
}

export class ClaimBroker {
  protected leases: Map<string, Lease> = new Map();
  protected taskLeases: Map<string, string> = new Map();
  protected taskStates: Map<string, string> = new Map();
  protected leaseSeq = 0;

  constructor() {}

  setTaskReady(taskId: string): void {
    this.taskStates.set(taskId, 'ready');
  }

  getActiveLease(taskId: string): Lease | null {
    const leaseId = this.taskLeases.get(taskId);
    if (!leaseId) return null;
    const lease = this.leases.get(leaseId);
    if (!lease) return null;
    if (lease.status === 'active' && new Date(lease.expiresAt) <= new Date()) {
      lease.status = 'expired';
      this.taskLeases.delete(taskId);
      this.taskStates.set(taskId, 'ready');
      return null;
    }
    return lease.status === 'active' ? lease : null;
  }

  claimTask(request: ClaimRequest): ClaimResult {
    const { agentId, taskId, ttlMinutes = 60 } = request;
    void ttlMinutes; // used by subclasses

    // Check for existing active lease first (more specific than generic NOT_READY)
    const existingLease = this.getActiveLease(taskId);
    if (existingLease) {
      return { claimStatus: 'denied', taskId, reason: 'ALREADY_CLAIMED' };
    }

    const state = this.taskStates.get(taskId);
    if (state !== 'ready') {
      return { claimStatus: 'denied', taskId, reason: 'NOT_READY' };
    }

    this.leaseSeq++;
    const year = new Date().getFullYear();
    const leaseId = `LEASE-${year}-${String(this.leaseSeq).padStart(6, '0')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60000);

    const lease: Lease = {
      leaseId,
      taskId,
      agentId,
      status: 'active',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      heartbeatAt: now.toISOString(),
      ttlMinutes,
      allowedPaths: [],
    };

    this.leases.set(leaseId, lease);
    this.taskLeases.set(taskId, leaseId);
    this.taskStates.set(taskId, 'claimed');

    return {
      claimStatus: 'granted',
      taskId,
      leaseId,
      lease,
      expiresAt: lease.expiresAt,
    };
  }

  heartbeat(leaseId: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.status !== 'active') return false;
    if (new Date(lease.expiresAt) <= new Date()) {
      lease.status = 'expired';
      this.taskLeases.delete(lease.taskId);
      this.taskStates.set(lease.taskId, 'ready');
      return false;
    }
    const now = new Date();
    lease.heartbeatAt = now.toISOString();
    lease.expiresAt = new Date(now.getTime() + lease.ttlMinutes * 60000).toISOString();
    return true;
  }

  releaseLease(leaseId: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.status !== 'active') return false;
    lease.status = 'released';
    lease.releasedAt = new Date().toISOString();
    this.taskLeases.delete(lease.taskId);
    this.taskStates.set(lease.taskId, 'ready');
    return true;
  }

  expireLease(leaseId: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    lease.status = 'expired';
    this.taskLeases.delete(lease.taskId);
    this.taskStates.set(lease.taskId, 'ready');
    return true;
  }

  getLease(leaseId: string): Lease | undefined {
    return this.leases.get(leaseId);
  }

  getStats(): { activeLeases: number; totalLeases: number; readyTasks: number } {
    let activeCount = 0;
    for (const [, lease] of this.leases) {
      if (lease.status === 'active' && new Date(lease.expiresAt) > new Date()) activeCount++;
    }
    let readyCount = 0;
    for (const [, state] of this.taskStates) {
      if (state === 'ready') readyCount++;
    }
    return { activeLeases: activeCount, totalLeases: this.leases.size, readyTasks: readyCount };
  }

  /** For testing: reset all state */
  _reset(): void {
    this.leases.clear();
    this.taskLeases.clear();
    this.taskStates.clear();
    this.leaseSeq = 0;
  }
}

/** File-backed ClaimBroker — persists leases to .openslack/leases/lease-state.json */
export class FileClaimBroker extends ClaimBroker {
  private statePath: string;
  private lockPath: string;
  private lockFd: number | null = null;

  constructor(openslackRoot: string) {
    super();
    this.statePath = join(openslackRoot, '.openslack', 'leases', 'lease-state.json');
    this.lockPath = this.statePath + '.lock';
    this.loadWithLock();
  }

  private acquireLock(timeoutMs = 5000): boolean {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        // Exclusive create via 'wx' flag — fails if lock already exists
        this.lockFd = openSync(this.lockPath, 'wx');
        return true;
      } catch {
        // Lock held by another process — retry after short delay
        const wait = Math.random() * 50 + 25;
        if (typeof Atomics.wait === 'function') {
          const sab = new SharedArrayBuffer(4);
          Atomics.wait(new Int32Array(sab), 0, 0, wait);
        }
      }
    }
    return false;
  }

  private releaseLock(): void {
    if (this.lockFd !== null) {
      try { closeSync(this.lockFd); } catch { /* ignore */ }
      this.lockFd = null;
    }
    try { unlinkSync(this.lockPath); } catch { /* ignore */ }
  }

  private loadWithLock(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const raw = readFileSync(this.statePath, 'utf-8');
      const data = JSON.parse(raw);
      this.leaseSeq = data.leaseSeq || 0;
      for (const [k, v] of Object.entries(data.leases || {})) {
        this.leases.set(k, v as Lease);
      }
      for (const [k, v] of Object.entries(data.taskLeases || {})) {
        this.taskLeases.set(k, v as string);
      }
      for (const [k, v] of Object.entries(data.taskStates || {})) {
        this.taskStates.set(k, v as string);
      }
    } catch {
      // Corrupted state — start fresh
    }
  }

  private saveWithLock(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = this.statePath + '.tmp';
    const data = {
      leaseSeq: this.leaseSeq,
      leases: Object.fromEntries(this.leases),
      taskLeases: Object.fromEntries(this.taskLeases),
      taskStates: Object.fromEntries(this.taskStates),
    };
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, this.statePath);
  }

  override claimTask(request: ClaimRequest): ClaimResult {
    if (!this.acquireLock()) return { claimStatus: 'denied', taskId: request.taskId, reason: 'LOCK_TIMEOUT' };
    try {
      this.loadWithLock();
      const result = super.claimTask(request);
      if (result.claimStatus === 'granted') this.saveWithLock();
      return result;
    } finally {
      this.releaseLock();
    }
  }

  override heartbeat(leaseId: string): boolean {
    if (!this.acquireLock()) return false;
    try {
      this.loadWithLock();
      const result = super.heartbeat(leaseId);
      if (result) this.saveWithLock();
      return result;
    } finally {
      this.releaseLock();
    }
  }

  override releaseLease(leaseId: string): boolean {
    if (!this.acquireLock()) return false;
    try {
      this.loadWithLock();
      const result = super.releaseLease(leaseId);
      if (result) this.saveWithLock();
      return result;
    } finally {
      this.releaseLock();
    }
  }

  override expireLease(leaseId: string): boolean {
    if (!this.acquireLock()) return false;
    try {
      this.loadWithLock();
      const result = super.expireLease(leaseId);
      if (result) this.saveWithLock();
      return result;
    } finally {
      this.releaseLock();
    }
  }

  override _reset(): void {
    super._reset();
    try { unlinkSync(this.statePath); } catch { /* ignore */ }
  }
}
