# pi-agent-workflows

A pi extension that lets an overseer model spawn typed workflow subagents from JSON.

## What is implemented

- `workflow_spawn` tool: accepts a compact `WorkflowPlan` JSON string and runs subagents sequentially or in parallel.
- Floating workflow window: `workflow_spawn` opens a focused overlay with collapsible agent trees, tool-call overview, per-agent inspection, pricing, and controls.
- Status/statusbar accounting: subagent token/cost usage is reported without replacing other extension footers by default; legacy footer replacement is opt-in.
- Overlay controls: `q` closes, Esc aborts, Tab switches views, arrows/j/k select agents, and `u`/`d` or `[`/`]` scroll on keyboards without Page Up/Down.
- Individual inspection: `workflow_inspect_agent`, `/workflow-inspect`, or the overlay Inspect tab show one subagent’s task, model, output, messages, notes, events, usage, and controls.
- Prompt injection: `workflow_prompt`, `/workflow-prompt`, or `p` inside the overlay can steer active subagents while they run.
- Escape abort: pressing Esc in the overlay aborts the workflow and propagates cancellation to running subagents.
- Recursive spawning: agent classes can opt into `canSpawn` and restrict child classes.
- Per-agent model selection: use `model` on a class or spawn spec. Use `@fast`, `@default`, or `@current` sentinels.
- Inter-agent communication: subagents share `workflow_send`, `workflow_receive`, and `workflow_blackboard`.
- Global write locks: mutating bash commands must declare `writePaths`; locks prevent subagents from claiming the same file/path during a run.
- Bash for every subagent: the `bash` tool is mandatory for all spawned agents.
- Root skill inheritance: available/loaded skills from the overseer context are carried into subagent prompts.
- TypeScript API: register custom agent classes and custom workflow tools with `createWorkflowExtension`, `defineAgentClass`, and `defineWorkflowTool`.
- Main-agent skill: `skills/pi-workflows/SKILL.md` tells the agent to get an overview first, use workflows only for clearly defined substantial work, and route `@fast`/`@default` models appropriately.

## Install

Install from npm:

```bash
pi install npm:pi-agent-workflows
```

Or install directly from GitHub:

```bash
pi install git:github.com/an2tha/pi-worfklows
```

For local development, try a checkout without installing:

```bash
pi -e /path/to/pi-workflows/index.ts
```

Configure workflow model aliases, enable/disable the extension, and choose non-invasive status vs footer replacement mode:

```text
/workflow-settings
/workflow-settings show
/workflow-settings disable
/workflow-settings enable
/workflow-settings footer status
```

Manually force workflows for a task when you know the extra cost is worthwhile:

```text
/workflow-force <task>
/workflow-force-next <task>
```

## Custom workflow ideas

Agents are encouraged to create task-specific workflow plans rather than reuse canned templates. Good custom shapes include:

- subsystem split: one agent per package/API/feature area
- risk split: compatibility, migration, concurrency, security, UX/accessibility
- ownership split: one writer per non-overlapping file group with write locks
- validation split: tests, typecheck/lint, repro scripts, docs examples, smoke checks
- release split: docs/examples, packaging, changelog/install verification

Use `/workflow-classes` to see registered classes, then assign custom ids, task text, dependencies, and limits for the current request.

Configure workflow behavior and fast/default model aliases in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "workflows": {
    "enabled": true,
    "footerMode": "status",
    "fastModel": "openai-codex/codex-5.3-spark",
    "defaultModel": "anthropic/claude-sonnet-4-5"
  }
}
```

Environment variables are still supported as fallback:

```bash
PI_WORKFLOW_FAST_MODEL=openai-codex/codex-5.3-spark
PI_WORKFLOW_DEFAULT_MODEL=anthropic/claude-sonnet-4-5
```

## Write locking

The subagent `bash` tool treats read commands as unlocked. Commands that look mutating are rejected unless they pass `writePaths`.

Example mutating bash call inside a custom workflow tool:

```ts
await ctx.bash("python3 scripts/update.py src/cache.ts", {
  writePaths: ["src/cache.ts"],
  lockTimeoutMs: 5000,
});
```

Locks are global to the engine and held for the workflow run. This prevents two subagents from owning the same file or a parent/child path concurrently.

## TypeScript API sketch

```ts
import Type from "typebox";
import {
  createWorkflowExtension,
  defineAgentClass,
  defineWorkflowTool,
  textResult,
} from "pi-agent-workflows";

export default createWorkflowExtension({
  agentClasses: [
    defineAgentClass({
      name: "docs-writer",
      description: "Writes concise documentation from findings.",
      model: "@fast",
      tools: ["bash", "summarize_file"],
    }),
  ],
  tools: [
    defineWorkflowTool({
      name: "summarize_file",
      description: "Read a file and return a short summary.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(params, ctx) {
        const quotedPath = JSON.stringify(params.path);
        const result = await ctx.bash(`python3 - <<'PY'\nfrom pathlib import Path\nprint(Path(${quotedPath}).read_text()[:2000])\nPY`);
        return textResult(result.stdout, result);
      },
    }),
  ],
});
```

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```
