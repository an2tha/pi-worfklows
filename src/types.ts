import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, TextContent } from "@earendil-works/pi-ai/compat";
import type { TSchema, Static } from "typebox";
import type { WorkflowWriteLock } from "./locks";

export type ModelSelector = string | Model<any>;

export interface WorkflowLimits {
  maxDepth?: number;
  maxAgents?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxOutputChars?: number;
  maxBashOutputChars?: number;
}

export interface WorkflowPlan {
  goal?: string;
  strategy?: "parallel" | "sequential";
  agents: WorkflowAgentSpec[];
  limits?: WorkflowLimits;
  synthesis?: false | WorkflowSynthesisSpec;
}

export interface WorkflowSynthesisSpec {
  enabled?: boolean;
  class?: string;
  task?: string;
  model?: ModelSelector;
}

export interface WorkflowAgentSpec {
  id?: string;
  class: string;
  task: string;
  model?: ModelSelector;
  tools?: string[];
  context?: unknown;
  dependsOn?: string[];
  canSpawn?: boolean;
  availableAgentClasses?: string[];
  timeoutMs?: number;
  maxOutputChars?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentClassDefinition {
  name: string;
  description?: string;
  systemPrompt?: string | ((ctx: AgentPromptContext) => string);
  model?: ModelSelector;
  allowedModels?: string[];
  tools?: string[];
  canSpawn?: boolean;
  allowedChildClasses?: string[];
  maxDepth?: number;
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
  maxTokens?: number;
  resultInstructions?: string;
}

export interface AgentPromptContext {
  runId: string;
  agentId: string;
  parentAgentId?: string;
  depth: number;
  goal?: string;
  task: string;
  agentClass: AgentClassDefinition;
  availableTools: string[];
  canSpawn: boolean;
}

export interface WorkflowToolContext {
  engine: WorkflowEngineLike;
  run: WorkflowRunState;
  agent: WorkflowAgentRuntime;
  signal?: AbortSignal;
  cwd: string;
  send(message: Omit<WorkflowMessage, "id" | "runId" | "createdAt">): WorkflowMessage;
  receive(filter?: WorkflowReceiveFilter): WorkflowMessage[];
  appendBlackboard(entry: Omit<WorkflowBlackboardEntry, "id" | "runId" | "createdAt">): WorkflowBlackboardEntry;
  readBlackboard(filter?: WorkflowBlackboardFilter): WorkflowBlackboardEntry[];
  bash(command: string, options?: WorkflowBashOptions): Promise<WorkflowBashResult>;
  acquireWriteLocks(paths: string[], options?: WorkflowLockOptions): Promise<WorkflowWriteLock[]>;
  getWriteLocks(): WorkflowWriteLock[];
  spawn(plan: WorkflowPlan | string): Promise<WorkflowRunResult>;
}

export interface WorkflowEngineLike {
  runPlan(plan: WorkflowPlan | string, host: WorkflowHostContext, parent?: WorkflowAgentRuntime): Promise<WorkflowRunResult>;
  getRun(runId: string): WorkflowRunState | undefined;
}

export interface WorkflowToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label?: string;
  description: string;
  parameters: TParams;
  executionMode?: "parallel" | "sequential";
  execute(params: Static<TParams>, ctx: WorkflowToolContext): Promise<string | AgentToolResult<TDetails>> | string | AgentToolResult<TDetails>;
}

export interface WorkflowHostContext {
  cwd: string;
  signal?: AbortSignal;
  modelRegistry?: {
    getAll(): Model<any>[];
    getAvailable(): Model<any>[];
    find(provider: string, modelId: string): Model<any> | undefined;
    getApiKeyAndHeaders?(model: Model<any>): Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
      | { ok: false; error: string }
    >;
  };
  currentModel?: Model<any>;
  sessionId?: string;
  workflowSettings?: WorkflowModelSettings;
  inheritedSkillContext?: string;
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number; signal?: AbortSignal }) => Promise<WorkflowBashResult>;
}

export interface WorkflowModelSettings {
  fastModel?: string;
  defaultModel?: string;
}

export interface WorkflowEngineOptions {
  agentClasses?: AgentClassDefinition[];
  tools?: WorkflowToolDefinition[];
  defaultModel?: ModelSelector;
  fastModel?: ModelSelector;
  defaultLimits?: WorkflowLimits;
}

export interface WorkflowAgentRuntime {
  id: string;
  className: string;
  task: string;
  parentAgentId?: string;
  runId: string;
  depth: number;
  model?: Model<any>;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: number;
  completedAt?: number;
  summary?: string;
  error?: string;
  usage?: WorkflowUsage;
  allowedChildClasses?: string[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowRunState {
  id: string;
  goal?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
  parentRunId?: string;
  rootAgentId?: string;
  sessionId?: string;
  agents: Map<string, WorkflowAgentRuntime>;
  messages: WorkflowMessage[];
  blackboard: WorkflowBlackboardEntry[];
  events: WorkflowEvent[];
  usage?: WorkflowUsage;
  result?: WorkflowRunResult;
  error?: string;
}

export interface WorkflowRunResult {
  runId: string;
  status: WorkflowRunState["status"];
  goal?: string;
  results: WorkflowAgentResult[];
  synthesis?: string;
  messages: WorkflowMessage[];
  blackboard: WorkflowBlackboardEntry[];
  events: WorkflowEvent[];
  usage?: WorkflowUsage;
  error?: string;
}

export interface WorkflowAgentResult {
  id: string;
  className: string;
  task: string;
  status: WorkflowAgentRuntime["status"];
  model?: string;
  output?: string;
  error?: string;
  usage?: WorkflowUsage;
  startedAt?: number;
  completedAt?: number;
}

export interface WorkflowUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: number;
}

export interface WorkflowMessage {
  id: string;
  runId: string;
  from: string;
  to?: string;
  channel?: string;
  text: string;
  data?: unknown;
  createdAt: number;
}

export interface WorkflowReceiveFilter {
  to?: string;
  from?: string;
  channel?: string;
  sinceId?: string;
  limit?: number;
  includeBroadcast?: boolean;
}

export interface WorkflowBlackboardEntry {
  id: string;
  runId: string;
  agentId: string;
  kind: string;
  text: string;
  data?: unknown;
  createdAt: number;
}

export interface WorkflowBlackboardFilter {
  kind?: string;
  agentId?: string;
  sinceId?: string;
  limit?: number;
}

export interface WorkflowEvent {
  id: string;
  runId: string;
  agentId?: string;
  type: string;
  message: string;
  data?: unknown;
  createdAt: number;
}

export interface WorkflowLockOptions {
  cwd?: string;
  timeoutMs?: number;
  reason?: string;
}

export interface WorkflowBashOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Paths this command may create, modify, or delete. Read-only commands should omit this. */
  writePaths?: string[];
  /** How long to wait for conflicting write locks before failing. Defaults to failing immediately. */
  lockTimeoutMs?: number;
}

export interface WorkflowBashResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export function defineAgentClass(definition: AgentClassDefinition): AgentClassDefinition {
  return definition;
}

export function defineWorkflowTool<TParams extends TSchema, TDetails = unknown>(
  definition: WorkflowToolDefinition<TParams, TDetails>,
): WorkflowToolDefinition<TParams, TDetails> {
  return definition;
}

export function textResult<TDetails = unknown>(text: string, details?: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text } satisfies TextContent],
    details: details as TDetails,
  };
}
