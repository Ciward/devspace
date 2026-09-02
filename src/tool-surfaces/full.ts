import * as z from "zod/v4";
import { findFilesTool, grepFilesTool, listDirectoryTool } from "../pi-tools.js";
import { registerClaudeTools } from "./claude.js";
import { registerCodexTools } from "./codex.js";
import {
  toolNames,
  workspaceIdDescription,
  type ToolInstructionContext,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
} from "./shared.js";

export function fullInstructions({ agents, skills }: ToolInstructionContext): string {
  return `${agents}${skills}Use read, grep, glob, and ls for inspection; edit for targeted changes; write only for new files or complete rewrites; bash for short commands; exec_command for long commands; and write_stdin to continue running processes. When bash or exec_command returns a sessionId, call write_stdin until completion and do not rerun the command merely because it is still running. Git lifecycle writes needed to finish the user's task are allowed.`;
}

export function registerFullTools(context: ToolRegistrationContext): void {
  registerClaudeTools(context);
  registerCodexTools(context);
  registerSearchTools(context);
}

function registerSearchTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(toolNames.grep, {
    title: "Grep",
    description: "Search file contents in a workspace. Respects project ignore rules.",
    inputSchema: {
      workspaceId: z.string().describe(workspaceIdDescription),
      pattern: z.string().describe("Search pattern."),
      path: z.string().optional().describe("Optional path or glob scope relative to the workspace root."),
      include: z.string().optional().describe("Optional include glob."),
    },
    outputSchema: resultOutputSchema(),
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId, ...input }) => {
    const startedAt = performance.now();
    const workspace = workspaces.getWorkspace(workspaceId);
    if (input.path) workspaces.resolvePath(workspace, input.path);
    const response = await grepFilesTool(input, { cwd: workspace.root, root: workspace.root });
    if (response.isError) {
      logFailedToolResponse(config, { tool: toolNames.grep, workspaceId, path: input.path }, response.content, startedAt);
      return response;
    }
    logToolCall(config, { tool: toolNames.grep, workspaceId, path: input.path, success: true, durationMs: Math.round(performance.now() - startedAt) });
    return { ...response, structuredContent: { result: contentText(response.content) } };
  });

  server.registerTool(toolNames.glob, {
    title: "Glob",
    description: "Find files by glob pattern in a workspace. Respects project ignore rules.",
    inputSchema: {
      workspaceId: z.string().describe(workspaceIdDescription),
      pattern: z.string().describe("File glob pattern."),
      path: z.string().optional().describe("Optional path scope relative to the workspace root."),
    },
    outputSchema: resultOutputSchema(),
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId, ...input }) => {
    const startedAt = performance.now();
    const workspace = workspaces.getWorkspace(workspaceId);
    if (input.path) workspaces.resolvePath(workspace, input.path);
    const response = await findFilesTool(input, { cwd: workspace.root, root: workspace.root });
    if (response.isError) {
      logFailedToolResponse(config, { tool: toolNames.glob, workspaceId, path: input.path }, response.content, startedAt);
      return response;
    }
    logToolCall(config, { tool: toolNames.glob, workspaceId, path: input.path, success: true, durationMs: Math.round(performance.now() - startedAt) });
    return { ...response, structuredContent: { result: contentText(response.content) } };
  });

  server.registerTool(toolNames.ls, {
    title: "Ls",
    description: "List a directory in a workspace.",
    inputSchema: {
      workspaceId: z.string().describe(workspaceIdDescription),
      path: z.string().describe("Directory path relative to the workspace root."),
    },
    outputSchema: resultOutputSchema(),
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId, ...input }) => {
    const startedAt = performance.now();
    const workspace = workspaces.getWorkspace(workspaceId);
    workspaces.resolvePath(workspace, input.path);
    const response = await listDirectoryTool(input, { cwd: workspace.root, root: workspace.root });
    if (response.isError) {
      logFailedToolResponse(config, { tool: toolNames.ls, workspaceId, path: input.path }, response.content, startedAt);
      return response;
    }
    logToolCall(config, { tool: toolNames.ls, workspaceId, path: input.path, success: true, durationMs: Math.round(performance.now() - startedAt) });
    return { ...response, structuredContent: { result: contentText(response.content) } };
  });
}
