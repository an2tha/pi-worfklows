import { spawn } from "node:child_process";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import { streamSimple, type Model, type TextContent } from "@earendil-works/pi-ai/compat";
import Type from "typebox";
import {
  appendBlackboard,
  makeId,
  pushEvent,
  readBlackboard,
  receiveMessages,
  sendMessage,
} from "./bus";
import { looksLikeMutatingShellCommand, WorkflowLockManager } from "./locks";
import {
  defineAgentClass,
  defineWorkflowTool,
  textResult,
  type AgentClassDefinition,
  type ModelSelector,
  type WorkflowAgentResult,
  type WorkflowAgentRuntime,
  type WorkflowAgentSpec,
  type WorkflowBashOptions,
  type WorkflowBashResult,
  type WorkflowEngineOptions,
  type WorkflowHostContext,
  type WorkflowLimits,
  type WorkflowPlan,
  type WorkflowRunResult,
  type WorkflowRunState,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
  type WorkflowUsage,
} from "./types";

const DEFAULT_LIMITS: Required<WorkflowLimits> = {
  maxDepth: 3,
  maxAgents: 24,
  concurrency: 4,
  timeoutMs: 10 * 60 * 1000,
  maxOutputChars: 12_000,
  maxBashOutputChars: 16_000,
};

const COMMUNICATION_TOOL_NAMES = ["workflow_send", "workflow_receive", "workflow_blackboard", "workflow_locks"];
const SPAWN_TOOL_NAME = "workflow_spawn";

export class WorkflowEngine {
  private readonly agentClasses = new Map<string, AgentClassDefinition>();
  private readonly tools = new Map<string, WorkflowToolDefinition>();
  private readonly runs = new Map<string, WorkflowRunState>();
  private readonly defaultModel?: ModelSelector;
  private readonly fastModel?: ModelSelector;
  private readonly defaultLimits: Required<WorkflowLimits>;
  private readonly lockManager = new WorkflowLockManager();
  private readonly activeAgents = new Map<string, Agent>();

  constructor(options: WorkflowEngineOptions = {}) {
    this.defaultModel = options.defaultModel;
    this.fastModel = options.fastModel;
    this.defaultLimits = { ...DEFAULT_LIMITS, ...options.defaultLimits };

    for (const agentClass of createDefaultAgentClasses()) {
      this.registerAgentClass(agentClass);
    }
    for (const agentClass of options.agentClasses ?? []) {
      this.registerAgentClass(agentClass);
    }

    for (const tool of createBuiltinWorkflowTools()) {
      this.registerTool(tool);
    }
    for (const tool of options.tools ?? []) {
      this.registerTool(tool);
    }
  }

  registerAgentClass(definition: AgentClassDefinition): void {
    if (!definition.name.trim()) throw new Error("Agent class name cannot be empty");
    this.agentClasses.set(definition.name, definition);
  }

  registerTool(definition: WorkflowToolDefinition): void {
    if (!definition.name.trim()) throw new Error("Tool name cannot be empty");
    this.tools.set(definition.name, definition);
  }

  getAgentClasses(): AgentClassDefinition[] {
    return Array.from(this.agentClasses.values());
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getRun(runId: string): WorkflowRunState | undefined {
    return this.runs.get(runId);
  }

  getRuns(): WorkflowRunState[] {
    return Array.from(this.runs.values());
  }

  getWorkflowUsage(sessionId?: string): WorkflowUsage | undefined {
    const usages = this.getRuns()
      .filter((run) => !sessionId || run.sessionId === sessionId)
      .flatMap((run) => Array.from(run.agents.values()).map((agent) => agent.usage));
    return aggregateUsage(usages);
  }

  getWriteLocks(runId?: string) {
    return this.lockManager.snapshot(runId);
  }

  injectPrompt(runId: string, agentId: string, prompt: string, mode: "steer" | "followUp" = "steer") {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    const agent = this.activeAgents.get(activeAgentKey(runId, agentId));
    if (!agent) throw new Error(`Subagent is not currently active: ${agentId}`);

    const message: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: `[orchestrator injection]\n${prompt}` }],
      timestamp: Date.now(),
    };
    if (mode === "followUp") agent.followUp(message);
    else agent.steer(message);

    sendMessage(run, {
      from: "overseer",
      to: agentId,
      channel: "prompt",
      text: prompt,
      data: { mode },
    });
    pushEvent(run, {
      agentId,
      type: "prompt_injected",
      message: `orchestrator injected ${mode} prompt into ${agentId}`,
      data: { mode },
    });
    return { runId, agentId, mode, prompt };
  }

  async runPlan(planInput: WorkflowPlan | string, host: WorkflowHostContext, parent?: WorkflowAgentRuntime): Promise<WorkflowRunResult> {
    const plan = normalizePlan(planInput);
    const run = parent ? this.runs.get(parent.runId) : this.createRun(plan.goal, host.sessionId);
    if (!run) throw new Error(`Parent run ${parent?.runId} was not found`);

    const baseDepth = parent ? parent.depth + 1 : 0;
    const limits = this.mergeLimits(plan.limits);
    if (baseDepth > limits.maxDepth) {
      throw new Error(`Workflow maxDepth exceeded: ${baseDepth} > ${limits.maxDepth}`);
    }
    if (run.agents.size + plan.agents.length > limits.maxAgents) {
      throw new Error(`Workflow maxAgents exceeded: ${run.agents.size + plan.agents.length} > ${limits.maxAgents}`);
    }

    pushEvent(run, {
      agentId: parent?.id,
      type: parent ? "child_plan_start" : "plan_start",
      message: `${parent ? "child " : ""}plan started with ${plan.agents.length} agent(s)`,
      data: { goal: plan.goal, strategy: plan.strategy ?? "parallel" },
    });

    try {
      const results = await this.executeAgentSpecs(run, plan, host, parent, baseDepth, limits);
      let synthesis: string | undefined;
      if (!host.signal?.aborted && plan.synthesis && plan.synthesis.enabled !== false) {
        synthesis = await this.synthesize(run, plan, host, parent, baseDepth, limits, results);
      }

      const usage = aggregateUsage(results.map((item) => item.usage));
      run.usage = usage;
      const result: WorkflowRunResult = {
        runId: run.id,
        status: run.status,
        goal: plan.goal ?? run.goal,
        results,
        synthesis,
        messages: run.messages.slice(),
        blackboard: run.blackboard.slice(),
        events: run.events.slice(),
        usage,
      };

      if (!parent) {
        run.status = host.signal?.aborted ? "cancelled" : results.some((item) => item.status === "failed") ? "failed" : "completed";
        run.completedAt = Date.now();
        this.lockManager.releaseRun(run);
        result.status = run.status;
        result.events = run.events.slice();
        run.result = result;
      }

      pushEvent(run, {
        agentId: parent?.id,
        type: parent ? "child_plan_end" : "plan_end",
        message: `${parent ? "child " : ""}plan completed`,
        data: { status: result.status, resultCount: results.length },
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!parent) {
        run.status = host.signal?.aborted ? "cancelled" : "failed";
        run.completedAt = Date.now();
        run.error = message;
        this.lockManager.releaseRun(run);
      }
      pushEvent(run, {
        agentId: parent?.id,
        type: parent ? "child_plan_error" : "plan_error",
        message,
      });
      const result: WorkflowRunResult = {
        runId: run.id,
        status: run.status,
        goal: plan.goal ?? run.goal,
        results: [],
        messages: run.messages.slice(),
        blackboard: run.blackboard.slice(),
        events: run.events.slice(),
        error: message,
      };
      if (!parent) run.result = result;
      return result;
    }
  }

  private createRun(goal?: string, sessionId?: string): WorkflowRunState {
    const run: WorkflowRunState = {
      id: makeId("run"),
      goal,
      status: "running",
      createdAt: Date.now(),
      sessionId,
      agents: new Map(),
      messages: [],
      blackboard: [],
      events: [],
    };
    this.runs.set(run.id, run);
    return run;
  }

  private mergeLimits(overrides?: WorkflowLimits): Required<WorkflowLimits> {
    return { ...this.defaultLimits, ...overrides };
  }

  private async executeAgentSpecs(
    run: WorkflowRunState,
    plan: WorkflowPlan,
    host: WorkflowHostContext,
    parent: WorkflowAgentRuntime | undefined,
    depth: number,
    limits: Required<WorkflowLimits>,
  ): Promise<WorkflowAgentResult[]> {
    const specs = normalizeAgentIds(plan.agents, new Set(run.agents.keys()));
    const byId = new Map(specs.map((spec) => [spec.id!, spec]));
    for (const spec of specs) {
      const missing = (spec.dependsOn ?? []).filter((dep) => !byId.has(dep));
      if (missing.length) throw new Error(`Agent ${spec.id} depends on unknown agent(s): ${missing.join(", ")}`);
    }
    const completed = new Map<string, WorkflowAgentResult>();
    const running = new Map<string, Promise<{ id: string; result: WorkflowAgentResult }>>();
    const started = new Set<string>();
    const concurrency = plan.strategy === "sequential" ? 1 : Math.max(1, limits.concurrency);

    while (completed.size < specs.length) {
      if (host.signal?.aborted) {
        pushEvent(run, {
          agentId: parent?.id,
          type: "workflow_abort",
          message: "Workflow abort signal received; cancelling remaining subagents",
        });
        const settledRunning = await Promise.allSettled(running.values());
        for (const settled of settledRunning) {
          if (settled.status === "fulfilled") completed.set(settled.value.id, settled.value.result);
        }
        running.clear();
        for (const spec of specs) {
          if (!completed.has(spec.id!)) completed.set(spec.id!, cancelledAgentResult(spec, "Workflow aborted"));
        }
        break;
      }

      for (const spec of specs) {
        if (started.has(spec.id!)) continue;
        if (host.signal?.aborted) break;
        if (running.size >= concurrency) break;
        const dependencies = spec.dependsOn ?? [];
        const depsReady = dependencies.every((dep) => completed.has(dep));
        if (!depsReady) continue;
        started.add(spec.id!);
        const task = this.runSingleAgent(run, plan, spec, host, parent, depth, limits).then((result) => ({ id: spec.id!, result }));
        running.set(spec.id!, task);
      }

      if (running.size === 0) {
        const waiting = specs.filter((spec) => !completed.has(spec.id!) && !started.has(spec.id!)).map((spec) => spec.id).join(", ");
        throw new Error(`Workflow dependency deadlock; waiting on: ${waiting}`);
      }

      const settled = await Promise.race(running.values());
      running.delete(settled.id);
      completed.set(settled.id, settled.result);
    }

    return specs.map((spec) => completed.get(spec.id!)!).filter(Boolean);
  }

  private async runSingleAgent(
    run: WorkflowRunState,
    plan: WorkflowPlan,
    spec: WorkflowAgentSpec,
    host: WorkflowHostContext,
    parent: WorkflowAgentRuntime | undefined,
    depth: number,
    limits: Required<WorkflowLimits>,
  ): Promise<WorkflowAgentResult> {
    const agentClass = this.agentClasses.get(spec.class);
    if (!agentClass) {
      return failedAgentResult(spec, `Unknown agent class: ${spec.class}`);
    }
    if (parent) this.assertParentCanSpawn(parent, spec.class);
    if (depth > (agentClass.maxDepth ?? limits.maxDepth)) {
      return failedAgentResult(spec, `Agent class ${agentClass.name} maxDepth exceeded at depth ${depth}`);
    }

    const runtime: WorkflowAgentRuntime = {
      id: spec.id!,
      className: spec.class,
      task: spec.task,
      parentAgentId: parent?.id,
      runId: run.id,
      depth,
      status: "pending",
      allowedChildClasses: spec.availableAgentClasses ?? agentClass.allowedChildClasses,
      metadata: spec.metadata,
    };
    run.agents.set(runtime.id, runtime);
    if (!run.rootAgentId && !parent) run.rootAgentId = runtime.id;

    try {
      const modelSelector = enforcedModelSelector(agentClass.name, spec.model ?? agentClass.model ?? "@default");
      const model = this.resolveModel(modelSelector, host);
      if (!model) throw new Error(`No model available for agent ${runtime.id}`);
      this.assertModelAllowed(agentClass, model);
      runtime.model = model;

      const canSpawn = (agentClass.canSpawn ?? false) && (spec.canSpawn ?? true);
      const toolNames = this.resolveToolNames(agentClass, spec, canSpawn);
      const tools = this.buildAgentTools(toolNames, run, runtime, host, canSpawn);
      const systemPrompt = this.buildSystemPrompt(run, plan, spec, agentClass, runtime, toolNames, canSpawn, host);
      const outputLimit = spec.maxOutputChars ?? limits.maxOutputChars;
      const prompt = buildTaskPrompt(plan, spec, runtime, outputLimit);

      runtime.status = "running";
      runtime.startedAt = Date.now();
      pushEvent(run, {
        agentId: runtime.id,
        type: "agent_start",
        message: `${runtime.id} (${spec.class}) started on ${model.provider}/${model.id}`,
      });

      const usage: WorkflowUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
      runtime.usage = usage;
      const agent = new Agent({
        initialState: {
          systemPrompt,
          model,
          thinkingLevel: agentClass.thinkingLevel ?? "off",
          tools,
        },
        streamFn: async (requestModel, context, options) => {
          const auth = await host.modelRegistry?.getApiKeyAndHeaders?.(requestModel);
          if (auth && !auth.ok) throw new Error(auth.error);
          return streamSimple(requestModel, context, {
            ...options,
            apiKey: auth?.ok ? auth.apiKey : options?.apiKey,
            headers: auth?.ok ? { ...options?.headers, ...auth.headers } : options?.headers,
            env: auth?.ok ? { ...options?.env, ...auth.env } : options?.env,
            maxTokens: agentClass.maxTokens ?? options?.maxTokens,
            temperature: agentClass.temperature ?? options?.temperature,
          });
        },
        toolExecution: "parallel",
      });

      const abortListener = () => agent.abort();
      host.signal?.addEventListener("abort", abortListener, { once: true });
      agent.subscribe((event) => this.handleAgentEvent(run, runtime, event, usage));
      this.activeAgents.set(activeAgentKey(run.id, runtime.id), agent);

      try {
        await withTimeout(agent.prompt(prompt), spec.timeoutMs ?? limits.timeoutMs, () => agent.abort(), host.signal);
      } finally {
        this.activeAgents.delete(activeAgentKey(run.id, runtime.id));
        host.signal?.removeEventListener("abort", abortListener);
      }

      const output = limitText(extractLastAssistantText(agent.state.messages), outputLimit);
      runtime.status = "completed";
      runtime.completedAt = Date.now();
      runtime.summary = output;
      appendBlackboard(run, {
        agentId: runtime.id,
        kind: "agent_result",
        text: output,
        data: { className: runtime.className, task: runtime.task },
      });
      pushEvent(run, {
        agentId: runtime.id,
        type: "agent_end",
        message: `${runtime.id} completed`,
      });

      return {
        id: runtime.id,
        className: runtime.className,
        task: runtime.task,
        status: runtime.status,
        model: `${model.provider}/${model.id}`,
        output,
        usage,
        startedAt: runtime.startedAt,
        completedAt: runtime.completedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.status = host.signal?.aborted ? "cancelled" : "failed";
      runtime.error = message;
      runtime.completedAt = Date.now();
      pushEvent(run, {
        agentId: runtime.id,
        type: "agent_error",
        message,
      });
      return {
        id: runtime.id,
        className: runtime.className,
        task: runtime.task,
        status: runtime.status,
        model: runtime.model ? `${runtime.model.provider}/${runtime.model.id}` : undefined,
        error: message,
        startedAt: runtime.startedAt,
        completedAt: runtime.completedAt,
      };
    }
  }

  private async synthesize(
    run: WorkflowRunState,
    plan: WorkflowPlan,
    host: WorkflowHostContext,
    parent: WorkflowAgentRuntime | undefined,
    depth: number,
    limits: Required<WorkflowLimits>,
    results: WorkflowAgentResult[],
  ): Promise<string | undefined> {
    const synthesis = plan.synthesis || undefined;
    const task = synthesis?.task ?? "Synthesize the subagent results into a concise final answer.";
    const spec: WorkflowAgentSpec = {
      id: makeId("synth"),
      class: synthesis?.class ?? "synthesizer",
      task,
      model: synthesis?.model,
      context: { results },
      canSpawn: false,
    };
    const result = await this.runSingleAgent(run, plan, spec, host, parent, depth, limits);
    return result.output;
  }

  private assertParentCanSpawn(parent: WorkflowAgentRuntime, childClass: string): void {
    const parentClass = this.agentClasses.get(parent.className);
    if (!parentClass?.canSpawn) {
      throw new Error(`Agent ${parent.id} (${parent.className}) is not allowed to spawn child agents`);
    }
    const allowedChildClasses = parent.allowedChildClasses ?? parentClass.allowedChildClasses;
    if (allowedChildClasses?.length && !allowedChildClasses.includes(childClass)) {
      throw new Error(`Agent ${parent.id} is not allowed to spawn child class ${childClass}`);
    }
  }

  private assertModelAllowed(agentClass: AgentClassDefinition, model: Model<any>): void {
    if (!agentClass.allowedModels?.length) return;
    const selected = `${model.provider}/${model.id}`;
    if (!agentClass.allowedModels.some((allowed) => modelMatches(allowed, model) || allowed === selected)) {
      throw new Error(`Model ${selected} is not allowed for agent class ${agentClass.name}`);
    }
  }

  private resolveModel(selector: ModelSelector | undefined, host: WorkflowHostContext): Model<any> | undefined {
    if (selector && typeof selector !== "string") return selector;

    const expanded = this.expandModelSelector(selector, host);
    if (expanded && typeof expanded !== "string") return expanded;
    const requested = expanded && expanded !== "@current" ? expanded : undefined;
    if (!requested) return host.currentModel ?? host.modelRegistry?.getAvailable()[0] ?? host.modelRegistry?.getAll()[0];

    const registry = host.modelRegistry;
    if (!registry) return host.currentModel;

    const separator = requested.includes("/") ? "/" : requested.includes(":") ? ":" : undefined;
    const parts = separator ? requested.split(separator) : undefined;
    if (parts && parts.length >= 2) {
      const [provider, ...rest] = parts;
      const modelId = rest.join(separator);
      const found = registry.find(provider!, modelId);
      if (found) return found;
    }

    const candidates = registry.getAvailable().length ? registry.getAvailable() : registry.getAll();
    return (
      candidates.find((model) => modelMatches(requested, model)) ??
      candidates.find((model) => model.id.includes(requested) || model.name.toLowerCase().includes(requested.toLowerCase())) ??
      host.currentModel
    );
  }

  private expandModelSelector(selector: string | undefined, host: WorkflowHostContext): ModelSelector | undefined {
    if (selector === "@fast") return this.fastModel ?? host.workflowSettings?.fastModel ?? process.env.PI_WORKFLOW_FAST_MODEL;
    if (selector === "@default") return this.defaultModel ?? host.workflowSettings?.defaultModel ?? process.env.PI_WORKFLOW_DEFAULT_MODEL;
    return selector;
  }

  private resolveToolNames(agentClass: AgentClassDefinition, spec: WorkflowAgentSpec, canSpawn: boolean): string[] {
    const mandatory = ["bash", ...COMMUNICATION_TOOL_NAMES];
    const requested = spec.tools ?? agentClass.tools ?? ["bash"];
    const expanded = requested.includes("*") ? Array.from(this.tools.keys()) : requested;
    const names = new Set([...mandatory, ...expanded]);
    if (canSpawn) names.add(SPAWN_TOOL_NAME);
    else names.delete(SPAWN_TOOL_NAME);
    return Array.from(names).filter((name) => this.tools.has(name));
  }

  private buildAgentTools(
    names: string[],
    run: WorkflowRunState,
    runtime: WorkflowAgentRuntime,
    host: WorkflowHostContext,
    canSpawn: boolean,
  ): AgentTool[] {
    return names.map((name) => {
      const tool = this.tools.get(name)!;
      const agentTool: AgentTool = {
        name: tool.name,
        label: tool.label ?? tool.name,
        description: tool.description,
        parameters: tool.parameters,
        executionMode: tool.executionMode,
        execute: async (_toolCallId, params, signal): Promise<AgentToolResult<unknown>> => {
          if (tool.name === SPAWN_TOOL_NAME && !canSpawn) {
            throw new Error(`Agent ${runtime.id} is not allowed to spawn child agents`);
          }
          const context = this.createToolContext(run, runtime, host, signal);
          const result = await tool.execute(params as never, context);
          return typeof result === "string" ? textResult(result, { tool: name }) : result;
        },
      };
      return agentTool;
    });
  }

  private createToolContext(
    run: WorkflowRunState,
    runtime: WorkflowAgentRuntime,
    host: WorkflowHostContext,
    signal?: AbortSignal,
  ): WorkflowToolContext {
    return {
      engine: this,
      run,
      agent: runtime,
      signal,
      cwd: host.cwd,
      send: (message) => sendMessage(run, message),
      receive: (filter) => receiveMessages(run, filter),
      appendBlackboard: (entry) => appendBlackboard(run, entry),
      readBlackboard: (filter) => readBlackboard(run, filter),
      bash: (command, options) => this.executeBash(command, host, runtime, signal, options),
      acquireWriteLocks: (paths, options) => this.acquireWriteLocks(run, runtime, options?.cwd ?? host.cwd, paths, options?.timeoutMs, options?.reason),
      getWriteLocks: () => this.lockManager.snapshot(run.id),
      spawn: (plan) => this.runPlan(plan, { ...host, signal }, runtime),
    };
  }

  private async executeBash(
    command: string,
    host: WorkflowHostContext,
    runtime: WorkflowAgentRuntime,
    signal?: AbortSignal,
    options: WorkflowBashOptions = {},
  ): Promise<WorkflowBashResult> {
    const timeout = options.timeoutMs ?? this.defaultLimits.timeoutMs;
    const cwd = options.cwd ?? host.cwd;
    const writePaths = options.writePaths ?? [];
    if (writePaths.length === 0 && looksLikeMutatingShellCommand(command)) {
      throw new Error(
        "This bash command looks like it may write files. Re-run with writePaths listing every file/directory it may create, modify, or delete so workflow write locks can protect other subagents.",
      );
    }
    if (writePaths.length > 0) {
      await this.acquireWriteLocks(
        this.runs.get(runtime.runId)!,
        runtime,
        cwd,
        writePaths,
        options.lockTimeoutMs,
        `bash: ${command.slice(0, 160)}`,
      );
    }
    const result = host.exec
      ? await host.exec("bash", ["-lc", command], { cwd, timeout, signal })
      : await execWithNode(command, cwd, timeout, signal);
    const max = options.maxOutputChars ?? this.defaultLimits.maxBashOutputChars;
    return {
      ...result,
      stdout: limitText(result.stdout, max),
      stderr: limitText(result.stderr, max),
    };
  }

  private async acquireWriteLocks(
    run: WorkflowRunState,
    runtime: WorkflowAgentRuntime,
    cwd: string,
    paths: string[],
    timeoutMs?: number,
    reason?: string,
  ) {
    return this.lockManager.acquire({
      cwd,
      runId: run.id,
      agentId: runtime.id,
      paths,
      timeoutMs,
      reason,
      onEvent: (event) => pushEvent(run, event),
    });
  }

  private buildSystemPrompt(
    run: WorkflowRunState,
    plan: WorkflowPlan,
    spec: WorkflowAgentSpec,
    agentClass: AgentClassDefinition,
    runtime: WorkflowAgentRuntime,
    toolNames: string[],
    canSpawn: boolean,
    host: WorkflowHostContext,
  ): string {
    const custom = typeof agentClass.systemPrompt === "function"
      ? agentClass.systemPrompt({
          runId: run.id,
          agentId: runtime.id,
          parentAgentId: runtime.parentAgentId,
          depth: runtime.depth,
          goal: plan.goal,
          task: spec.task,
          agentClass,
          availableTools: toolNames,
          canSpawn,
        })
      : agentClass.systemPrompt;

    return [
      "You are a pi workflow subagent. Be fast, focused, and concise.",
      `Run id: ${run.id}`,
      `Agent id: ${runtime.id}`,
      `Class: ${agentClass.name}${agentClass.description ? ` - ${agentClass.description}` : ""}`,
      runtime.parentAgentId ? `Parent agent: ${runtime.parentAgentId}` : undefined,
      plan.goal ? `Workflow goal: ${plan.goal}` : undefined,
      custom,
      host.inheritedSkillContext ? `Inherited root skill context:\n${host.inheritedSkillContext}` : undefined,
      "",
      "Operational rules:",
      "- Prefer short outputs and actionable findings to long transcripts.",
      "- Model policy is strict: inspection/research/review/test agents use @fast; generation/implementation/synthesis agents use @default/heavy.",
      "- Use bash when you need repository or environment facts; do not guess.",
      "- Read-only bash commands need no lock and should omit writePaths.",
      "- Any bash command that creates/modifies/deletes files must declare exact writePaths so the engine can claim global write locks.",
      "- If a write lock conflict occurs, stop and ask the orchestrator to coordinate instead of working around it.",
      "- Prefer small, non-overlapping file ownership. Do not edit files owned by another subagent.",
      "- If inherited skill instructions mention unavailable tools, use available equivalents such as bash for file reads.",
      "- Communicate through workflow_send/workflow_receive when coordination helps.",
      "- Put durable findings in workflow_blackboard so other agents can read summaries instead of full chat.",
      canSpawn ? "- You may call workflow_spawn for focused child agents if it saves time or cost." : "- You may not spawn child agents.",
      canSpawn && runtime.allowedChildClasses?.length ? `- Allowed child classes: ${runtime.allowedChildClasses.join(", ")}.` : undefined,
      "- Final answer format: SUMMARY, FINDINGS, ARTIFACTS, NEXT. Keep each section brief.",
      agentClass.resultInstructions,
    ].filter(Boolean).join("\n");
  }

  private handleAgentEvent(run: WorkflowRunState, runtime: WorkflowAgentRuntime, event: AgentEvent, usage: WorkflowUsage): void {
    if (event.type === "tool_execution_start") {
      pushEvent(run, {
        agentId: runtime.id,
        type: "tool_start",
        message: `${event.toolName} started`,
        data: { toolCallId: event.toolCallId, args: event.args },
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      pushEvent(run, {
        agentId: runtime.id,
        type: event.isError ? "tool_error" : "tool_end",
        message: `${event.toolName} ${event.isError ? "failed" : "completed"}`,
        data: { toolCallId: event.toolCallId },
      });
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const item = event.message.usage;
      usage.input += item.input;
      usage.output += item.output;
      usage.cacheRead += item.cacheRead;
      usage.cacheWrite += item.cacheWrite;
      usage.totalTokens += item.totalTokens;
      usage.cost = (usage.cost ?? 0) + item.cost.total;
      runtime.usage = usage;
    }
  }
}

export function createDefaultAgentClasses(): AgentClassDefinition[] {
  return [
    defineAgentClass({
      name: "generalist",
      description: "General-purpose worker for mixed tasks.",
      tools: ["bash"],
      canSpawn: false,
    }),
    defineAgentClass({
      name: "researcher",
      description: "Fast codebase or environment researcher. Optimized for cheap, concise summaries.",
      model: "@fast",
      tools: ["bash"],
      canSpawn: false,
      resultInstructions: "Focus on facts, file paths, commands run, and uncertainties.",
    }),
    defineAgentClass({
      name: "coder",
      description: "Implementation worker. Can delegate review/testing work.",
      tools: ["bash"],
      canSpawn: true,
      allowedChildClasses: ["researcher", "reviewer", "tester"],
      resultInstructions: "Report changed files, tests run, and any remaining risks.",
    }),
    defineAgentClass({
      name: "reviewer",
      description: "Critical reviewer for correctness, safety, and regressions.",
      model: "@fast",
      tools: ["bash"],
      canSpawn: false,
      resultInstructions: "Return prioritized findings with evidence. Avoid nitpicks.",
    }),
    defineAgentClass({
      name: "tester",
      description: "Runs focused tests, repros, and validation commands.",
      model: "@fast",
      tools: ["bash"],
      canSpawn: false,
      resultInstructions: "Include exact commands, pass/fail, and relevant output snippets.",
    }),
    defineAgentClass({
      name: "synthesizer",
      description: "Combines subagent results into a compact final answer.",
      model: "@fast",
      tools: ["workflow_receive", "workflow_blackboard"],
      canSpawn: false,
      resultInstructions: "Do not add new claims beyond the supplied results or blackboard.",
    }),
  ];
}

function createBuiltinWorkflowTools(): WorkflowToolDefinition[] {
  const BashParams = Type.Object({
    command: Type.String({ description: "Shell command to run through bash -lc." }),
    cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the workflow cwd." })),
    timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds." })),
    maxOutputChars: Type.Optional(Type.Number({ description: "Output truncation limit." })),
    writePaths: Type.Optional(Type.Array(Type.String(), {
      description: "Files or directories this command may create, modify, or delete. Required for mutating commands; omit for read-only commands.",
    })),
    lockTimeoutMs: Type.Optional(Type.Number({ description: "How long to wait for conflicting write locks before failing." })),
  });

  const SendParams = Type.Object({
    to: Type.Optional(Type.String({ description: "Target agent id. Omit to broadcast." })),
    channel: Type.Optional(Type.String({ description: "Logical channel name." })),
    text: Type.String({ description: "Message text." }),
    data: Type.Optional(Type.Any({ description: "Optional structured payload." })),
  });

  const ReceiveParams = Type.Object({
    from: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    sinceId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
    includeBroadcast: Type.Optional(Type.Boolean()),
  });

  const BlackboardParams = Type.Object({
    action: Type.Union([Type.Literal("append"), Type.Literal("read")]),
    kind: Type.Optional(Type.String({ description: "Entry kind, e.g. finding, artifact, decision." })),
    text: Type.Optional(Type.String({ description: "Text to append when action is append." })),
    data: Type.Optional(Type.Any()),
    agentId: Type.Optional(Type.String({ description: "Filter by author when reading." })),
    sinceId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
  });

  const LockParams = Type.Object({
    action: Type.Union([Type.Literal("status"), Type.Literal("claim")]),
    paths: Type.Optional(Type.Array(Type.String(), { description: "Paths to claim when action is claim." })),
    reason: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  });

  const SpawnParams = Type.Object({
    planJson: Type.String({ description: "WorkflowPlan JSON string. Child agents share this run's message bus." }),
  });

  return [
    defineWorkflowTool({
      name: "bash",
      label: "Bash",
      description: "Execute a bash command. Always available. Read-only commands run freely; mutating commands must declare writePaths to claim global write locks.",
      parameters: BashParams,
      executionMode: "parallel",
      async execute(params, ctx) {
        const result = await ctx.bash(params.command, {
          cwd: params.cwd,
          timeoutMs: params.timeoutMs,
          maxOutputChars: params.maxOutputChars,
          writePaths: params.writePaths,
          lockTimeoutMs: params.lockTimeoutMs,
        });
        return textResult(formatBashResult(result), result);
      },
    }),
    defineWorkflowTool({
      name: "workflow_send",
      label: "Send workflow message",
      description: "Send a short message to another agent, a channel, or the whole workflow.",
      parameters: SendParams,
      executionMode: "parallel",
      execute(params, ctx) {
        const message = ctx.send({
          from: ctx.agent.id,
          to: params.to,
          channel: params.channel,
          text: params.text,
          data: params.data,
        });
        return textResult(`sent ${message.id}`, message);
      },
    }),
    defineWorkflowTool({
      name: "workflow_receive",
      label: "Receive workflow messages",
      description: "Read messages from the workflow bus. Use sinceId to poll incrementally.",
      parameters: ReceiveParams,
      executionMode: "parallel",
      execute(params, ctx) {
        const messages = ctx.receive({
          from: params.from,
          to: params.to ?? ctx.agent.id,
          channel: params.channel,
          sinceId: params.sinceId,
          limit: params.limit ?? 20,
          includeBroadcast: params.includeBroadcast,
        });
        return textResult(JSON.stringify(messages, null, 2), { messages });
      },
    }),
    defineWorkflowTool({
      name: "workflow_blackboard",
      label: "Workflow blackboard",
      description: "Append durable findings or read shared workflow notes/artifacts.",
      parameters: BlackboardParams,
      executionMode: "parallel",
      execute(params, ctx) {
        if (params.action === "append") {
          if (!params.text) throw new Error("workflow_blackboard append requires text");
          const entry = ctx.appendBlackboard({
            agentId: ctx.agent.id,
            kind: params.kind ?? "note",
            text: params.text,
            data: params.data,
          });
          return textResult<unknown>(`appended ${entry.id}`, entry);
        }
        const entries = ctx.readBlackboard({
          kind: params.kind,
          agentId: params.agentId,
          sinceId: params.sinceId,
          limit: params.limit ?? 20,
        });
        return textResult<unknown>(JSON.stringify(entries, null, 2), { entries });
      },
    }),
    defineWorkflowTool({
      name: "workflow_locks",
      label: "Workflow write locks",
      description: "Inspect or explicitly claim global write locks. Read access never needs a lock; writes should claim exact files first.",
      parameters: LockParams,
      executionMode: "sequential",
      async execute(params, ctx) {
        if (params.action === "claim") {
          const paths = params.paths ?? [];
          if (paths.length === 0) throw new Error("workflow_locks claim requires paths");
          const locks = await ctx.acquireWriteLocks(paths, { timeoutMs: params.timeoutMs, reason: params.reason });
          return textResult(JSON.stringify(locks, null, 2), { locks });
        }
        const locks = ctx.getWriteLocks();
        return textResult(JSON.stringify(locks, null, 2), { locks });
      },
    }),
    defineWorkflowTool({
      name: SPAWN_TOOL_NAME,
      label: "Spawn child workflow agents",
      description: "Spawn focused child agents from a WorkflowPlan JSON string. Use sparingly when delegation saves time or tokens.",
      parameters: SpawnParams,
      executionMode: "sequential",
      async execute(params, ctx) {
        const result = await ctx.spawn(params.planJson);
        return textResult(JSON.stringify(compactRunResult(result), null, 2), result);
      },
    }),
  ];
}

function normalizePlan(input: WorkflowPlan | string): WorkflowPlan {
  const value = typeof input === "string" ? JSON.parse(stripJsonFence(input)) : input;
  if (!value || typeof value !== "object") throw new Error("Workflow plan must be an object");
  const plan = value as WorkflowPlan;
  if (!Array.isArray(plan.agents) || plan.agents.length === 0) {
    throw new Error("Workflow plan requires a non-empty agents array");
  }
  for (const agent of plan.agents) {
    if (!agent || typeof agent !== "object") throw new Error("Each agent spec must be an object");
    if (!agent.class || typeof agent.class !== "string") throw new Error("Each agent spec requires a class string");
    if (!agent.task || typeof agent.task !== "string") throw new Error("Each agent spec requires a task string");
  }
  return { ...plan, strategy: plan.strategy ?? "parallel" };
}

function normalizeAgentIds(specs: WorkflowAgentSpec[], existing = new Set<string>()): WorkflowAgentSpec[] {
  const seen = new Set<string>();
  return specs.map((spec, index) => {
    const explicitId = spec.id?.trim();
    const id = explicitId || `${spec.class}_${index + 1}`;
    if (explicitId && existing.has(explicitId)) throw new Error(`Agent id already exists in this run: ${explicitId}`);
    let unique = id;
    let suffix = 2;
    while (seen.has(unique) || existing.has(unique)) unique = `${id}_${suffix++}`;
    seen.add(unique);
    return { ...spec, id: unique };
  });
}

function stripJsonFence(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function activeAgentKey(runId: string, agentId: string): string {
  return `${runId}:${agentId}`;
}

function enforcedModelSelector(className: string, requested: ModelSelector): ModelSelector {
  if (typeof requested !== "string") return requested;
  if (className === "researcher" || className === "reviewer" || className === "tester") return "@fast";
  if (className === "coder" || className === "synthesizer" || className === "generalist") return "@default";
  return requested;
}

function failedAgentResult(spec: WorkflowAgentSpec, error: string): WorkflowAgentResult {
  return {
    id: spec.id ?? makeId("agent"),
    className: spec.class,
    task: spec.task,
    status: "failed",
    error,
  };
}

function cancelledAgentResult(spec: WorkflowAgentSpec, error: string): WorkflowAgentResult {
  return {
    id: spec.id ?? makeId("agent"),
    className: spec.class,
    task: spec.task,
    status: "cancelled",
    error,
  };
}

function modelMatches(selector: string, model: Model<any>): boolean {
  const lower = selector.toLowerCase();
  return (
    model.id.toLowerCase() === lower ||
    model.name.toLowerCase() === lower ||
    model.provider.toLowerCase() === lower ||
    `${model.provider}/${model.id}`.toLowerCase() === lower ||
    `${model.provider}:${model.id}`.toLowerCase() === lower
  );
}

function aggregateUsage(usages: Array<WorkflowUsage | undefined>): WorkflowUsage | undefined {
  const present = usages.filter((usage): usage is WorkflowUsage => Boolean(usage));
  if (present.length === 0) return undefined;
  return present.reduce<WorkflowUsage>(
    (total, usage) => ({
      input: total.input + usage.input,
      output: total.output + usage.output,
      cacheRead: total.cacheRead + usage.cacheRead,
      cacheWrite: total.cacheWrite + usage.cacheWrite,
      totalTokens: total.totalTokens + usage.totalTokens,
      cost: (total.cost ?? 0) + (usage.cost ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  );
}

function buildTaskPrompt(plan: WorkflowPlan, spec: WorkflowAgentSpec, runtime: WorkflowAgentRuntime, outputLimit: number): string {
  return [
    `Task for ${runtime.id}: ${spec.task}`,
    plan.goal ? `Overall workflow goal: ${plan.goal}` : undefined,
    spec.context === undefined ? undefined : `Context JSON:\n${limitText(JSON.stringify(spec.context, null, 2), outputLimit)}`,
    `Keep final output under about ${outputLimit} characters.`,
  ].filter(Boolean).join("\n\n");
}

function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return message.content
      .filter((content): content is TextContent => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();
  }
  return "";
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.max(0, Math.floor((maxChars - 80) / 2));
  return `${text.slice(0, half)}\n\n…[truncated ${text.length - maxChars} chars]…\n\n${text.slice(-half)}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void, signal?: AbortSignal): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (signal) {
      abortHandler = () => {
        onTimeout();
        reject(new Error("Aborted"));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

async function execWithNode(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<WorkflowBashResult> {
  return await new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let killed = false;

    const kill = () => {
      killed = true;
      child.kill("SIGTERM");
    };
    const timeout = setTimeout(kill, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", kill);
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: `${Buffer.concat(stderr).toString("utf8")}${error.message}`, code: 1, killed });
    });
    child.on("close", (code, signalName) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", kill);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? (signalName ? 128 : 1),
        killed,
      });
    });
  });
}

function formatBashResult(result: WorkflowBashResult): string {
  return [
    `exit code: ${result.code}${result.killed ? " (killed)" : ""}`,
    result.stdout ? `stdout:\n${result.stdout}` : undefined,
    result.stderr ? `stderr:\n${result.stderr}` : undefined,
  ].filter(Boolean).join("\n\n");
}

function compactRunResult(result: WorkflowRunResult): unknown {
  return {
    runId: result.runId,
    status: result.status,
    results: result.results.map((item) => ({
      id: item.id,
      className: item.className,
      status: item.status,
      output: item.output,
      error: item.error,
      usage: item.usage,
    })),
    synthesis: result.synthesis,
    blackboard: result.blackboard.slice(-20),
  };
}
