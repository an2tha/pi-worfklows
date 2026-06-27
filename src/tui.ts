import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { WorkflowEngine } from "./engine";
import type { WorkflowAgentRuntime, WorkflowEvent, WorkflowRunState, WorkflowUsage } from "./types";

type WorkflowPanelView = "tree" | "inspect" | "tools" | "pricing";
type PromptMode = { agentId: string; text: string } | undefined;

export interface WorkflowOverlayOptions {
  engine: WorkflowEngine;
  getRunId: () => string | undefined;
  done: () => void;
  abort: () => void;
  getMaxLines?: () => number | undefined;
}

export class WorkflowOverlay implements Component {
  private view: WorkflowPanelView = "tree";
  private selectedIndex = 0;
  private scroll = 0;
  private scrollMax = 0;
  private pageSize = 8;
  private collapsed = new Set<string>();
  private promptMode: PromptMode;
  private statusMessage = "q close • esc abort • tab switch • ↑↓ select • u/d scroll • enter collapse • p prompt";
  private cachedWidth?: number;
  private cachedRunVersion?: string;
  private cachedLines?: string[];

  constructor(private readonly options: WorkflowOverlayOptions) {}

  handleInput(data: string): void {
    if (this.promptMode) {
      this.handlePromptInput(data);
      return;
    }

    const run = this.getRun();
    const visible = run ? this.visibleAgents(run) : [];

    if (data === "q" || data === "Q") {
      this.options.done();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.statusMessage = "aborting workflow…";
      this.options.abort();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.view = nextView(this.view);
      this.scroll = 0;
      this.invalidate();
      return;
    }
    if (data === "1") this.view = "tree";
    else if (data === "2") this.view = "inspect";
    else if (data === "3") this.view = "tools";
    else if (data === "4") this.view = "pricing";
    else if (data === "j" || matchesKey(data, Key.down)) this.moveSelection(1, visible.length);
    else if (data === "k" || matchesKey(data, Key.up)) this.moveSelection(-1, visible.length);
    else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d")) || data === "d" || data === "D" || data === "]") this.scrollBy(this.pageSize);
    else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u")) || data === "u" || data === "U" || data === "[") this.scrollBy(-this.pageSize);
    else if (matchesKey(data, Key.home)) this.scroll = 0;
    else if (matchesKey(data, Key.end)) this.scroll = this.scrollMax;
    else if (matchesKey(data, Key.right)) this.expandSelected(visible);
    else if (matchesKey(data, Key.left)) this.collapseSelected(visible);
    else if (matchesKey(data, Key.enter) || data === " ") this.toggleSelected(visible);
    else if (data === "p" || data === "P") this.startPrompt(visible);
    else if (data === "g") {
      this.selectedIndex = 0;
      this.scroll = 0;
    } else if (data === "G") {
      this.selectedIndex = Math.max(0, visible.length - 1);
      this.scroll = this.scrollMax;
      this.ensureSelectedVisible();
    }

    this.clampSelection(visible.length);
    this.invalidate();
  }

  render(width: number): string[] {
    const run = this.getRun();
    const contentWidth = Math.max(48, width - 4);
    const content = this.renderContent(run, contentWidth);
    const maxLines = this.getMaxLines();
    const visibleContent = this.applyScroll(content, contentWidth, maxLines);
    const version = runVersion(run, this.view, this.selectedIndex, this.scroll, this.collapsed, this.promptMode, this.statusMessage, maxLines);
    if (this.cachedLines && this.cachedWidth === width && this.cachedRunVersion === version) return this.cachedLines;

    const lines = frameLines(" ✦ pi workflows · orchestrator ", visibleContent, width);
    this.cachedWidth = width;
    this.cachedRunVersion = version;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRunVersion = undefined;
    this.cachedLines = undefined;
  }

  private getRun(): WorkflowRunState | undefined {
    const runId = this.options.getRunId();
    return runId ? this.options.engine.getRun(runId) : undefined;
  }

  private getMaxLines(): number | undefined {
    const value = this.options.getMaxLines?.();
    if (value === undefined || !Number.isFinite(value)) return undefined;
    return Math.max(6, Math.floor(value));
  }

  private applyScroll(content: string[], width: number, maxLines: number | undefined): string[] {
    if (!maxLines || content.length + 2 <= maxLines) {
      this.scroll = 0;
      this.scrollMax = 0;
      this.pageSize = Math.max(1, maxLines ? maxLines - 3 : 8);
      return content;
    }

    const bodyCapacity = Math.max(1, maxLines - 2);
    const stickyFooter = content.at(-1) ?? "";
    const scrollable = content.slice(0, -1);
    const scrollableCapacity = Math.max(1, bodyCapacity - 1);
    this.scrollMax = Math.max(0, scrollable.length - scrollableCapacity);
    this.scroll = clamp(this.scroll, 0, this.scrollMax);
    this.pageSize = scrollableCapacity;

    const end = Math.min(scrollable.length, this.scroll + scrollableCapacity);
    const indicator = `lines ${this.scroll + 1}-${end}/${scrollable.length}`;
    return [
      ...scrollable.slice(this.scroll, end),
      truncateToWidth(`${indicator} • ${stickyFooter}`, width),
    ];
  }

  private scrollBy(delta: number): void {
    this.scroll = clamp(this.scroll + delta, 0, this.scrollMax);
  }

  private ensureSelectedVisible(): void {
    if (this.view !== "tree" || this.scrollMax <= 0) return;
    const approximateSelectedLine = 10 + this.selectedIndex * 3;
    const lower = this.scroll + 2;
    const upper = this.scroll + Math.max(2, this.pageSize - 2);
    if (approximateSelectedLine < lower) this.scroll = clamp(approximateSelectedLine - 2, 0, this.scrollMax);
    else if (approximateSelectedLine > upper) this.scroll = clamp(approximateSelectedLine - this.pageSize + 2, 0, this.scrollMax);
  }

  private renderContent(run: WorkflowRunState | undefined, width: number): string[] {
    if (!run) {
      return [
        ...hero("⏳ Waiting for workflow to start", [
          "The floating dashboard will populate as soon as the workflow run is created.",
          "q returns to the normal UI. Esc aborts the pending workflow.",
        ], width),
      ];
    }

    const agents = sortedAgents(run);
    const visible = this.visibleAgents(run);
    this.clampSelection(visible.length);
    const selected = visible[this.selectedIndex]?.agent;
    const usage = aggregateUsage(agents) ?? run.usage;

    const lines = [
      ...headerBlock(run, agents, usage, width),
      "",
      tabBar(this.view, width),
      "",
    ];

    if (this.view === "tree") lines.push(...this.renderTreeDashboard(run, visible, selected, width));
    else if (this.view === "inspect") lines.push(...this.renderInspectDashboard(run, selected, width));
    else if (this.view === "tools") lines.push(...this.renderToolsDashboard(run, width));
    else lines.push(...this.renderPricingDashboard(run, width));

    lines.push("", footerLine(this.promptMode, this.statusMessage, width));
    return lines;
  }

  private renderTreeDashboard(run: WorkflowRunState, visible: VisibleAgent[], selected: WorkflowAgentRuntime | undefined, width: number): string[] {
    const leftWidth = width >= 112 ? Math.floor(width * 0.62) : width;
    const rightWidth = width >= 112 ? width - leftWidth - 3 : width;

    const treeLines = visible.length === 0
      ? ["No agents yet."]
      : visible.flatMap((item) => this.renderAgentCard(run, item, visible[this.selectedIndex] === item, leftWidth));

    if (width < 112) {
      return [
        sectionRule("AGENT GRAPH", width),
        ...treeLines,
        "",
        ...panel("SELECTED AGENT", this.selectedSummary(run, selected, width - 4), width),
      ];
    }

    return [
      ...columns(
        panel("AGENT GRAPH", treeLines, leftWidth),
        panel("SELECTED AGENT", this.selectedSummary(run, selected, rightWidth - 4), rightWidth),
        3,
      ),
    ];
  }

  private renderAgentCard(run: WorkflowRunState, item: VisibleAgent, selected: boolean, width: number): string[] {
    const agent = item.agent;
    const hasKids = hasChildren(run, agent.id);
    const fold = hasKids ? (this.collapsed.has(agent.id) ? "▸" : "▾") : "•";
    const branch = item.last ? "╰" : "├";
    const lead = selected ? "▌" : " ";
    const indent = item.prefix;
    const usage = agent.usage ? ` · ${formatCost(agent.usage.cost)} · ${formatTokens(agent.usage.totalTokens)} tok` : "";
    const lines = [
      `${lead} ${indent}${branch}─ ${fold} ${statusIcon(agent.status)} ${agent.id} [${agent.className}] ${agent.status}${modelLabel(agent)}${usage}`,
      `  ${indent}${item.last ? " " : "│"}   task  ${agent.task}`,
    ];
    if (agent.error) lines.push(`  ${indent}${item.last ? " " : "│"}   error ${agent.error}`);
    if (selected) lines.push(`  ${indent}${item.last ? " " : "│"}   actions  enter collapse · p prompt · tab inspect`);
    lines.push("");
    return lines.map((line) => truncateToWidth(line, width));
  }

  private selectedSummary(run: WorkflowRunState, selected: WorkflowAgentRuntime | undefined, width: number): string[] {
    if (!selected) return ["No agent selected."];
    const children = sortedAgents(run).filter((agent) => agent.parentAgentId === selected.id);
    const messages = run.messages.filter((message) => message.from === selected.id || message.to === selected.id).slice(-3);
    const events = run.events.filter((event) => event.agentId === selected.id).slice(-4);
    return [
      `${statusIcon(selected.status)} ${selected.id}`,
      `[${selected.className}] ${selected.status}${modelLabel(selected)}`,
      "",
      `Task`,
      ...wrapWords(selected.task, width),
      "",
      selected.usage ? `Usage  ${formatUsage(selected.usage)}  ${formatCost(selected.usage.cost)}` : "Usage  waiting for model response",
      `Children  ${children.length}`,
      `Messages  ${messages.length}`,
      `Events    ${events.length}`,
      "",
      selected.summary ? `Output` : undefined,
      ...(selected.summary ? wrapWords(selected.summary, width).slice(0, 5) : []),
      "",
      selected.status === "running" ? "Press p to inject a steering prompt." : "Only running agents accept prompt injection.",
    ].filter((line): line is string => line !== undefined).map((line) => truncateToWidth(line, width));
  }

  private renderInspectDashboard(run: WorkflowRunState, selected: WorkflowAgentRuntime | undefined, width: number): string[] {
    if (!selected) return panel("INSPECT", ["Select an agent in the tree view first."], width);
    const children = sortedAgents(run).filter((agent) => agent.parentAgentId === selected.id);
    const messages = run.messages.filter((message) => message.from === selected.id || message.to === selected.id).slice(-8);
    const notes = run.blackboard.filter((entry) => entry.agentId === selected.id).slice(-8);
    const events = run.events.filter((event) => event.agentId === selected.id).slice(-8);

    const leftWidth = width >= 112 ? Math.floor(width * 0.52) : width;
    const rightWidth = width >= 112 ? width - leftWidth - 3 : width;
    const details = [
      `${statusIcon(selected.status)} ${selected.id} [${selected.className}] ${selected.status}${modelLabel(selected)}`,
      "",
      "Task",
      ...wrapWords(selected.task, leftWidth - 4),
      "",
      selected.usage ? `Usage  ${formatUsage(selected.usage)}  ${formatCost(selected.usage.cost)}` : "Usage  waiting for model response",
      selected.error ? `Error  ${selected.error}` : undefined,
      "",
      "Output",
      ...(selected.summary ? wrapWords(selected.summary, leftWidth - 4).slice(0, 12) : ["No output yet."]),
    ].filter((line): line is string => line !== undefined);
    const activity = [
      `Children (${children.length})`,
      ...children.map((child) => `  ${statusIcon(child.status)} ${child.id} [${child.className}] ${child.status}`),
      "",
      `Messages (${messages.length})`,
      ...messages.map((message) => `  ${message.from} → ${message.to ?? message.channel ?? "broadcast"}: ${message.text}`),
      "",
      `Blackboard (${notes.length})`,
      ...notes.map((note) => `  ${note.kind}: ${note.text}`),
      "",
      `Events (${events.length})`,
      ...events.map((event) => `  ${event.type}: ${event.message}`),
    ];

    if (width < 112) return [...panel("AGENT DETAILS", details, width), "", ...panel("ACTIVITY", activity, width)];
    return columns(panel("AGENT DETAILS", details, leftWidth), panel("ACTIVITY", activity, rightWidth), 3);
  }

  private renderToolsDashboard(run: WorkflowRunState, width: number): string[] {
    const toolEvents = run.events.filter((event) => event.type.startsWith("tool_"));
    const calls = collectToolCalls(toolEvents);
    if (calls.length === 0) return panel("TOOL CALLS", ["No tool calls recorded yet."], width);
    const rows = [
      tableRow(["state", "agent", "tool", "call id"], [8, 18, 18, Math.max(12, width - 54)]),
      "─".repeat(Math.min(width - 4, 110)),
      ...calls.slice(-28).map((call) => tableRow([
        `${toolStatusIcon(call.status)} ${call.status}`,
        call.agentId ?? "?",
        call.toolName ?? "tool",
        call.toolCallId ?? "—",
      ], [8, 18, 18, Math.max(12, width - 54)])),
    ];
    return panel(`TOOL CALLS · ${calls.length}`, rows, width);
  }

  private renderPricingDashboard(run: WorkflowRunState, width: number): string[] {
    const agents = sortedAgents(run);
    const total = aggregateUsage(agents) ?? run.usage;
    const rows = [
      ...metricCards([
        ["total cost", formatCost(total?.cost)],
        ["tokens", formatTokens(total?.totalTokens ?? 0)],
        ["input", formatTokens(total?.input ?? 0)],
        ["output", formatTokens(total?.output ?? 0)],
      ], width),
      "",
      tableRow(["agent", "class", "status", "tokens", "cost"], [20, 12, 12, 12, 12]),
      "─".repeat(Math.min(width - 4, 90)),
      ...agents.map((agent) => tableRow([
        agent.id,
        agent.className,
        agent.status,
        formatTokens(agent.usage?.totalTokens ?? 0),
        formatCost(agent.usage?.cost),
      ], [20, 12, 12, 12, 12])),
    ];
    return panel("PRICING & TOKENS", rows, width);
  }

  private visibleAgents(run: WorkflowRunState): VisibleAgent[] {
    const roots = sortedAgents(run).filter((agent) => !agent.parentAgentId || !run.agents.has(agent.parentAgentId));
    const result: VisibleAgent[] = [];
    const visit = (agent: WorkflowAgentRuntime, prefix: string, last: boolean) => {
      result.push({ agent, prefix, last });
      if (this.collapsed.has(agent.id)) return;
      const children = sortedAgents(run).filter((candidate) => candidate.parentAgentId === agent.id);
      children.forEach((child, index) => visit(child, `${prefix}${last ? "  " : "│ "}`, index === children.length - 1));
    };
    roots.forEach((root, index) => visit(root, "", index === roots.length - 1));
    return result;
  }

  private moveSelection(delta: number, count: number): void {
    this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + delta));
    this.ensureSelectedVisible();
  }

  private clampSelection(count: number): void {
    if (count <= 0) this.selectedIndex = 0;
    else this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex));
  }

  private toggleSelected(visible: VisibleAgent[]): void {
    const agent = visible[this.selectedIndex]?.agent;
    if (!agent) return;
    if (this.collapsed.has(agent.id)) this.collapsed.delete(agent.id);
    else this.collapsed.add(agent.id);
  }

  private expandSelected(visible: VisibleAgent[]): void {
    const agent = visible[this.selectedIndex]?.agent;
    if (agent) this.collapsed.delete(agent.id);
  }

  private collapseSelected(visible: VisibleAgent[]): void {
    const agent = visible[this.selectedIndex]?.agent;
    if (agent) this.collapsed.add(agent.id);
  }

  private startPrompt(visible: VisibleAgent[]): void {
    const agent = visible[this.selectedIndex]?.agent;
    if (!agent) return;
    if (agent.status !== "running") {
      this.statusMessage = `agent ${agent.id} is not running`;
      return;
    }
    this.promptMode = { agentId: agent.id, text: "" };
  }

  private handlePromptInput(data: string): void {
    if (!this.promptMode) return;
    if (matchesKey(data, Key.escape)) {
      this.promptMode = undefined;
      this.statusMessage = "prompt cancelled";
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const run = this.getRun();
      const prompt = this.promptMode.text.trim();
      const agentId = this.promptMode.agentId;
      this.promptMode = undefined;
      if (run && prompt) {
        try {
          this.options.engine.injectPrompt(run.id, agentId, prompt, "steer");
          this.statusMessage = `injected prompt into ${agentId}`;
        } catch (error) {
          this.statusMessage = error instanceof Error ? error.message : String(error);
        }
      }
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\x7f") {
      this.promptMode.text = this.promptMode.text.slice(0, -1);
    } else if (data.length === 1 && data >= " ") {
      this.promptMode.text += data;
    }
    this.invalidate();
  }
}

interface VisibleAgent {
  agent: WorkflowAgentRuntime;
  prefix: string;
  last: boolean;
}

interface ToolCallSummary {
  toolCallId?: string;
  agentId?: string;
  toolName?: string;
  status: "running" | "completed" | "failed";
}

function headerBlock(run: WorkflowRunState, agents: WorkflowAgentRuntime[], usage: WorkflowUsage | undefined, width: number): string[] {
  return [
    `${statusIcon(run.status)} ${run.status.toUpperCase()}  ${run.goal ?? "workflow"}`,
    `run ${run.id}`,
    "",
    ...metricCards([
      ["agents", countByStatus(agents)],
      ["cost", formatCost(usage?.cost)],
      ["tokens", formatTokens(usage?.totalTokens ?? 0)],
      ["bus", `${run.messages.length} msg · ${run.blackboard.length} notes`],
    ], width),
  ];
}

function hero(title: string, body: string[], width: number): string[] {
  return panel(title, ["", ...body, "", "q close · esc abort"], width);
}

function metricCards(items: Array<[string, string]>, width: number): string[] {
  if (width < 78) return items.map(([label, value]) => `${label}: ${value}`);
  const gap = 2;
  const cardWidth = Math.max(16, Math.floor((width - gap * (items.length - 1)) / items.length));
  const top = items.map(([label]) => `╭─ ${truncateToWidth(label, cardWidth - 5).padEnd(cardWidth - 5, "─")}╮`).join("  ");
  const mid = items.map(([, value]) => `│ ${truncateToWidth(value, cardWidth - 4).padEnd(cardWidth - 4)} │`).join("  ");
  const bot = items.map(() => `╰${"─".repeat(cardWidth - 2)}╯`).join("  ");
  return [top, mid, bot];
}

function panel(title: string, body: string[], width: number): string[] {
  const safeWidth = Math.max(28, width);
  const inner = safeWidth - 4;
  const label = ` ${title} `;
  const top = `╭${label}${"─".repeat(Math.max(0, safeWidth - label.length - 2))}╮`;
  const bottom = `╰${"─".repeat(safeWidth - 2)}╯`;
  const rows = body.length === 0 ? [""] : body;
  return [top, ...rows.flatMap((line) => wrapWords(line, inner).map((wrapped) => `│ ${padVisual(wrapped, inner)} │`)), bottom];
}

function columns(left: string[], right: string[], gap: number): string[] {
  const leftWidth = Math.max(...left.map((line) => visibleWidth(line)), 0);
  const rightWidth = Math.max(...right.map((line) => visibleWidth(line)), 0);
  const height = Math.max(left.length, right.length);
  const blankLeft = " ".repeat(leftWidth);
  const blankRight = " ".repeat(rightWidth);
  const spacer = " ".repeat(gap);
  const lines: string[] = [];
  for (let index = 0; index < height; index++) {
    lines.push(`${padVisual(left[index] ?? blankLeft, leftWidth)}${spacer}${padVisual(right[index] ?? blankRight, rightWidth)}`);
  }
  return lines;
}

function sectionRule(title: string, width: number): string {
  const label = ` ${title} `;
  return `╾${label}${"═".repeat(Math.max(0, width - visibleWidth(label) - 1))}`;
}

function tabBar(active: WorkflowPanelView, width: number): string {
  const labels = (["tree", "inspect", "tools", "pricing"] as WorkflowPanelView[])
    .map((view, index) => (view === active ? ` ${index + 1} ${view.toUpperCase()} ` : ` ${index + 1} ${view} `));
  return truncateToWidth(labels.join("  "), width);
}

function footerLine(promptMode: PromptMode, statusMessage: string, width: number): string {
  const text = promptMode ? `prompt › ${promptMode.agentId}: ${promptMode.text}` : statusMessage;
  return truncateToWidth(` ${text}`, width);
}

function tableRow(values: string[], widths: number[]): string {
  return values.map((value, index) => padVisual(truncateToWidth(value, widths[index] ?? 12), widths[index] ?? 12)).join("  ");
}

function nextView(view: WorkflowPanelView): WorkflowPanelView {
  if (view === "tree") return "inspect";
  if (view === "inspect") return "tools";
  if (view === "tools") return "pricing";
  return "tree";
}

function sortedAgents(run: WorkflowRunState): WorkflowAgentRuntime[] {
  return Array.from(run.agents.values()).sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0) || left.id.localeCompare(right.id));
}

function hasChildren(run: WorkflowRunState, agentId: string): boolean {
  return Array.from(run.agents.values()).some((agent) => agent.parentAgentId === agentId);
}

function collectToolCalls(events: WorkflowEvent[]): ToolCallSummary[] {
  const calls = new Map<string, ToolCallSummary>();
  for (const event of events) {
    const data = event.data as { toolCallId?: string; args?: unknown } | undefined;
    const id = data?.toolCallId ?? `${event.id}`;
    const call = calls.get(id) ?? { toolCallId: data?.toolCallId, agentId: event.agentId, status: "running" };
    call.agentId = event.agentId ?? call.agentId;
    call.toolName = event.message.split(" ")[0] || call.toolName;
    if (event.type === "tool_error") call.status = "failed";
    else if (event.type === "tool_end") call.status = "completed";
    else call.status = call.status ?? "running";
    calls.set(id, call);
  }
  return Array.from(calls.values());
}

function runVersion(
  run: WorkflowRunState | undefined,
  view: WorkflowPanelView,
  selectedIndex: number,
  scroll: number,
  collapsed: Set<string>,
  promptMode: PromptMode,
  statusMessage: string,
  maxLines: number | undefined,
): string {
  if (!run) return `none:${view}:${selectedIndex}:${scroll}:${maxLines}:${statusMessage}`;
  return JSON.stringify({
    id: run.id,
    status: run.status,
    agents: Array.from(run.agents.values()).map((agent) => [agent.id, agent.status, agent.summary, agent.error, agent.usage?.totalTokens]),
    events: run.events.length,
    messages: run.messages.length,
    notes: run.blackboard.length,
    usage: run.usage?.totalTokens,
    view,
    selectedIndex,
    scroll,
    maxLines,
    collapsed: Array.from(collapsed).sort(),
    promptMode,
    statusMessage,
  });
}

function frameLines(title: string, content: string[], width: number): string[] {
  const safeWidth = Math.max(52, width);
  const inner = safeWidth - 4;
  const titleText = ` ${title.trim()} `;
  const top = `╭${titleText}${"═".repeat(Math.max(0, safeWidth - visibleWidth(titleText) - 2))}╮`;
  const bottom = `╰${"═".repeat(safeWidth - 2)}╯`;
  const body = content.map((line) => `│ ${padVisual(truncateToWidth(line, inner), inner)} │`);
  return [top, ...body, bottom];
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

function aggregateUsage(agents: WorkflowAgentRuntime[]): WorkflowUsage | undefined {
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

function modelLabel(agent: WorkflowAgentRuntime): string {
  return agent.model ? ` ◇ ${agent.model.provider}/${agent.model.id}` : "";
}

function formatUsage(usage: WorkflowUsage | undefined): string {
  if (!usage) return "0 tok";
  return `${formatTokens(usage.totalTokens)} tok · ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} · cache ${formatTokens(usage.cacheRead)}/${formatTokens(usage.cacheWrite)}`;
}

function formatCost(cost: number | undefined): string {
  return cost === undefined ? "$0.00000" : `$${cost.toFixed(5)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
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

function toolStatusIcon(status: ToolCallSummary["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  return "⏳";
}

function wrapWords(text: string, width: number): string[] {
  const safeWidth = Math.max(10, width);
  if (text.length <= safeWidth) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (visibleWidth(next) <= safeWidth) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function padVisual(text: string, width: number): string {
  const current = visibleWidth(text);
  if (current >= width) return truncateToWidth(text, width, "");
  return `${text}${" ".repeat(width - current)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
