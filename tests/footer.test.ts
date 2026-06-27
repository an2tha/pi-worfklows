import { describe, expect, test } from "bun:test";
import { createWorkflowFooter } from "../src/footer";
import type { WorkflowEngine } from "../src/engine";

const theme = {
  fg: (_name: string, text: string) => text,
};

const footerData = {
  getGitBranch: () => "main",
  getAvailableProviderCount: () => 1,
  getExtensionStatuses: () => new Map(),
};

describe("createWorkflowFooter", () => {
  test("adds workflow subagent usage into the main statusbar totals", () => {
    const ctx = {
      model: { id: "heavy", provider: "test", contextWindow: 100000 },
      getContextUsage: () => ({ percent: 12.3, contextWindow: 100000 }),
      sessionManager: {
        getCwd: () => "/repo",
        getSessionName: () => undefined,
        getSessionId: () => "session-a",
        getEntries: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              usage: {
                input: 1000,
                output: 500,
                cacheRead: 200,
                cacheWrite: 100,
                totalTokens: 1800,
                cost: { total: 0.01 },
              },
            },
          },
        ],
      },
    };
    const engine = {
      getWorkflowUsage: (sessionId?: string) => {
        expect(sessionId).toBe("session-a");
        return { input: 300, output: 100, cacheRead: 50, cacheWrite: 0, totalTokens: 450, cost: 0.005 };
      },
    };

    const lines = createWorkflowFooter(ctx as never, engine as unknown as WorkflowEngine, theme, footerData).render(120);
    const stats = lines[1] ?? "";

    expect(stats).toContain("↑1.3k");
    expect(stats).toContain("↓600");
    expect(stats).toContain("$0.015 wf+$0.005");
    expect(stats).toContain("wf:450tok");
  });
});
