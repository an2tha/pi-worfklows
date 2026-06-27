import type { WorkflowAgentRuntime, WorkflowMessage, WorkflowRunState, WorkflowUsage } from "./types";

export interface WorkflowTreeRenderOptions {
  includeOutputs?: boolean;
  includeEvents?: boolean;
  maxOutputChars?: number;
  maxEvents?: number;
  now?: number;
}

const WIDTH = 104;

export function renderWorkflowTree(run: WorkflowRunState | undefined, options: WorkflowTreeRenderOptions = {}): string {
  if (!run) {
    return box("PI WORKFLOW", [
      "⏳ Starting workflow…",
      "Press Esc to abort the workflow and all subagents.",
    ]);
  }

  const now = options.now ?? Date.now();
  const agents = Array.from(run.agents.values()).sort(compareAgents);
  const children = groupChildren(agents);
  const usage = aggregateRuntimeUsage(agents) ?? run.usage;
  const lines = [
    ...boxLines(`PI WORKFLOW ${statusIcon(run.status)} ${run.status.toUpperCase()}`, [
      `run: ${run.id}${durationSuffix(run.createdAt, run.completedAt, now)}`,
      run.goal ? `goal: ${run.goal}` : undefined,
      `agents: ${countByStatus(agents)}  │  bus: ${run.messages.length} msg  │  notes: ${run.blackboard.length}  │  events: ${run.events.length}`,
      usage ? `usage: ${formatUsage(usage)}` : "usage: waiting for model responses",
      run.status === "running" ? "Esc aborts the workflow; use workflow_inspect_agent or workflow_prompt for targeted control." : undefined,
    ].filter((line): line is string => Boolean(line))),
    "",
    sectionTitle("AGENT GRAPH"),
  ];

  if (agents.length === 0) {
    lines.push("└─ ⏳ waiting for agents to start");
  } else {
    renderAgentList(lines, children, undefined, "", options, now);
  }

  const active = agents.filter((agent) => agent.status === "running" || agent.status === "pending");
  if (active.length > 0) {
    lines.push("", sectionTitle("ACTIVE CONTROL"));
    for (const agent of active) {
      lines.push(`• inspect ${agent.id}: workflow_inspect_agent {"runId":"${run.id}","agentId":"${agent.id}"}`);
      if (agent.status === "running") {
        lines.push(`  prompt  ${agent.id}: workflow_prompt {"runId":"${run.id}","agentId":"${agent.id}","prompt":"..."}`);
      }
    }
  }

  if (options.includeEvents ?? true) {
    const events = run.events.slice(-(options.maxEvents ?? 10));
    if (events.length > 0) {
      lines.push("", sectionTitle("RECENT EVENTS"));
      for (const event of events) {
        lines.push(`• ${event.agentId ? `${event.agentId} › ` : ""}${event.type}: ${oneLine(event.message, 150)}`);
      }
    }
  }

  return lines.join("\n");
}

export function renderAgentInspection(
  run: WorkflowRunState | undefined,
  agentId: string,
  options: { includeMessages?: boolean; includeBlackboard?: boolean; includeEvents?: boolean; maxItems?: number } = {},
): string {
  if (!run) return box("SUBAGENT INSPECTION", [`Workflow run not found.`, `agent: ${agentId}`]);
  const agent = run.agents.get(agentId);
  if (!agent) return box("SUBAGENT INSPECTION", [`Agent not found: ${agentId}`, `run: ${run.id}`]);

  const childAgents = Array.from(run.agents.values()).filter((candidate) => candidate.parentAgentId === agent.id).sort(compareAgents);
  const maxItems = options.maxItems ?? 20;
  const lines = [
    ...boxLines(`SUBAGENT ${agent.id}`, [
      `run: ${run.id}`,
      `class: ${agent.className}`,
      `status: ${statusIcon(agent.status)} ${agent.status}`,
      agent.model ? `model: ${agent.model.provider}/${agent.model.id}` : undefined,
      `task: ${agent.task}`,
      agent.usage ? `usage: ${formatUsage(agent.usage)}` : undefined,
      agent.error ? `error: ${agent.error}` : undefined,
    ].filter((line): line is string => Boolean(line))),
  ];

  if (agent.summary) {
    lines.push("", sectionTitle("OUTPUT"), limitText(agent.summary, 2000));
  }

  if (childAgents.length > 0) {
    lines.push("", sectionTitle("CHILD AGENTS"));
    for (const child of childAgents) {
      lines.push(`• ${statusIcon(child.status)} ${child.id} [${child.className}] ${child.status} — ${oneLine(child.task, 120)}`);
    }
  }

  if (options.includeMessages ?? true) {
    const messages = run.messages.filter((message) => message.from === agent.id || message.to === agent.id).slice(-maxItems);
    if (messages.length > 0) {
      lines.push("", sectionTitle("MESSAGE BUS"));
      for (const message of messages) lines.push(formatMessage(message));
    }
  }

  if (options.includeBlackboard ?? true) {
    const notes = run.blackboard.filter((entry) => entry.agentId === agent.id).slice(-maxItems);
    if (notes.length > 0) {
      lines.push("", sectionTitle("BLACKBOARD"));
      for (const note of notes) lines.push(`• ${note.kind} ${note.id}: ${oneLine(note.text, 180)}`);
    }
  }

  if (options.includeEvents ?? true) {
    const events = run.events.filter((event) => event.agentId === agent.id).slice(-maxItems);
    if (events.length > 0) {
      lines.push("", sectionTitle("EVENTS"));
      for (const event of events) lines.push(`• ${event.type}: ${oneLine(event.message, 180)}`);
    }
  }

  if (agent.status === "running") {
    lines.push("", sectionTitle("CONTROL"), `Inject prompt: workflow_prompt {"runId":"${run.id}","agentId":"${agent.id}","prompt":"..."}`);
  }

  return lines.join("\n");
}

function renderAgentList(
  lines: string[],
  children: Map<string | undefined, WorkflowAgentRuntime[]>,
  parent: string | undefined,
  prefix: string,
  options: WorkflowTreeRenderOptions,
  now: number,
): void {
  const list = children.get(parent) ?? [];
  list.forEach((agent, index) => {
    const last = index === list.length - 1;
    const branch = last ? "╰─" : "├─";
    const nextPrefix = `${prefix}${last ? "  " : "│ "}`;
    const model = agent.model ? `  ◇ ${agent.model.provider}/${agent.model.id}` : "";
    const usage = agent.usage ? `  ◈ ${formatUsage(agent.usage)}` : "";
    lines.push(`${prefix}${branch} ${statusIcon(agent.status)} ${agent.id} [${agent.className}] ${agent.status}${model}${durationSuffix(agent.startedAt, agent.completedAt, now)}${usage}`);
    lines.push(`${nextPrefix}   ├ task: ${oneLine(agent.task, 150)}`);
    lines.push(`${nextPrefix}   ├ inspect: workflow_inspect_agent {"runId":"${agent.runId}","agentId":"${agent.id}"}`);
    if (agent.status === "running") lines.push(`${nextPrefix}   ├ prompt:  workflow_prompt {"runId":"${agent.runId}","agentId":"${agent.id}","prompt":"..."}`);
    if (agent.error) lines.push(`${nextPrefix}   ├ error: ${oneLine(agent.error, 180)}`);
    if (options.includeOutputs && agent.summary) {
      lines.push(`${nextPrefix}   ╰ output: ${indentBlock(limitText(agent.summary, options.maxOutputChars ?? 800), `${nextPrefix}       `)}`);
    }
    renderAgentList(lines, children, agent.id, nextPrefix, options, now);
  });
}

function groupChildren(agents: WorkflowAgentRuntime[]): Map<string | undefined, WorkflowAgentRuntime[]> {
  const children = new Map<string | undefined, WorkflowAgentRuntime[]>();
  const knownIds = new Set(agents.map((agent) => agent.id));
  for (const agent of agents) {
    const parent = agent.parentAgentId && knownIds.has(agent.parentAgentId) ? agent.parentAgentId : undefined;
    const list = children.get(parent) ?? [];
    list.push(agent);
    children.set(parent, list);
  }
  return children;
}

function compareAgents(left: WorkflowAgentRuntime, right: WorkflowAgentRuntime): number {
  return (left.startedAt ?? 0) - (right.startedAt ?? 0) || left.id.localeCompare(right.id);
}

function countByStatus(agents: WorkflowAgentRuntime[]): string {
  if (agents.length === 0) return "0";
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
  return ["running", "pending", "completed", "failed", "cancelled"]
    .filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${status}`)
    .join(", ");
}

function statusIcon(status: WorkflowRunState["status"] | WorkflowAgentRuntime["status"]): string {
  switch (status) {
    case "running":
      return "⏳";
    case "pending":
      return "…";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "⏹";
  }
}

function durationSuffix(startedAt: number | undefined, completedAt: number | undefined, now: number): string {
  if (!startedAt) return "";
  const end = completedAt ?? now;
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  return `  ◷ ${seconds}s`;
}

function aggregateRuntimeUsage(agents: WorkflowAgentRuntime[]): WorkflowUsage | undefined {
  const usages = agents.map((agent) => agent.usage).filter((usage): usage is WorkflowUsage => Boolean(usage));
  if (usages.length === 0) return undefined;
  return usages.reduce<WorkflowUsage>(
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

function formatUsage(usage: WorkflowUsage): string {
  const cost = usage.cost === undefined ? "n/a" : `$${usage.cost.toFixed(5)}`;
  return `${formatNumber(usage.totalTokens)} tok (in ${formatNumber(usage.input)}, out ${formatNumber(usage.output)}, cache ${formatNumber(usage.cacheRead)}/${formatNumber(usage.cacheWrite)}, ${cost})`;
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

function box(title: string, body: string[]): string {
  return boxLines(title, body).join("\n");
}

function boxLines(title: string, body: string[]): string[] {
  const topTitle = ` ${title} `;
  const top = `╭${topTitle}${"─".repeat(Math.max(0, WIDTH - topTitle.length - 2))}╮`;
  const bottom = `╰${"─".repeat(WIDTH - 2)}╯`;
  return [top, ...body.flatMap((line) => wrapLine(line, WIDTH - 4).map((wrapped) => `│ ${wrapped.padEnd(WIDTH - 4)} │`)), bottom];
}

function sectionTitle(title: string): string {
  const label = ` ${title} `;
  return `╾${label}${"═".repeat(Math.max(0, WIDTH - label.length - 1))}`;
}

function formatMessage(message: WorkflowMessage): string {
  const target = message.to ?? message.channel ?? "broadcast";
  return `• ${message.from} → ${target}: ${oneLine(message.text, 180)}`;
}

function wrapLine(text: string, width: number): string[] {
  const clean = text || "";
  if (clean.length <= width) return [clean];
  const chunks: string[] = [];
  for (let index = 0; index < clean.length; index += width) chunks.push(clean.slice(index, index + width));
  return chunks;
}

function oneLine(text: string, maxChars: number): string {
  return limitText(text.replace(/\s+/g, " ").trim(), maxChars);
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function indentBlock(text: string, prefix: string): string {
  const lines = text.split("\n");
  if (lines.length === 1) return lines[0] ?? "";
  return `\n${lines.map((line) => `${prefix}${line}`).join("\n")}`;
}
