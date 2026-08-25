import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  archiveManagedWorktree,
  ManagedWorktreeRotator,
  WorktreeRotationError,
} from "./worktree-rotation.js";
import type { WorkspaceSession } from "./workspace-store.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-worktree-rotation-test-"));

try {
  const source = join(root, "project");
  const remote = join(root, "remote.git");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(source);
  await mkdir(worktreeRoot);
  await git(source, ["init"]);
  await git(source, ["config", "user.email", "devspace@example.com"]);
  await git(source, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(source, "README.md"), "initial\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "Initial commit"]);
  await git(root, ["init", "--bare", remote]);
  await git(source, ["remote", "add", "origin", remote]);
  await writeFile(join(source, ".gitignore"), "node_modules/\n");
  await git(source, ["add", ".gitignore"]);
  await git(source, ["commit", "-m", "Ignore dependencies"]);

  const first = join(worktreeRoot, "project-first");
  const second = join(worktreeRoot, "project-second");
  const third = join(worktreeRoot, "project-third");
  for (const path of [first, second, third]) {
    await git(source, ["worktree", "add", "--detach", path, "HEAD"]);
  }
  await mkdir(join(first, "node_modules"));
  await writeFile(join(first, "node_modules", "cache.txt"), "generated\n");

  const archivedRecords: Array<{ root: string; remote: string; ref: string }> = [];
  const sessions = [
    session(first, "2026-01-01T00:00:00.000Z"),
    session(second, "2026-01-02T00:00:00.000Z"),
    session(third, "2026-01-03T00:00:00.000Z"),
  ];
  const rotator = new ManagedWorktreeRotator(worktreeRoot, 2, "origin", {
    listManagedWorktreeSessions: () => sessions,
    markWorktreeArchived: (worktree, archiveRemote, archiveRef) => {
      archivedRecords.push({ root: worktree, remote: archiveRemote, ref: archiveRef });
    },
  });
  const rotated = await rotator.enforce();
  assert.equal(rotated.beforeCount, 3);
  assert.equal(rotated.afterCount, 2);
  assert.deepEqual(rotated.archived.map((entry) => entry.path), [first]);
  assert.equal(archivedRecords[0]?.root, first);
  assert.equal(archivedRecords[0]?.remote, "origin");
  assert.match(archivedRecords[0]?.ref ?? "", /^refs\/heads\/devspace-archive\/project\//);
  assert.equal(
    (await git(source, ["ls-remote", "--heads", "origin", archivedRecords[0]!.ref])).trim().length > 0,
    true,
  );

  await writeFile(join(second, "dirty.txt"), "dirty\n");
  await writeFile(join(third, "dirty.txt"), "dirty\n");
  const blocked = new ManagedWorktreeRotator(worktreeRoot, 1, "origin", {
    listManagedWorktreeSessions: () => sessions.slice(1),
  });
  await assert.rejects(
    () => blocked.enforce(),
    (error: unknown) => {
      assert.equal(error instanceof WorktreeRotationError, true);
      assert.match((error as Error).message, /Unable to reduce managed worktrees to 1/);
      return true;
    },
  );
  await rm(join(second, "dirty.txt"));
  await rm(join(third, "dirty.txt"));

  const unmerged = join(worktreeRoot, "project-unmerged");
  await git(source, ["worktree", "add", "--detach", unmerged, "HEAD"]);
  await writeFile(join(unmerged, "feature.txt"), "feature\n");
  await git(unmerged, ["add", "."]);
  await git(unmerged, ["commit", "-m", "Feature"], {
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  });
  await assert.rejects(
    () => archiveManagedWorktree(unmerged, "origin", { requireMergedIntoSourceHead: true }),
    /is not merged into source HEAD/,
  );
  const featureHead = (await git(unmerged, ["rev-parse", "HEAD"])).trim();
  await git(source, ["cherry-pick", featureHead], {
    GIT_COMMITTER_DATE: "2026-01-02T00:00:00Z",
  });
  assert.notEqual((await git(source, ["rev-parse", "HEAD"])).trim(), featureHead);
  const completed = await archiveManagedWorktree(
    unmerged,
    "origin",
    { requireMergedIntoSourceHead: true },
  );
  assert.equal(completed.head, featureHead);
  assert.equal(
    (await git(source, ["ls-remote", "--heads", "origin", completed.archiveRef])).trim().length > 0,
    true,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

function session(path: string, lastUsedAt: string): WorkspaceSession {
  return {
    id: `ws_${path}`,
    root: path,
    status: "active",
    mode: "worktree",
    sourceRoot: join(root, "project"),
    baseRef: "HEAD",
    baseSha: "",
    managed: true,
    createdAt: lastUsedAt,
    lastUsedAt,
  };
}

async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return stdout;
}
