import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./migrations.js";

interface LegacyDatabaseOptions {
  migration4?: "worktree-archive-state" | "workspace-conversation-bindings";
  includeArchiveState?: boolean;
  includeConversationBindings?: boolean;
}

function createLegacyDatabase(options: LegacyDatabaseOptions = {}): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  const archiveColumns = options.includeArchiveState
    ? `
      archive_remote text,
      archive_ref text,
      archived_at text,`
    : "";

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
      ${archiveColumns}
      created_at text not null,
      last_used_at text not null
    );
    create table local_agent_sessions (
      id text primary key, workspace_id text, workspace_root text not null,
      profile_name text not null, provider text not null, model text,
      effort text, provider_session_id text, status text not null,
      latest_response text, error text, created_at text not null,
      updated_at text not null
    );
  `);

  if (options.migration4) {
    sqlite
      .prepare(
        "insert into devspace_schema_migrations (version, name, applied_at) values (4, ?, ?)",
      )
      .run(options.migration4, "2026-01-02T00:00:00.000Z");
  }

  if (options.includeConversationBindings) {
    sqlite.exec(`
      create table workspace_conversation_bindings (
        conversation_scope_id text not null,
        target_key text not null,
        workspace_session_id text not null,
        created_at text not null,
        last_used_at text not null,
        primary key (conversation_scope_id, target_key),
        foreign key (workspace_session_id)
          references workspace_sessions(id)
          on delete cascade
      );
    `);
  }

  return sqlite;
}

function assertCombinedMigration(sqlite: DatabaseSync): void {
  const columns = sqlite.prepare("pragma table_info(workspace_sessions)").all() as Array<{
    name: string;
  }>;
  assert.equal(columns.some((column) => column.name === "archive_remote"), true);
  assert.equal(columns.some((column) => column.name === "archive_ref"), true);
  assert.equal(columns.some((column) => column.name === "archived_at"), true);

  const conversationTable = sqlite
    .prepare(
      "select name from sqlite_master where type = 'table' and name = 'workspace_conversation_bindings'",
    )
    .get();
  assert.equal((conversationTable as { name?: string } | undefined)?.name, "workspace_conversation_bindings");
  const migration8 = sqlite.prepare("select version, name from devspace_schema_migrations where version = 8").get() as { version: number; name: string };
  assert.equal(migration8.version, 8);
  assert.equal(migration8.name, "local-agent-turns");

  const agentColumns = sqlite.prepare("pragma table_info(local_agent_sessions)").all() as Array<{
    name: string;
  }>;
  assert.equal(agentColumns.some((column) => column.name === "effort"), true);
  assert.equal(agentColumns.some((column) => column.name === "error_code"), true);
  assert.equal(agentColumns.some((column) => column.name === "error_retryable"), true);
  assert.equal(columns.some((column) => column.name === "recovery_kind"), true);
  assert.ok(sqlite.prepare("select name from sqlite_master where name = 'local_agent_turns'").get());
}

for (const options of [
  {},
  {
    migration4: "worktree-archive-state" as const,
    includeArchiveState: true,
  },
  {
    migration4: "workspace-conversation-bindings" as const,
    includeConversationBindings: true,
  },
]) {
  const sqlite = createLegacyDatabase(options);
  try {
    migrateDatabase(sqlite);
    assertCombinedMigration(sqlite);
    migrateDatabase(sqlite);
    assertCombinedMigration(sqlite);
  } finally {
    sqlite.close();
  }
}

const unknownHistory = createLegacyDatabase();
try {
  unknownHistory.exec("insert into devspace_schema_migrations values (4, 'unknown-lineage', '2026-01-01')");
  assert.throws(() => migrateDatabase(unknownHistory), /history is incompatible/);
  assert.equal((unknownHistory.prepare("select name from devspace_schema_migrations where version = 4").get() as { name: string }).name, "unknown-lineage");
} finally {
  unknownHistory.close();
}
