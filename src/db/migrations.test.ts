import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateDatabase } from "./migrations.js";

const sqlite = new Database(":memory:");
try {
  sqlite.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
    insert into devspace_schema_migrations values
      (1, 'workspace-state', '2026-01-01T00:00:00.000Z'),
      (2, 'oauth-state', '2026-01-01T00:00:00.000Z'),
      (3, 'local-agent-sessions', '2026-01-01T00:00:00.000Z');
    create table workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );
  `);

  migrateDatabase(sqlite);

  const columns = sqlite.prepare("pragma table_info(workspace_sessions)").all() as Array<{
    name: string;
  }>;
  assert.equal(columns.some((column) => column.name === "archive_remote"), true);
  assert.equal(columns.some((column) => column.name === "archive_ref"), true);
  assert.equal(columns.some((column) => column.name === "archived_at"), true);
  assert.deepEqual(
    sqlite.prepare("select version, name from devspace_schema_migrations where version = 4").get(),
    { version: 4, name: "worktree-archive-state" },
  );
} finally {
  sqlite.close();
}
