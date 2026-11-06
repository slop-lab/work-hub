import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ActionContextSchema, AllocationDescriptorSchema, AllocationRequestSchema, JsonObjectSchema, JsonValueSchema, NativeRefSchema, ResourceIdentitySchema, SerializedOperationReceiptSchema, validateSerializedOperationReceipt, type ActionContext, type AllocationDescriptor, type AllocationRequest, type JsonObject, type JsonValue, type NativeRef, type OperationLookup, type ResourceIdentity, type SerializedOperationReceipt } from "../contracts/index.ts";
import { typedReceipt } from "./operation.ts";
import type { RuntimeProfile, ScriptedOutcome, SimulatedEnvironment, SimulatorCall } from "./types.ts";

const OperationRowSchema = z.strictObject({ digest: z.string(), receipt: z.string(), visible_receipt: z.string().nullable() });
const StateRowSchema = z.strictObject({ value: z.string() });
const ScriptRowSchema = z.strictObject({ id: z.number(), outcome: z.string() });
const CallRowSchema = z.strictObject({ sequence: z.number(), connector: z.enum(["execution", "runtime"]), operation_kind: z.string(), operation_id: z.string().nullable(), input_digest: z.string().nullable(), input: z.string(), recorded_at: z.string() });
const OutputRowSchema = z.strictObject({ sequence: z.number(), item: z.string() });
const EventRowSchema = z.strictObject({ sequence: z.number(), event: z.string() });
const StreamRowSchema = z.strictObject({ sequence: z.number(), kind: z.enum(["output", "event"]), item: z.string() });
const MaxSequenceRowSchema = z.strictObject({ sequence: z.number() });
const AttachmentStateSchema = z.strictObject({ attachmentRef: NativeRefSchema, identity: ResourceIdentitySchema, detached: z.boolean() });
const PendingAllocationSchema = z.strictObject({ context: ActionContextSchema, request: AllocationRequestSchema });

export class SimulatorStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS operations(operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL, visible_receipt TEXT); CREATE TABLE IF NOT EXISTS calls(sequence INTEGER PRIMARY KEY AUTOINCREMENT, connector TEXT NOT NULL, operation_kind TEXT NOT NULL, operation_id TEXT, input_digest TEXT, input TEXT NOT NULL, recorded_at TEXT NOT NULL); " +
      "CREATE TABLE IF NOT EXISTS scripts(id INTEGER PRIMARY KEY AUTOINCREMENT, operation_kind TEXT NOT NULL, outcome TEXT NOT NULL); CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS output(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, item TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runtime_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, event TEXT NOT NULL); " +
      "CREATE TABLE IF NOT EXISTS runtime_stream(session_id TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY(session_id,sequence));");
  }
  close(): void { this.#db.close(); }
  now(): string {
    const current = z.coerce.number().int().parse(this.getState("clock") ?? "0") + 1;
    this.setState("clock", String(current));
    return this.timestamp(current);
  }
  isExpired(timestamp: string): boolean { return Date.parse(timestamp) <= Date.parse(this.timestamp(z.coerce.number().int().parse(this.getState("clock") ?? "0"))); }
  getOperation(operationId: string): { readonly digest: string; readonly receipt: SerializedOperationReceipt; readonly visibleReceipt?: SerializedOperationReceipt } | undefined {
    const raw = this.#db.prepare("SELECT digest, receipt, visible_receipt FROM operations WHERE operation_id = ?").get(operationId);
    if (raw === undefined) return undefined;
    const row = OperationRowSchema.parse(raw);
    const visibleReceipt = row.visible_receipt === null ? undefined : SerializedOperationReceiptSchema.parse(JSON.parse(row.visible_receipt));
    return visibleReceipt === undefined
      ? { digest: row.digest, receipt: SerializedOperationReceiptSchema.parse(JSON.parse(row.receipt)) }
      : { digest: row.digest, receipt: SerializedOperationReceiptSchema.parse(JSON.parse(row.receipt)), visibleReceipt };
  }
  putOperation(operationId: string, digest: string, receipt: SerializedOperationReceipt, visibleReceipt?: SerializedOperationReceipt): void {
    this.#db.prepare("INSERT OR REPLACE INTO operations(operation_id,digest,receipt,visible_receipt) VALUES(?,?,?,?)").run(operationId, digest, JSON.stringify(receipt), visibleReceipt === undefined ? null : JSON.stringify(visibleReceipt));
  }
  lookup(operationId: string): OperationLookup {
    const held = this.#db.prepare("SELECT 1 FROM calls JOIN state ON state.key = 'response-lookup:' || json_extract(calls.input, '$.target.hubSessionId') WHERE calls.operation_id = ? AND calls.operation_kind = 'runtime.deliverResponse' AND state.value = 'held' LIMIT 1").get(operationId);
    const found = this.getOperation(operationId);
    if (found === undefined) return { kind: "not_found", absence: "proven_not_executed" };
    const receipt = held === undefined ? found.receipt : found.visibleReceipt ?? found.receipt;
    return { kind: "found", receipt: typedReceipt(validateSerializedOperationReceipt(receipt), JsonValueSchema) };
  }
  recordCall(connector: "execution" | "runtime", operationKind: string, input: JsonObject, operationId?: string, inputDigest?: string): void {
    this.#db.prepare("INSERT INTO calls(connector,operation_kind,operation_id,input_digest,input,recorded_at) VALUES(?,?,?,?,?,?)").run(connector, operationKind, operationId ?? null, inputDigest ?? null, JSON.stringify(input), this.now());
  }
  listCalls(): readonly SimulatorCall[] {
    return this.#db.prepare("SELECT sequence,connector,operation_kind,operation_id,input_digest,input,recorded_at FROM calls ORDER BY sequence").all().map((raw) => {
      const row = CallRowSchema.parse(raw);
      const base = { sequence: row.sequence, connector: row.connector, operationKind: row.operation_kind, input: JsonObjectSchema.parse(JSON.parse(row.input)), recordedAt: row.recorded_at };
      return { ...base, ...(row.operation_id === null ? {} : { operationId: row.operation_id }), ...(row.input_digest === null ? {} : { inputDigest: row.input_digest }) };
    });
  }
  scriptNext(operationKind: string, outcome: ScriptedOutcome): void { this.#db.prepare("INSERT INTO scripts(operation_kind,outcome) VALUES(?,?)").run(operationKind, JSON.stringify(outcome)); }
  takeScript(operationKind: string): ScriptedOutcome | undefined {
    const raw = this.#db.prepare("SELECT id,outcome FROM scripts WHERE operation_kind=? ORDER BY id LIMIT 1").get(operationKind);
    if (raw === undefined) return undefined;
    const row = ScriptRowSchema.parse(raw);
    this.#db.prepare("DELETE FROM scripts WHERE id=?").run(row.id);
    return z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("accepted_waiting"), progress: z.string().optional() }), z.strictObject({ kind: z.literal("unknown_after_effect") }), z.strictObject({ kind: z.literal("definite_failure"), code: z.string().optional() }), z.strictObject({ kind: z.literal("partial_release") })]).parse(JSON.parse(row.outcome));
  }
  setState(key: string, value: string): void { this.#db.prepare("INSERT OR REPLACE INTO state(key,value) VALUES(?,?)").run(key, value); }
  getState(key: string): string | undefined {
    const raw = this.#db.prepare("SELECT value FROM state WHERE key=?").get(key);
    return raw === undefined ? undefined : StateRowSchema.parse(raw).value;
  }
  bindEnvironmentAlias(registrationId: string, providerId: string): void {
    const aliasKey = `environment-alias:${registrationId}`;
    if (this.getState(aliasKey) === providerId) return;
    const pendingState = this.getState(aliasKey) === undefined ? this.getState(`environment:${registrationId}`) : undefined;
    this.setState(aliasKey, providerId);
    if (pendingState === undefined) return;
    this.setState(`environment:${providerId}`, pendingState);
    this.#db.prepare("DELETE FROM state WHERE key=?").run(`environment:${registrationId}`);
  }
  setEnvironment(id: string, value: SimulatedEnvironment): void { this.setState(`environment:${this.getState(`environment-alias:${id}`) ?? id}`, JSON.stringify(value)); }
  getEnvironment(id: string): SimulatedEnvironment {
    const raw = this.getState(`environment:${this.getState(`environment-alias:${id}`) ?? id}`);
    return raw === undefined ? { state: "running", assurance: "immutable", externalActivity: "idle", incarnation: "v1" } : z.strictObject({ state: z.enum(["running", "stopped", "missing", "unknown"]), assurance: z.enum(["immutable", "attested", "weak"]), externalActivity: z.enum(["idle", "active", "unknown"]), incarnation: z.string() }).parse(JSON.parse(raw));
  }
  putAllocation(allocation: AllocationDescriptor): void { this.setState(`allocation:${allocation.allocationRef.id}`, JSON.stringify(allocation)); }
  getAllocation(allocationId: string): AllocationDescriptor | undefined {
    const raw = this.getState(`allocation:${allocationId}`);
    return raw === undefined ? undefined : AllocationDescriptorSchema.parse(JSON.parse(raw));
  }
  putPendingAllocation(operationId: string, context: ActionContext, request: AllocationRequest): void {
    this.setState(`pending-allocation:${operationId}`, JSON.stringify(PendingAllocationSchema.parse({ context, request })));
  }
  getPendingAllocation(operationId: string): { readonly context: ActionContext; readonly request: AllocationRequest } | undefined {
    const raw = this.getState(`pending-allocation:${operationId}`);
    return raw === undefined ? undefined : PendingAllocationSchema.parse(JSON.parse(raw));
  }
  putAttachment(attachmentRef: NativeRef, identity: ResourceIdentity): void { this.setState(`attachment:${attachmentRef.id}`, JSON.stringify({ attachmentRef, identity, detached: false })); }
  getAttachment(attachmentId: string): z.infer<typeof AttachmentStateSchema> | undefined {
    const raw = this.getState(`attachment:${attachmentId}`);
    return raw === undefined ? undefined : AttachmentStateSchema.parse(JSON.parse(raw));
  }
  detachAttachment(attachmentId: string): void {
    const attachment = this.getAttachment(attachmentId);
    if (attachment !== undefined) this.setState(`attachment:${attachmentId}`, JSON.stringify({ ...attachment, detached: true }));
  }
  setRuntimeProfile(profile: RuntimeProfile): void { this.setState("runtime_profile", profile); }
  getRuntimeProfile(): RuntimeProfile { return z.enum(["structured", "limited_bridge"]).parse(this.getState("runtime_profile") ?? "structured"); }
  addOutput(sessionId: string, item: JsonValue): number {
    return this.appendStream(sessionId, "output", item);
  }
  readOutput(sessionId: string, after: number, limit: number): readonly { readonly sequence: number; readonly item: JsonValue }[] {
    return this.#db.prepare("SELECT sequence,item FROM runtime_stream WHERE session_id=? AND kind='output' AND sequence>? ORDER BY sequence LIMIT ?").all(sessionId, after, limit).map((raw) => {
      const row = OutputRowSchema.parse(raw);
      return { sequence: row.sequence, item: JsonValueSchema.parse(JSON.parse(row.item)) };
    });
  }
  addEvent(sessionId: string, event: JsonValue): number {
    return this.appendStream(sessionId, "event", event);
  }
  readEvents(sessionId: string, after: number, limit = 1_000): readonly { readonly sequence: number; readonly event: JsonValue }[] {
    return this.#db.prepare("SELECT sequence,item AS event FROM runtime_stream WHERE session_id=? AND kind='event' AND sequence>? ORDER BY sequence LIMIT ?").all(sessionId, after, limit).map((raw) => {
      const row = EventRowSchema.parse(raw);
      return { sequence: row.sequence, event: JsonValueSchema.parse(JSON.parse(row.event)) };
    });
  }
  readStream(sessionId: string, after: number, limit = 1_000): readonly { readonly sequence: number; readonly kind: "output" | "event"; readonly item: JsonValue }[] {
    return this.#db.prepare("SELECT sequence,kind,item FROM runtime_stream WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(sessionId, after, limit).map((raw) => {
      const row = StreamRowSchema.parse(raw);
      return { sequence: row.sequence, kind: row.kind, item: JsonValueSchema.parse(JSON.parse(row.item)) };
    });
  }
  lastStreamSequence(sessionId: string): number {
    return MaxSequenceRowSchema.parse(this.#db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM runtime_stream WHERE session_id=?").get(sessionId)).sequence;
  }
  private appendStream(sessionId: string, kind: "output" | "event", item: JsonValue): number {
    const row = MaxSequenceRowSchema.parse(this.#db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM runtime_stream WHERE session_id=?").get(sessionId));
    this.#db.prepare("INSERT INTO runtime_stream(session_id,sequence,kind,item) VALUES(?,?,?,?)").run(sessionId, row.sequence, kind, JSON.stringify(item));
    return row.sequence;
  }
  private timestamp(second: number): string { return new Date(Date.UTC(2026, 9, 22, 0, 0, second)).toISOString(); }
}
