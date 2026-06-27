import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowExtension } from "./src/extension";

export {
  createWorkflowExtension,
  type WorkflowExtensionOptions,
} from "./src/extension";
export {
  WorkflowEngine,
  createDefaultAgentClasses,
} from "./src/engine";
export {
  defineAgentClass,
  defineWorkflowTool,
  textResult,
  type AgentClassDefinition,
  type AgentPromptContext,
  type ModelSelector,
  type WorkflowAgentResult,
  type WorkflowAgentRuntime,
  type WorkflowAgentSpec,
  type WorkflowBlackboardEntry,
  type WorkflowEngineOptions,
  type WorkflowHostContext,
  type WorkflowLimits,
  type WorkflowMessage,
  type WorkflowPlan,
  type WorkflowRunResult,
  type WorkflowRunState,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "./src/types";
export {
  type WorkflowWriteLock,
} from "./src/locks";

const defaultExtension = createWorkflowExtension();

export default function (pi: ExtensionAPI) {
  return defaultExtension(pi);
}