import type { DatabaseSync } from "node:sqlite";

// allow: SIZE_OK — declarative SQLite schema and ordered additive migrations are reviewed together.

const schema = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject TEXT NOT NULL,
  display_name TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, subject)
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL,
  name TEXT NOT NULL, default_profile_id TEXT, archived_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
  revision INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  expected_outcome TEXT, priority INTEGER, owner_id TEXT,
  status TEXT NOT NULL, business_intent_epoch INTEGER NOT NULL DEFAULT 0,
  primary_attempt_id TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_filter_idx
  ON tasks(workspace_id, project_id, status, priority, updated_at DESC, id);
CREATE TABLE IF NOT EXISTS task_entries (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
  author_id TEXT NOT NULL, entry_type TEXT NOT NULL, body_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
  task_id TEXT, session_id TEXT, attempt_id TEXT, binding_generation INTEGER,
  revision INTEGER NOT NULL, kind TEXT NOT NULL, author_id TEXT NOT NULL,
  recipient_json TEXT NOT NULL, prompt TEXT NOT NULL, reason TEXT,
  reference_ids_json TEXT NOT NULL, answer_schema_json TEXT NOT NULL,
  blocking TEXT NOT NULL, validity_json TEXT NOT NULL, status TEXT NOT NULL,
  response_route TEXT NOT NULL, expires_at TEXT, supersedes_request_id TEXT,
  action_description_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_open_idx
  ON requests(workspace_id, status, project_id, kind, updated_at DESC);
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL,
  request_revision INTEGER NOT NULL, author_id TEXT NOT NULL,
  answer_json TEXT NOT NULL, answer_digest TEXT NOT NULL, committed_at TEXT NOT NULL,
  UNIQUE(request_id, request_revision)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL,
  response_id TEXT NOT NULL, destination_generation INTEGER,
  operation_id TEXT, status TEXT NOT NULL, evidence_json TEXT, last_error_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_problem_idx ON deliveries(workspace_id, status, updated_at);
CREATE TABLE IF NOT EXISTS execution_profiles (
  id TEXT NOT NULL, revision INTEGER NOT NULL, workspace_id TEXT NOT NULL,
  label TEXT NOT NULL, enabled INTEGER NOT NULL, runtime_installation_id TEXT NOT NULL,
  configuration_json TEXT NOT NULL, allowed_environment_modes_json TEXT NOT NULL,
  default_environment_json TEXT NOT NULL, required_capabilities_json TEXT NOT NULL,
  allowed_effects_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(id, revision)
);
CREATE TABLE IF NOT EXISTS environment_registrations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL,
  label TEXT NOT NULL, execution_installation_id TEXT NOT NULL,
  locator_json TEXT NOT NULL, secret_refs_json TEXT NOT NULL,
  allowed_project_ids_json TEXT NOT NULL, allowed_work_areas_json TEXT NOT NULL,
  allow_runtime_service_launch INTEGER NOT NULL, verified_identity_json TEXT,
  verification_json TEXT, verified_at TEXT, weak_identity_accepted INTEGER NOT NULL, retired_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
  task_id TEXT NOT NULL, revision INTEGER NOT NULL, runtime_installation_id TEXT NOT NULL,
  native_identity_key TEXT, lifecycle TEXT NOT NULL, control_mode TEXT NOT NULL,
  binding_generation INTEGER NOT NULL, active_attempt_id TEXT,
  capabilities_json TEXT NOT NULL, predecessor_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_native_identity_unique
  ON sessions(workspace_id, native_identity_key) WHERE native_identity_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS runtime_bindings (
  session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  descriptor_json TEXT NOT NULL, generation INTEGER NOT NULL,
  last_observation_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
  session_id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_revision INTEGER NOT NULL,
  role TEXT NOT NULL, origin TEXT NOT NULL, phase TEXT NOT NULL, outcome TEXT,
  observation TEXT NOT NULL, input_snapshot_json TEXT NOT NULL,
  predecessor_id TEXT, unresolved INTEGER NOT NULL, stop_requested_at TEXT,
  native_execution_ref_json TEXT, observation_ended_at TEXT,
  business_intent_epoch INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS attempts_task_primary_unique
  ON attempts(task_id) WHERE role = 'primary' AND unresolved = 1;
CREATE UNIQUE INDEX IF NOT EXISTS attempts_session_controlled_unique
  ON attempts(session_id) WHERE role = 'primary' AND unresolved = 1;
CREATE TABLE IF NOT EXISTS environment_bindings (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
  attempt_id TEXT, source_kind TEXT NOT NULL, source_id TEXT,
  identity_json TEXT, attachment_json TEXT, lifecycle_grant_json TEXT,
  use_grant_json TEXT, work_area_keys_json TEXT NOT NULL,
  access_mode TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL,
  observation_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_key TEXT NOT NULL,
  owner_attempt_id TEXT NOT NULL, mode TEXT NOT NULL, unresolved INTEGER NOT NULL,
  assurance TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reservations_writer_unique
  ON reservations(workspace_id, resource_key) WHERE mode = 'write' AND unresolved = 1;
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL, author_id TEXT NOT NULL, summary TEXT NOT NULL,
  limitations_json TEXT NOT NULL, reference_ids_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS references_store (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT,
  kind TEXT NOT NULL, title TEXT NOT NULL, mime_type TEXT,
  provenance_json TEXT NOT NULL, locator_json TEXT, retained_text TEXT,
  availability TEXT NOT NULL, content_revision TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS command_receipts (
  workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL,
  command_type TEXT NOT NULL, payload_digest TEXT NOT NULL, command_json TEXT NOT NULL,
  status TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, actor_id, command_id)
);
CREATE TABLE IF NOT EXISTS external_operations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, command_id TEXT NOT NULL,
  connector_kind TEXT NOT NULL, installation_id TEXT NOT NULL, operation_kind TEXT NOT NULL,
  stage TEXT NOT NULL, target_id TEXT, target_generation INTEGER,
  input_digest TEXT NOT NULL, input_json TEXT NOT NULL, status TEXT NOT NULL,
  receipt_json TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_status_idx ON external_operations(workspace_id, status, updated_at);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, operation_id TEXT,
  work_type TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT, next_due_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox(state, next_due_at, id);
CREATE TABLE IF NOT EXISTS output_chunks (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
  attempt_id TEXT, local_sequence INTEGER NOT NULL, source_item_id TEXT,
  binding_generation INTEGER NOT NULL, item_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(session_id, local_sequence), UNIQUE(session_id, source_item_id, binding_generation)
);
CREATE TABLE IF NOT EXISTS inbound_events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, installation_id TEXT NOT NULL,
  stream_scope TEXT NOT NULL, native_session_key TEXT NOT NULL,
  source_event_id TEXT NOT NULL, binding_generation INTEGER NOT NULL,
  event_json TEXT NOT NULL, received_at TEXT NOT NULL,
  UNIQUE(workspace_id, installation_id, stream_scope, native_session_key,
    source_event_id, binding_generation)
);
CREATE TABLE IF NOT EXISTS audit_entries (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT,
  target_id TEXT, command_id TEXT, operation_id TEXT, summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_view_state (
  workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, attention_key TEXT NOT NULL,
  read_at TEXT, dismissed_at TEXT, PRIMARY KEY(workspace_id, user_id, attention_key)
);
CREATE TRIGGER IF NOT EXISTS expire_agent_requests_on_attempt_end
AFTER UPDATE OF unresolved ON attempts
WHEN OLD.unresolved = 1 AND NEW.unresolved = 0
BEGIN
  UPDATE deliveries SET status = 'suppressed',
    last_error_json = '{"code":"recipient_unavailable"}', updated_at = NEW.updated_at
    WHERE workspace_id = NEW.workspace_id AND status IN ('pending','unknown')
      AND request_id IN (SELECT id FROM requests WHERE workspace_id = NEW.workspace_id
        AND session_id = NEW.session_id AND attempt_id = NEW.id AND status = 'open'
        AND json_extract(recipient_json, '$.kind') = 'agent_session'
        AND json_extract(recipient_json, '$.sessionId') = NEW.session_id);
  UPDATE requests SET revision = revision + 1, status = 'expired', updated_at = NEW.updated_at
    WHERE workspace_id = NEW.workspace_id AND session_id = NEW.session_id
      AND attempt_id = NEW.id AND status = 'open'
      AND json_extract(recipient_json, '$.kind') = 'agent_session'
      AND json_extract(recipient_json, '$.sessionId') = NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS expire_agent_requests_on_session_close
AFTER UPDATE OF lifecycle ON sessions
WHEN OLD.lifecycle <> 'closed' AND NEW.lifecycle = 'closed'
BEGIN
  UPDATE deliveries SET status = 'suppressed',
    last_error_json = '{"code":"recipient_unavailable"}', updated_at = NEW.updated_at
    WHERE workspace_id = NEW.workspace_id AND status IN ('pending','unknown')
      AND request_id IN (SELECT id FROM requests WHERE workspace_id = NEW.workspace_id
        AND session_id = NEW.id AND status = 'open'
        AND json_extract(recipient_json, '$.kind') = 'agent_session'
        AND json_extract(recipient_json, '$.sessionId') = NEW.id);
  UPDATE requests SET revision = revision + 1, status = 'expired', updated_at = NEW.updated_at
    WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id AND status = 'open'
      AND json_extract(recipient_json, '$.kind') = 'agent_session'
      AND json_extract(recipient_json, '$.sessionId') = NEW.id;
END;
`;

export function migrate(database: DatabaseSync): void {
  database.exec(schema);
  const columns = database.prepare("PRAGMA table_info(environment_registrations)").all();
  if (!columns.some((column) => Reflect.get(column, "name") === "verification_json")) {
    database.exec("ALTER TABLE environment_registrations ADD COLUMN verification_json TEXT");
  }
  const outboxColumns = database.prepare("PRAGMA table_info(outbox)").all();
  if (!outboxColumns.some((column) => Reflect.get(column, "name") === "lease_token")) {
    database.exec("ALTER TABLE outbox ADD COLUMN lease_token TEXT");
  }
  const inboundColumns = database.prepare("PRAGMA table_info(inbound_events)").all();
  if (!inboundColumns.some((column) => Reflect.get(column, "name") === "stream_scope")) {
    migrateInboundEvents(database);
  }
  const attemptColumns = database.prepare("PRAGMA table_info(attempts)").all();
  if (!attemptColumns.some((column) => Reflect.get(column, "name") === "native_execution_ref_json")) {
    database.exec("ALTER TABLE attempts ADD COLUMN native_execution_ref_json TEXT");
  }
  if (!attemptColumns.some((column) => Reflect.get(column, "name") === "observation_ended_at")) {
    database.exec("ALTER TABLE attempts ADD COLUMN observation_ended_at TEXT");
  }
}

function migrateInboundEvents(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`ALTER TABLE inbound_events RENAME TO inbound_events_legacy;
      CREATE TABLE inbound_events (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, installation_id TEXT NOT NULL,
        stream_scope TEXT NOT NULL, native_session_key TEXT NOT NULL,
        source_event_id TEXT NOT NULL, binding_generation INTEGER NOT NULL,
        event_json TEXT NOT NULL, received_at TEXT NOT NULL,
        UNIQUE(workspace_id, installation_id, stream_scope, native_session_key,
          source_event_id, binding_generation)
      );
      INSERT INTO inbound_events
        (id, workspace_id, installation_id, stream_scope, native_session_key,
         source_event_id, binding_generation, event_json, received_at)
      SELECT id, workspace_id, installation_id,
        COALESCE(json_extract(event_json, '$.streamScope'), ''),
        json_object(
          'installationId', json_extract(event_json, '$.nativeSession.installationId'),
          'providerScope', json_extract(event_json, '$.nativeSession.providerScope'),
          'kind', json_extract(event_json, '$.nativeSession.kind'),
          'id', json_extract(event_json, '$.nativeSession.id'),
          'incarnation', json_extract(event_json, '$.nativeSession.incarnation')
        ), source_event_id, binding_generation, event_json, received_at
      FROM inbound_events_legacy;
      DROP TABLE inbound_events_legacy;`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
