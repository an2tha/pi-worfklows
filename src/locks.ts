import { resolve, relative, sep } from "node:path";
import type { WorkflowEvent, WorkflowRunState } from "./types";
import { makeId } from "./bus";

export interface WorkflowWriteLock {
  id: string;
  runId: string;
  agentId: string;
  path: string;
  acquiredAt: number;
  reason?: string;
}

export interface WorkflowLockAcquireOptions {
  cwd: string;
  runId: string;
  agentId: string;
  paths: string[];
  timeoutMs?: number;
  reason?: string;
  onEvent?: (event: Omit<WorkflowEvent, "id" | "runId" | "createdAt">) => void;
}

export class WorkflowLockManager {
  private readonly locks = new Map<string, WorkflowWriteLock>();

  async acquire(options: WorkflowLockAcquireOptions): Promise<WorkflowWriteLock[]> {
    const paths = uniqueNormalizedPaths(options.cwd, options.paths);
    if (paths.length === 0) return [];

    const deadline = Date.now() + Math.max(0, options.timeoutMs ?? 0);
    while (true) {
      const conflict = this.findConflict(paths, options.agentId);
      if (!conflict) {
        const locks = paths.map((path) => this.acquireOne(path, options));
        options.onEvent?.({
          agentId: options.agentId,
          type: "write_lock_acquired",
          message: `${options.agentId} acquired ${locks.length} write lock(s)`,
          data: { locks },
        });
        return locks;
      }

      if (!options.timeoutMs || Date.now() >= deadline) {
        options.onEvent?.({
          agentId: options.agentId,
          type: "write_lock_conflict",
          message: `${options.agentId} blocked by ${conflict.agentId} on ${conflict.path}`,
          data: { requestedPaths: paths, conflict },
        });
        throw new Error(
          `Write lock conflict: ${options.agentId} cannot write ${paths.join(", ")} because ${conflict.agentId} holds ${conflict.path}`,
        );
      }

      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }

  snapshot(runId?: string): WorkflowWriteLock[] {
    return Array.from(this.locks.values()).filter((lock) => !runId || lock.runId === runId);
  }

  releaseRun(run: WorkflowRunState): void {
    const released: WorkflowWriteLock[] = [];
    for (const [path, lock] of this.locks) {
      if (lock.runId !== run.id) continue;
      this.locks.delete(path);
      released.push(lock);
    }
    if (released.length > 0) {
      run.events.push({
        id: makeId("evt"),
        runId: run.id,
        type: "write_locks_released",
        message: `released ${released.length} write lock(s)`,
        data: { locks: released },
        createdAt: Date.now(),
      });
    }
  }

  private acquireOne(path: string, options: WorkflowLockAcquireOptions): WorkflowWriteLock {
    const existing = this.locks.get(path);
    if (existing && existing.agentId === options.agentId) return existing;
    const lock: WorkflowWriteLock = {
      id: makeId("lock"),
      runId: options.runId,
      agentId: options.agentId,
      path,
      acquiredAt: Date.now(),
      reason: options.reason,
    };
    this.locks.set(path, lock);
    return lock;
  }

  private findConflict(paths: string[], ownerAgentId: string): WorkflowWriteLock | undefined {
    for (const requested of paths) {
      for (const lock of this.locks.values()) {
        if (lock.agentId === ownerAgentId) continue;
        if (pathsConflict(requested, lock.path)) return lock;
      }
    }
    return undefined;
  }
}

export function normalizeWorkflowPath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

export function pathsConflict(left: string, right: string): boolean {
  if (left === right) return true;
  const leftToRight = relative(left, right);
  if (leftToRight && !leftToRight.startsWith("..") && !leftToRight.startsWith(sep)) return true;
  const rightToLeft = relative(right, left);
  return Boolean(rightToLeft && !rightToLeft.startsWith("..") && !rightToLeft.startsWith(sep));
}

export function looksLikeMutatingShellCommand(command: string): boolean {
  const normalized = command.replace(/#[^\n]*/g, " ");
  const mutatingPatterns = [
    /(^|[;&|\n]\s*)(>|>>)/,
    /\s(>|>>|2>|2>>|&>|&>>)\s*\S+/,
    /\b(cat|tee)\b[\s\S]*\s(>|>>|--append|-a)\b/,
    /\b(sed|perl)\b[^\n;]*\s-i(\b|\s|['"])/,
    /\b(rm|mv|cp|install|touch|mkdir|rmdir|ln|chmod|chown|truncate)\b/,
    /\b(git\s+(apply|checkout|restore|reset|clean|merge|rebase|commit|stash|cherry-pick|switch|add))\b/,
    /\b(bun|npm|pnpm|yarn)\s+(install|add|remove|update|upgrade|dedupe|audit\s+fix)\b/,
    /\b(python3?|ruby|node|bun)\b[\s\S]*\b(write_text|writeFile|writeFileSync|appendFile|appendFileSync|open\([^\n)]*['"](?:w|a|x|\+))/,
  ];
  return mutatingPatterns.some((pattern) => pattern.test(normalized));
}

function uniqueNormalizedPaths(cwd: string, paths: string[]): string[] {
  const normalized = paths
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => normalizeWorkflowPath(cwd, path));
  return Array.from(new Set(normalized)).sort();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
