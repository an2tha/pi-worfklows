import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowEngine } from "./engine";
import type { WorkflowUsage } from "./types";

export function createWorkflowFooter(ctx: ExtensionContext, engine: WorkflowEngine, theme: any, footerData: any): Component {
  return {
    invalidate() {},
    render(width: number): string[] {
      const mainUsage = getMainSessionUsage(ctx);
      const workflowUsage = engine.getWorkflowUsage(ctx.sessionManager.getSessionId());
      const totalUsage = addUsage(mainUsage, workflowUsage);
      const workflowCost = workflowUsage?.cost ?? 0;
      const totalCost = totalUsage.cost ?? 0;

      const contextUsage = ctx.getContextUsage();
      const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const contextPercentValue = contextUsage?.percent ?? 0;
      const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined ? contextPercentValue.toFixed(1) : "?";

      let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
      const branch = footerData.getGitBranch?.();
      if (branch) pwd = `${pwd} (${branch})`;
      const sessionName = ctx.sessionManager.getSessionName();
      if (sessionName) pwd = `${pwd} • ${sessionName}`;

      const statsParts: string[] = [];
      if (totalUsage.input) statsParts.push(`↑${formatTokens(totalUsage.input)}`);
      if (totalUsage.output) statsParts.push(`↓${formatTokens(totalUsage.output)}`);
      if (totalUsage.cacheRead) statsParts.push(`R${formatTokens(totalUsage.cacheRead)}`);
      if (totalUsage.cacheWrite) statsParts.push(`W${formatTokens(totalUsage.cacheWrite)}`);
      if (totalCost || workflowCost) {
        const wfSuffix = workflowCost ? ` wf+$${workflowCost.toFixed(3)}` : "";
        statsParts.push(`$${totalCost.toFixed(3)}${wfSuffix}`);
      }

      const contextDisplay = contextPercent === "?" ? `?/${formatTokens(contextWindow)}` : `${contextPercent}%/${formatTokens(contextWindow)}`;
      const contextStyled = contextPercentValue > 90
        ? theme.fg("error", contextDisplay)
        : contextPercentValue > 70
          ? theme.fg("warning", contextDisplay)
          : contextDisplay;
      statsParts.push(contextStyled);

      if (workflowUsage?.totalTokens) {
        statsParts.push(`wf:${formatTokens(workflowUsage.totalTokens)}tok`);
      }

      let statsLeft = statsParts.join(" ");
      let statsLeftWidth = visibleWidth(statsLeft);
      if (statsLeftWidth > width) {
        statsLeft = truncateToWidth(statsLeft, width, "...");
        statsLeftWidth = visibleWidth(statsLeft);
      }

      const modelName = ctx.model?.id || "no-model";
      const rightSide = ctx.model && footerData.getAvailableProviderCount?.() > 1 ? `(${ctx.model.provider}) ${modelName}` : modelName;
      const rightWidth = visibleWidth(rightSide);
      const padding = " ".repeat(Math.max(1, width - statsLeftWidth - rightWidth));
      const statsLine = statsLeft + padding + truncateToWidth(rightSide, Math.max(0, width - statsLeftWidth - padding.length), "");

      const lines = [
        truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
        theme.fg("dim", statsLine),
      ];

      const extensionStatuses = footerData.getExtensionStatuses?.();
      if (extensionStatuses?.size > 0) {
        const statusLine = (Array.from(extensionStatuses.entries()) as Array<[unknown, unknown]>)
          .sort(([a], [b]) => String(a).localeCompare(String(b)))
          .map(([, text]) => sanitizeStatusText(String(text)))
          .join(" ");
        lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
      }

      return lines;
    },
  };
}

function getMainSessionUsage(ctx: ExtensionContext): WorkflowUsage {
  const total: WorkflowUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;
    total.cost = (total.cost ?? 0) + usage.cost.total;
  }
  return total;
}

function addUsage(left: WorkflowUsage, right?: WorkflowUsage): WorkflowUsage {
  if (!right) return left;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: (left.cost ?? 0) + (right.cost ?? 0),
  };
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome = relativeToHome === "" || (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}
