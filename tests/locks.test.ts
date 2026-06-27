import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  WorkflowLockManager,
  looksLikeMutatingShellCommand,
  normalizeWorkflowPath,
  pathsConflict,
} from "../src/locks";
import type { WorkflowRunState } from "../src/types";

function makeRun(id = "run_test"): WorkflowRunState {
  return {
    id,
    status: "running",
    createdAt: Date.now(),
    agents: new Map(),
    messages: [],
    blackboard: [],
    events: [],
  };
}

describe("WorkflowLockManager", () => {
  test("allows the same agent to reacquire an existing write lock", async () => {
    const manager = new WorkflowLockManager();
    const cwd = "/tmp/pi-workflows-locks";

    const [first] = await manager.acquire({ cwd, runId: "run", agentId: "agent-a", paths: ["src/file.ts"] });
    const [second] = await manager.acquire({ cwd, runId: "run", agentId: "agent-a", paths: ["src/file.ts"] });

    expect(second?.id).toBe(first?.id);
    expect(manager.snapshot("run")).toHaveLength(1);
  });

  test("blocks another agent from locking the same file", async () => {
    const manager = new WorkflowLockManager();
    const events: Array<{ type: string }> = [];
    const cwd = "/tmp/pi-workflows-locks";

    await manager.acquire({ cwd, runId: "run", agentId: "agent-a", paths: ["src/file.ts"] });

    await expect(
      manager.acquire({
        cwd,
        runId: "run",
        agentId: "agent-b",
        paths: ["src/file.ts"],
        onEvent: (event) => events.push({ type: event.type }),
      }),
    ).rejects.toThrow(/Write lock conflict/);
    expect(events.some((event) => event.type === "write_lock_conflict")).toBe(true);
  });

  test("treats parent and child paths as conflicting", async () => {
    const manager = new WorkflowLockManager();
    const cwd = "/tmp/pi-workflows-locks";

    await manager.acquire({ cwd, runId: "run", agentId: "agent-a", paths: ["src/"] });

    await expect(
      manager.acquire({ cwd, runId: "run", agentId: "agent-b", paths: ["src/nested/file.ts"] }),
    ).rejects.toThrow(/Write lock conflict/);
  });

  test("allows non-overlapping paths", async () => {
    const manager = new WorkflowLockManager();
    const cwd = "/tmp/pi-workflows-locks";

    await manager.acquire({ cwd, runId: "run", agentId: "agent-a", paths: ["src/a.ts"] });
    await manager.acquire({ cwd, runId: "run", agentId: "agent-b", paths: ["src/b.ts"] });

    expect(manager.snapshot("run").map((lock) => lock.path).sort()).toEqual([
      resolve(cwd, "src/a.ts"),
      resolve(cwd, "src/b.ts"),
    ]);
  });

  test("releaseRun clears only that run's locks and logs an event", async () => {
    const manager = new WorkflowLockManager();
    const run = makeRun("run-a");
    const other = makeRun("run-b");
    const cwd = "/tmp/pi-workflows-locks";

    await manager.acquire({ cwd, runId: run.id, agentId: "agent-a", paths: ["src/a.ts"] });
    await manager.acquire({ cwd, runId: other.id, agentId: "agent-b", paths: ["src/b.ts"] });

    manager.releaseRun(run);

    expect(manager.snapshot(run.id)).toHaveLength(0);
    expect(manager.snapshot(other.id)).toHaveLength(1);
    expect(run.events.at(-1)?.type).toBe("write_locks_released");
  });
});

describe("path conflict helpers", () => {
  test("normalizes paths relative to cwd", () => {
    expect(normalizeWorkflowPath("/tmp/project", "src/../README.md")).toBe("/tmp/project/README.md");
  });

  test("detects exact and nested path conflicts", () => {
    expect(pathsConflict("/repo/src", "/repo/src/file.ts")).toBe(true);
    expect(pathsConflict("/repo/src/file.ts", "/repo/src/file.ts")).toBe(true);
    expect(pathsConflict("/repo/src/a.ts", "/repo/src/b.ts")).toBe(false);
  });
});

describe("mutating shell command detection", () => {
  test("leaves common read-only commands unlocked", () => {
    expect(looksLikeMutatingShellCommand("rg workflow src && git diff --stat")).toBe(false);
    expect(looksLikeMutatingShellCommand("python3 - <<'PY'\nprint('read only')\nPY")).toBe(false);
  });

  test("flags shell commands that likely mutate files", () => {
    expect(looksLikeMutatingShellCommand("sed -i '' 's/a/b/' src/file.ts")).toBe(true);
    expect(looksLikeMutatingShellCommand("echo hi > src/file.ts")).toBe(true);
    expect(looksLikeMutatingShellCommand("rm -rf dist")).toBe(true);
    expect(looksLikeMutatingShellCommand("bun install")).toBe(true);
    expect(looksLikeMutatingShellCommand("node -e \"require('fs').writeFileSync('x','y')\"")).toBe(true);
  });
});
