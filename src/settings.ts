import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type WorkflowSettingsScope = "project" | "global";

export interface WorkflowSettings {
  fastModel?: string;
  defaultModel?: string;
}

export interface PiWorkflowSettingsFile {
  workflows?: WorkflowSettings;
  workflow?: WorkflowSettings;
  piWorkflows?: WorkflowSettings;
  workflowFastModel?: string;
  workflowDefaultModel?: string;
}

export function workflowSettingsPath(cwd: string, scope: WorkflowSettingsScope): string {
  if (scope === "project") return resolve(cwd, ".pi", "settings.json");
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error("Cannot resolve global workflow settings path: HOME is not set");
  return resolve(home, ".pi", "agent", "settings.json");
}

export async function loadWorkflowSettings(cwd: string): Promise<WorkflowSettings> {
  const home = process.env.HOME || process.env.USERPROFILE;
  const globalPath = home ? resolve(home, ".pi", "agent", "settings.json") : undefined;
  const projectPath = resolve(cwd, ".pi", "settings.json");

  const globalSettings = globalPath ? await readSettingsFile(globalPath) : {};
  const projectSettings = await readSettingsFile(projectPath);
  return mergeWorkflowSettings(extractWorkflowSettings(globalSettings), extractWorkflowSettings(projectSettings));
}

export async function saveWorkflowSettings(cwd: string, scope: WorkflowSettingsScope, settings: WorkflowSettings): Promise<string> {
  const path = workflowSettingsPath(cwd, scope);
  const existing = await readSettingsFile(path);
  const next = {
    ...existing,
    workflows: {
      ...(existing.workflows ?? {}),
      ...withoutUndefined(settings),
    },
  } satisfies PiWorkflowSettingsFile;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return path;
}

async function readSettingsFile(path: string): Promise<PiWorkflowSettingsFile> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PiWorkflowSettingsFile;
  } catch {
    return {};
  }
}

function extractWorkflowSettings(settings: PiWorkflowSettingsFile): WorkflowSettings {
  return {
    ...settings.workflows,
    ...settings.workflow,
    ...settings.piWorkflows,
    fastModel: settings.workflowFastModel ?? settings.piWorkflows?.fastModel ?? settings.workflow?.fastModel ?? settings.workflows?.fastModel,
    defaultModel:
      settings.workflowDefaultModel ??
      settings.piWorkflows?.defaultModel ??
      settings.workflow?.defaultModel ??
      settings.workflows?.defaultModel,
  };
}

function mergeWorkflowSettings(base: WorkflowSettings, override: WorkflowSettings): WorkflowSettings {
  return {
    fastModel: override.fastModel ?? base.fastModel,
    defaultModel: override.defaultModel ?? base.defaultModel,
  };
}

function withoutUndefined(settings: WorkflowSettings): WorkflowSettings {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)) as WorkflowSettings;
}

export function describeWorkflowSettingsLocation(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return `${resolve(cwd, ".pi", "settings.json")} or ${resolve(home, ".pi", "agent", "settings.json")}`;
}
