---
name: pi-workflows
description: Use pi workflow subagents only for clearly defined, substantial codebase work where parallel cheap scouts and focused writer agents justify the extra workflow cost.
---

# Pi Workflows

Workflow runs are costly. Do not use the workflow engine automatically for small, ambiguous, or one-shot tasks. Use it only after you understand the task well enough to define narrow subagent work and the task is large enough for parallelism or focused delegation to justify the extra model cost.

## Default orchestration pattern

1. First get an overview yourself: restate the goal, inspect the existing state enough to identify relevant files/risks, and decide whether the task is clearly defined and big enough for workflows.
2. Do not spawn workflows for trivial edits, simple questions, single-file lookups, or unclear requests. If the task is ambiguous, clarify or plan before spawning.
3. Use workflows when the work is substantial and decomposable: broad repo exploration, multi-file changes, independent reviews/tests, or parallel research/writing with clear ownership.
4. Design a custom workflow for the current task. Do not reuse canned/builtin workflow ideas by default; invent agent ids, responsibilities, dependencies, and stop conditions that match the user's exact request.
5. Stay the orchestrator: keep the overall goal, constraints, cost control, and final decision-making in the main conversation.
6. Manual force overrides (`/workflow-force`, `/workflow-force-next`, or an explicit user request to use workflows) may bypass the size threshold, but still make a brief overview and keep the custom plan narrow.
7. Model routing is mandatory:
   - ALWAYS use the fast model alias `@fast` for inspection: repo scouting, file discovery, reading code, risk review, tests, validation, search, and summarization of existing facts.
   - ALWAYS use the heavy/default model alias `@default` for generation: writing code, editing files, architecture decisions, final synthesis, migration design, and any task that creates new implementation.
   - Route by work type, not by template name: cheap/fast for observing and validating; heavy/default only for implementation or synthesis.
8. Use `strategy: "parallel"` for independent custom agents; use `dependsOn` when an agent needs another agent's findings first.
9. Keep subagent tasks narrow. Give explicit paths, expected outputs, and limits.
10. Use the live `workflow_spawn` tree plus `workflow_inspect_agent` for individual subagent inspection.
11. Use `workflow_prompt` to inject steering prompts into active subagents when the orchestrator needs to correct course.
12. Use `workflow_status` to inspect results, token usage, and cost, then synthesize and decide next steps yourself.

## Writing code safely

Subagents share a global write-lock system.

- Read-only bash commands require no lock.
- Any mutating bash command must declare `writePaths` with every file/directory it may create, modify, or delete.
- Write locks are held for the workflow run, so two subagents cannot claim the same file or parent/child path.
- If a lock conflict occurs, do not work around it. Re-plan: assign one owner, split files, or have the orchestrator merge changes.
- Prefer one writer per file. Let cheap agents scout/review while the orchestrator or a single writer owns edits.

## Skills and context

Skills available or loaded in the root conversation are inherited by workflow subagents. If a subagent task matches an inherited skill, tell it to follow that skill and read referenced files as needed. Keep inherited skill use focused to avoid token bloat.

## Custom workflow ideas

When a workflow is justified, invent a plan for the user's task instead of copying a builtin template. Use `/workflow-classes` if you need to see registered classes, but make the workflow shape, agent ids, task text, dependencies, and limits custom.

Useful custom shapes:

- **Subsystem split**: one agent per package, API boundary, or feature area; each returns evidence and file paths.
- **Risk split**: separate agents for compatibility, data migration, concurrency, security, or UX/accessibility risks.
- **Ownership split**: one writer per file group or module boundary, with explicit write locks and no overlapping paths.
- **Validation split**: separate agents for focused tests, typecheck/lint, repro scripts, docs examples, or smoke checks.
- **Migration split**: one agent maps call sites, one updates implementation, one checks backwards compatibility, one validates behavior.
- **Release split**: one agent writes docs/examples, one verifies packaging, one reviews changelog/install instructions.

For every custom plan:

- Pick registered agent classes that match each custom responsibility, but do not let class names dictate the workflow design.
- Use descriptive ids like `api-contract-map`, `ui-edge-cases`, `db-migration-owner`, or `docs-install-check`.
- Add `dependsOn` only where information must flow; otherwise run independent agents in parallel.
- Include explicit stop conditions such as “return only paths and 5 bullets”, “do not edit files”, or “run this exact test command”.
- Keep the plan small enough that the expected savings exceed the extra workflow cost.

## Settings

Workflow model aliases and extension enablement can be configured with `/workflow-settings` or in `~/.pi/agent/settings.json` / `.pi/settings.json`:

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

Environment fallback is also supported:

```bash
PI_WORKFLOW_FAST_MODEL=openai-codex/codex-5.3-spark
PI_WORKFLOW_DEFAULT_MODEL=anthropic/claude-sonnet-4-5
```
