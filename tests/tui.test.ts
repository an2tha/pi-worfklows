import { describe, expect, test } from "bun:test";
import { WorkflowOverlay } from "../src/tui";
import type { WorkflowEngine } from "../src/engine";
import type { WorkflowRunState } from "../src/types";

function makeRun(): WorkflowRunState {
  return {
    id: "run_overlay",
    goal: "Overlay test",
    status: "running",
    createdAt: 1_000,
    agents: new Map([
      ["writer", { id: "writer", className: "coder", task: "Write code", runId: "run_overlay", depth: 0, status: "running", startedAt: 1_000 }],
      ["review", { id: "review", className: "reviewer", task: "Review code", parentAgentId: "writer", runId: "run_overlay", depth: 1, status: "pending" }],
    ]),
    messages: [],
    blackboard: [],
    events: [{ id: "evt", runId: "run_overlay", agentId: "writer", type: "tool_start", message: "bash started", data: { toolCallId: "tool_1" }, createdAt: 1_200 }],
  };
}

describe("WorkflowOverlay", () => {
  test("renders a floating workflow panel with controls and agent graph", () => {
    const run = makeRun();
    const overlay = new WorkflowOverlay({
      engine: { getRun: () => run } as unknown as WorkflowEngine,
      getRunId: () => run.id,
      done: () => {},
      abort: () => {},
    });

    const output = overlay.render(100).join("\n");

    expect(output).toContain("pi workflows");
    expect(output).toContain("Overlay test");
    expect(output).toContain("writer [coder]");
    expect(output).toContain("review [reviewer]");
    expect(output).toContain("q close");
  });

  test("supports collapsing tree nodes", () => {
    const run = makeRun();
    const overlay = new WorkflowOverlay({
      engine: { getRun: () => run } as unknown as WorkflowEngine,
      getRunId: () => run.id,
      done: () => {},
      abort: () => {},
    });

    expect(overlay.render(100).join("\n")).toContain("review [reviewer]");
    overlay.handleInput(" ");
    expect(overlay.render(100).join("\n")).not.toContain("review [reviewer]");
  });

  test("q closes and escape aborts", () => {
    const run = makeRun();
    let closed = false;
    let aborted = false;
    const overlay = new WorkflowOverlay({
      engine: { getRun: () => run } as unknown as WorkflowEngine,
      getRunId: () => run.id,
      done: () => { closed = true; },
      abort: () => { aborted = true; },
    });

    overlay.handleInput("q");
    overlay.handleInput("\x1b");

    expect(closed).toBe(true);
    expect(aborted).toBe(true);
  });

  test("injects prompts into the selected running subagent", () => {
    const run = makeRun();
    const injections: Array<{ runId: string; agentId: string; prompt: string }> = [];
    const overlay = new WorkflowOverlay({
      engine: {
        getRun: () => run,
        injectPrompt: (runId: string, agentId: string, prompt: string) => {
          injections.push({ runId, agentId, prompt });
          return { runId, agentId, mode: "steer", prompt };
        },
      } as unknown as WorkflowEngine,
      getRunId: () => run.id,
      done: () => {},
      abort: () => {},
    });

    overlay.handleInput("p");
    for (const char of "please hurry") overlay.handleInput(char);
    overlay.handleInput("\r");

    expect(injections).toEqual([{ runId: "run_overlay", agentId: "writer", prompt: "please hurry" }]);
  });
});
