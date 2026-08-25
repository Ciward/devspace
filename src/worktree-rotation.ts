import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceSession } from "./workspace-store.js";

const execFileAsync = promisify(execFile);

export interface ArchivedWorktree {
  path: string;
  sourceRoot: string;
  head: string;
  archiveRemote: string;
  archiveRef: string;
}

export interface WorktreeRotationResult {
  beforeCount: number;
  afterCount: number;
  archived: ArchivedWorktree[];
  missingRoots: string[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface WorktreeRotationStore {
  listManagedWorktreeSessions?(): WorkspaceSession[];
  markWorktreeArchived?(root: string, archiveRemote: string, archiveRef: string): void;
  markWorktreeMissing?(root: string): void;
}

export class WorktreeRotationError extends Error {
  constructor(message: string, readonly result: WorktreeRotationResult) {
    super(message);
    this.name = "WorktreeRotationError";
  }
}

export class ManagedWorktreeRotator {
  private rotationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly worktreeRoot: string,
    private readonly maxCount: number,
    private readonly archiveRemote: string,
    private readonly store?: WorktreeRotationStore,
  ) {}

  enforce(reservedSlots = 0): Promise<WorktreeRotationResult> {
    const task = this.rotationQueue.then(() => this.rotate(reservedSlots));
    this.rotationQueue = task.catch(() => undefined);
    return task;
  }

  private async rotate(reservedSlots: number): Promise<WorktreeRotationResult> {
    if (!Number.isInteger(reservedSlots) || reservedSlots < 0) {
      throw new Error(`Invalid reserved worktree slots: ${reservedSlots}`);
    }

    const targetCount = this.maxCount === 0
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, this.maxCount - reservedSlots);
    const sessions = this.store?.listManagedWorktreeSessions?.() ?? [];
    const sessionByRoot = newestSessionByRoot(sessions);
    const directories = await listWorktreeDirectories(this.worktreeRoot);
    const directorySet = new Set(directories);
    const missingRoots = Array.from(sessionByRoot.keys()).filter((root) => !directorySet.has(root));
    for (const root of missingRoots) this.store?.markWorktreeMissing?.(root);

    const result: WorktreeRotationResult = {
      beforeCount: directories.length,
      afterCount: directories.length,
      archived: [],
      missingRoots,
      skipped: [],
    };
    if (directories.length <= targetCount) return result;

    const candidates = await Promise.all(directories.map(async (path) => ({
      path,
      lastUsedAt: sessionByRoot.get(path)?.lastUsedAt ?? (await stat(path)).birthtime.toISOString(),
      sourceRoot: sessionByRoot.get(path)?.sourceRoot,
    })));
    candidates.sort((left, right) => left.lastUsedAt.localeCompare(right.lastUsedAt));

    for (const candidate of candidates) {
      if (result.afterCount <= targetCount) break;

      try {
        const archived = await archiveManagedWorktree(candidate.path, this.archiveRemote, {
          sourceRoot: candidate.sourceRoot,
        });
        result.archived.push(archived);
        result.afterCount -= 1;
        this.store?.markWorktreeArchived?.(
          archived.path,
          archived.archiveRemote,
          archived.archiveRef,
        );
      } catch (error) {
        result.skipped.push({
          path: candidate.path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (result.afterCount > targetCount) {
      throw new WorktreeRotationError(
        `Unable to reduce managed worktrees to ${targetCount}; ${result.afterCount} remain. `
          + "No worktree is deleted unless its clean HEAD is archived and verified on the remote.",
        result,
      );
    }

    return result;
  }
}

export async function archiveManagedWorktree(
  worktreePath: string,
  archiveRemote: string,
  options: { requireMergedIntoSourceHead?: boolean; sourceRoot?: string } = {},
): Promise<ArchivedWorktree> {
  const status = await git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim()) {
    throw new Error("worktree has uncommitted or untracked files");
  }

  const head = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
  const commonDir = (await git(worktreePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])).trim();
  const sourceRoot = options.sourceRoot ?? dirname(commonDir);
  if (options.requireMergedIntoSourceHead) {
    const sourceHead = (await git(sourceRoot, ["rev-parse", "HEAD"])).trim();
    if (!await isMergedIntoSource(worktreePath, head, sourceHead)) {
      throw new Error(
        `worktree HEAD ${head.slice(0, 12)} is not merged into source HEAD ${sourceHead.slice(0, 12)}`,
      );
    }
  }
  const archiveRef = buildArchiveRef(sourceRoot, worktreePath, head);

  await git(worktreePath, ["push", archiveRemote, `HEAD:${archiveRef}`]);
  const remoteLine = (await git(worktreePath, ["ls-remote", "--heads", archiveRemote, archiveRef])).trim();
  const remoteHead = remoteLine.split(/\s+/)[0];
  if (remoteHead !== head) {
    throw new Error(`archive verification failed for ${archiveRemote}/${archiveRef}`);
  }

  await git(sourceRoot, ["worktree", "remove", "--force", worktreePath]);
  await git(sourceRoot, ["worktree", "prune"]);

  return { path: worktreePath, sourceRoot, head, archiveRemote, archiveRef };
}

async function isMergedIntoSource(
  worktreePath: string,
  head: string,
  sourceHead: string,
): Promise<boolean> {
  try {
    await git(worktreePath, ["merge-base", "--is-ancestor", head, sourceHead]);
    return true;
  } catch {
    const cherry = (await git(worktreePath, ["cherry", sourceHead, head])).trim();
    return cherry.length > 0 && cherry.split("\n").every((line) => line.startsWith("- "));
  }
}

function buildArchiveRef(sourceRoot: string, worktreePath: string, head: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const repo = sanitizeRefSegment(basename(sourceRoot)) || "repo";
  const worktree = sanitizeRefSegment(basename(worktreePath)) || "worktree";
  return `refs/heads/devspace-archive/${repo}/${worktree}-${head.slice(0, 12)}-${timestamp}`;
}

function sanitizeRefSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/\.\.+/g, ".");
}

async function listWorktreeDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

function newestSessionByRoot(sessions: WorkspaceSession[]): Map<string, WorkspaceSession> {
  const result = new Map<string, WorkspaceSession>();
  for (const session of sessions) {
    const current = result.get(session.root);
    if (!current || current.lastUsedAt < session.lastUsedAt) result.set(session.root, session);
  }
  return result;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  }
}
