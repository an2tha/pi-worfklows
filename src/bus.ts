import type {
  WorkflowBlackboardEntry,
  WorkflowBlackboardFilter,
  WorkflowEvent,
  WorkflowMessage,
  WorkflowReceiveFilter,
  WorkflowRunState,
} from "./types";

export function makeId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export function pushEvent(
  run: WorkflowRunState,
  event: Omit<WorkflowEvent, "id" | "runId" | "createdAt">,
): WorkflowEvent {
  const entry: WorkflowEvent = {
    id: makeId("evt"),
    runId: run.id,
    createdAt: Date.now(),
    ...event,
  };
  run.events.push(entry);
  return entry;
}

export function sendMessage(
  run: WorkflowRunState,
  message: Omit<WorkflowMessage, "id" | "runId" | "createdAt">,
): WorkflowMessage {
  const entry: WorkflowMessage = {
    id: makeId("msg"),
    runId: run.id,
    createdAt: Date.now(),
    ...message,
  };
  run.messages.push(entry);
  pushEvent(run, {
    agentId: message.from,
    type: "message",
    message: `message ${message.from} -> ${message.to ?? message.channel ?? "broadcast"}`,
    data: { id: entry.id, to: entry.to, channel: entry.channel },
  });
  return entry;
}

export function receiveMessages(run: WorkflowRunState, filter: WorkflowReceiveFilter = {}): WorkflowMessage[] {
  let startIndex = 0;
  if (filter.sinceId) {
    const index = run.messages.findIndex((message) => message.id === filter.sinceId);
    startIndex = index >= 0 ? index + 1 : 0;
  }

  const includeBroadcast = filter.includeBroadcast ?? true;
  const messages = run.messages.slice(startIndex).filter((message) => {
    if (filter.from && message.from !== filter.from) return false;
    if (filter.channel && message.channel !== filter.channel) return false;
    if (filter.to) {
      if (message.to === filter.to) return true;
      return includeBroadcast && !message.to;
    }
    return true;
  });

  return typeof filter.limit === "number" && filter.limit >= 0 ? messages.slice(-filter.limit) : messages;
}

export function appendBlackboard(
  run: WorkflowRunState,
  entry: Omit<WorkflowBlackboardEntry, "id" | "runId" | "createdAt">,
): WorkflowBlackboardEntry {
  const item: WorkflowBlackboardEntry = {
    id: makeId("note"),
    runId: run.id,
    createdAt: Date.now(),
    ...entry,
  };
  run.blackboard.push(item);
  pushEvent(run, {
    agentId: entry.agentId,
    type: "blackboard",
    message: `${entry.agentId} appended ${entry.kind}`,
    data: { id: item.id, kind: item.kind },
  });
  return item;
}

export function readBlackboard(run: WorkflowRunState, filter: WorkflowBlackboardFilter = {}): WorkflowBlackboardEntry[] {
  let startIndex = 0;
  if (filter.sinceId) {
    const index = run.blackboard.findIndex((entry) => entry.id === filter.sinceId);
    startIndex = index >= 0 ? index + 1 : 0;
  }

  const entries = run.blackboard.slice(startIndex).filter((entry) => {
    if (filter.kind && entry.kind !== filter.kind) return false;
    if (filter.agentId && entry.agentId !== filter.agentId) return false;
    return true;
  });

  return typeof filter.limit === "number" && filter.limit >= 0 ? entries.slice(-filter.limit) : entries;
}

export function snapshotRun(run: WorkflowRunState) {
  return {
    id: run.id,
    goal: run.goal,
    status: run.status,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    parentRunId: run.parentRunId,
    rootAgentId: run.rootAgentId,
    agents: Array.from(run.agents.values()),
    messages: run.messages,
    blackboard: run.blackboard,
    events: run.events,
    error: run.error,
  };
}
