import { describe, expect, test } from "bun:test";
import { renderAgentInspection, renderWorkflowTree } from "../src/display";
import type { WorkflowRunState } from "../src/types";

function makeRun(): WorkflowRunState {
  return {
    id: "run_1",
    goal: "Ship feature",
    status: "running",
    createdAt: 1_000,
    agents: new Map([
      [
        "scout",
        {
          id: "scout",
          className: "researcher",
          task: "Find relevant files",
          runId: "run_1",
          depth: 0,
          status: "completed",
          startedAt: 1_000,
          completedAt: 2_000,
          summary: "Found src/a.ts and src/b.ts",
        },
      ],
      [
        "writer",
        {
          id: "writer",
          className: "coder",
          task: "Implement change",
          runId: "run_1",
          depth: 0,
          status: "running",
          startedAt: 2_000,
        },
      ],
      [
        "child-review",
        {
          id: "child-review",
          className: "reviewer",
          task: "Review writer output",
          parentAgentId: "writer",
          runId: "run_1",
          depth: 1,
          status: "pending",
        },
      ],
    ]),
    messages: [{ id: "msg", runId: "run_1", from: "scout", text: "done", createdAt: 1_500 }],
    blackboard: [{ id: "note", runId: "run_1", agentId: "scout", kind: "finding", text: "Found files", createdAt: 1_600 }],
    events: [
      { id: "evt1", runId: "run_1", agentId: "scout", type: "agent_end", message: "scout completed", createdAt: 2_000 },
      { id: "evt2", runId: "run_1", agentId: "writer", type: "agent_start", message: "writer started", createdAt: 2_100 },
    ],
  };
}

describe("renderWorkflowTree", () => {
  test("renders startup state before a run exists", () => {
    expect(renderWorkflowTree(undefined)).toContain("Starting workflow");
    expect(renderWorkflowTree(undefined)).toContain("Press Esc");
  });

  test("renders a tree with statuses, nested agents, counts, and recent events", () => {
    const output = renderWorkflowTree(makeRun(), { includeOutputs: true, now: 3_000 });

    expect(output).toContain("PI WORKFLOW ⏳ RUNNING");
    expect(output).toContain("goal: Ship feature");
    expect(output).toContain("agents: 1 running, 1 pending, 1 completed");
    expect(output).toContain("├─ ✓ scout [researcher] completed");
    expect(output).toContain("╰─ ⏳ writer [coder] running");
    expect(output).toContain("╰─ … child-review [reviewer] pending");
    expect(output).toContain("output: Found src/a.ts and src/b.ts");
    expect(output).toContain("RECENT EVENTS");
  });

  test("renders an individual subagent inspection panel", () => {
    const output = renderAgentInspection(makeRun(), "scout");

    expect(output).toContain("SUBAGENT scout");
    expect(output).toContain("class: researcher");
    expect(output).toContain("Found src/a.ts and src/b.ts");
    expect(output).toContain("MESSAGE BUS");
    expect(output).toContain("BLACKBOARD");
  });
});
