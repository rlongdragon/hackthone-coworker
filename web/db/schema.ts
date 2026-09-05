import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  boolean,
  integer,
  doublePrecision,
  jsonb,
  vector,
  pgEnum,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Embedding dimension — match the local embedding model
// (384 = Xenova/multilingual-e5-small via transformers.js, self-hosted in-process).
export const EMBED_DIM = 384;

export const roleEnum = pgEnum("role", ["employee", "manager", "admin"]);

export const departments = pgTable("departments", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Employees = users (auth + org identity)
export const employees = pgTable("employees", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull().default("employee"),
  departmentId: uuid("department_id").references(() => departments.id),
  // Company-issued accounts start with a temp password; force change on first login.
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  // FR-P-08 P3: deactivated (departed) accounts can't log in or run the agent.
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const projectStatusEnum = pgEnum("project_status", ["active", "archived"]);

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: projectStatusEnum("status").notNull().default("active"),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => employees.id),
  departmentId: uuid("department_id").references(() => departments.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    memberRole: text("member_role").notNull().default("member"), // owner | member
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.employeeId] }),
    index("project_members_emp_idx").on(t.employeeId),
  ],
);

export const todos = pgTable(
  "todos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    due: timestamp("due"),
    done: boolean("done").notNull().default(false),
    // set when a handover reassigned this row — lets a second-stage handover
    // forward exactly the parked items, never the custodian's own work
    handoverId: uuid("handover_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("todos_emp_idx").on(t.employeeId)],
);

// FR-P-01: personal work memory with semantic (vector) retrieval.
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("context"), // history | preference | context
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBED_DIM }),
    // FR-P-08: set on rows copied in by a handover (provenance + rollback key).
    sourceEmployeeId: uuid("source_employee_id").references(() => employees.id),
    handoverId: uuid("handover_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("memories_emb_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // AI SDK chat id (one per assistant-ui thread) — the client-side thread
    // key. Client-chosen, so uniqueness is per employee, never global.
    chatId: text("chat_id"),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    // Set when the thread was opened inside a project (project-scoped chat).
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    title: text("title"),
    // Which channel opened the thread: web | telegram.
    channel: text("channel").notNull().default("web"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("conversations_emp_chat_idx").on(t.employeeId, t.chatId),
    index("conversations_emp_idx").on(t.employeeId),
  ],
);

// Telegram account binding (channel identity → employee). Identity checks use
// the numeric Telegram user id only — usernames are mutable display sugar.
export const telegramLinks = pgTable("telegram_links", {
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).primaryKey(),
  employeeId: uuid("employee_id")
    .notNull()
    .unique()
    .references(() => employees.id, { onDelete: "cascade" }),
  // /new bumps this; the DM's rolling thread key is derived from it.
  threadSeq: integer("thread_seq").notNull().default(0),
  // Proactive pushes (daily briefing, due cards, approvals); /notify_off clears.
  notify: boolean("notify").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Telegram group mode: a group chat bound to a project or department by an
// admin (/authorize). Triggering inside requires the speaker to be linked AND
// a member of the bound project/department — group access is never authority.
export const telegramGroups = pgTable("telegram_groups", {
  chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
  title: text("title"),
  kind: text("kind").notNull(), // project | department
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  departmentId: uuid("department_id").references(() => departments.id, {
    onDelete: "cascade",
  }),
  // Rolling group-context buffer is per-group opt-in (privacy: off = the
  // worker discards non-trigger messages on sight).
  contextOptin: boolean("context_optin").notNull().default(false),
  authorizedBy: uuid("authorized_by")
    .notNull()
    .references(() => employees.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// FR-P-08 交接傳承: package one employee's agent-accumulated context and hand
// it to a successor, under approval. Copies, never moves — handover_id tags
// every copied row so a failed run rolls back clean.
export const handovers = pgTable("handovers", {
  id: uuid("id").defaultRandom().primaryKey(),
  fromEmployeeId: uuid("from_employee_id")
    .notNull()
    .references(() => employees.id),
  toEmployeeId: uuid("to_employee_id")
    .notNull()
    .references(() => employees.id),
  scope: text("scope").notNull().default("all"), // all | project
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  include: jsonb("include").notNull().default({}), // {memories,skills,cards,todos,events}
  // pending | approved | running | completed | rejected | failed
  status: text("status").notNull().default("pending"),
  summary: text("summary"), // FR-P-09 position report (generated on completion)
  error: text("error"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => employees.id),
  approvedBy: uuid("approved_by").references(() => employees.id),
  // v2-D 職位暫存: to-employee is a custodian holding the package until the
  // real successor is hired; a second-stage handover then references this row.
  custodial: boolean("custodial").notNull().default(false),
  parentHandoverId: uuid("parent_handover_id"),
  // v2-B knowledge-gap analysis: coverage score 0-100 + uncovered topics.
  gapScore: integer("gap_score"),
  gapReport: jsonb("gap_report"),
  // v2-C: successor may route questions to the leaver until this deadline.
  graceUntil: timestamp("grace_until"),
  // v2-F: 30-day follow-up with the successor, done once.
  followupDone: boolean("followup_done").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

// v2-A/C/F — interview & follow-up questions addressed to the leaver.
// kind 'gap': generated by gap analysis (訪談題); kind 'successor': asked by
// the successor (追問通道 / 滿月回顧). Answering writes a memory; if the
// handover is already completed the answer is also copied to the successor.
export const handoverQuestions = pgTable("handover_questions", {
  id: uuid("id").defaultRandom().primaryKey(),
  handoverId: uuid("handover_id")
    .notNull()
    .references(() => handovers.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("gap"), // gap | successor
  question: text("question").notNull(),
  answer: text("answer"),
  askedBy: uuid("asked_by").references(() => employees.id),
  answeredAt: timestamp("answered_at"),
  memoryId: uuid("memory_id"),
  // Telegram delivery: the DM message id sent to the leaver — replying to
  // that message answers the question (works after account deactivation).
  tgMessageId: bigint("tg_message_id", { mode: "number" }),
  tgPushedAt: timestamp("tg_pushed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// One-time codes for the /link flow (issued by the web app, consumed by the
// telegram worker — separate processes, so these must live in the DB).
export const telegramLinkCodes = pgTable("telegram_link_codes", {
  code: text("code").primaryKey(),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
});

// Chat history stored as JSONB (AI SDK UIMessage parts). One row per message.
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant | system
    parts: jsonb("parts").notNull(), // AI SDK message parts
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("messages_conv_idx").on(t.conversationId)],
);

// Kanban board: user-definable status columns per project.
export const projectColumns = pgTable(
  "project_columns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("project_columns_proj_idx").on(t.projectId)],
);

// Kanban cards. `position` is a float for cheap fractional reordering.
export const cards = pgTable(
  "cards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    columnId: uuid("column_id")
      .notNull()
      .references(() => projectColumns.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    assigneeId: uuid("assignee_id").references(() => employees.id, {
      onDelete: "set null",
    }),
    handoverId: uuid("handover_id"), // provenance of a handover reassignment
    position: doublePrecision("position").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("cards_proj_idx").on(t.projectId),
    index("cards_col_idx").on(t.columnId),
  ],
);

// Files attached to a project. Bytes live on local disk (UPLOAD_DIR) under
// the row id — self-hosted, no object-store dependency.
export const projectFiles = pgTable(
  "project_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    uploaderId: uuid("uploader_id")
      .notNull()
      .references(() => employees.id),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("project_files_proj_idx").on(t.projectId)],
);

// Files the agent produces in its sandbox and hands back to the employee for
// download in the chat (deliverFileToChat). Scoped to the conversation +
// employee; disk bytes keyed by id, same as project files.
export const chatFiles = pgTable(
  "chat_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("chat_files_emp_idx").on(t.employeeId)],
);

// Shared tool library. One registry, two kinds:
//   skill  — a script run inside the employee's sandbox (no side effects beyond it)
//   action — a server-side HTTP call with a dept-scoped secret (real side effects)
// Visible at three scopes: personal (own), department (same dept), org (everyone).
export const toolKindEnum = pgEnum("tool_kind", ["skill", "action"]);
export const toolScopeEnum = pgEnum("tool_scope", ["personal", "department", "org"]);

export const tools = pgTable(
  "tools",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(), // agent-facing identifier, snake_case
    description: text("description").notNull(),
    kind: toolKindEnum("kind").notNull(),
    scope: toolScopeEnum("scope").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => departments.id, {
      onDelete: "cascade",
    }), // required when scope = department
    lang: text("lang"), // skill: 'bash' | 'python'
    body: text("body"), // skill: script source
    // action: { method, url, headers, body, params:[{name,required,desc}], secretName, sensitive }
    spec: jsonb("spec"),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("tools_scope_idx").on(t.scope),
    index("tools_dept_idx").on(t.departmentId),
    index("tools_owner_idx").on(t.ownerId),
  ],
);

// Encrypted secrets referenced by action tools (e.g. a department git token).
// Value is AES-256-GCM; the plaintext never reaches the sandbox or the model.
export const toolSecrets = pgTable(
  "tool_secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: toolScopeEnum("scope").notNull(),
    departmentId: uuid("department_id").references(() => departments.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => employees.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("tool_secrets_dept_idx").on(t.departmentId)],
);

// ---- MCP (Model Context Protocol) integration ------------------------------
export const mcpTransportEnum = pgEnum("mcp_transport", ["stdio", "http"]);
export const mcpSourceEnum = pgEnum("mcp_source", ["manual", "repo"]);
export const mcpHealthEnum = pgEnum("mcp_health", ["unknown", "ok", "down"]);
// auto = run silently; hitl = park for approval; blocked = never merged.
export const mcpPolicyEnum = pgEnum("mcp_policy", ["auto", "hitl", "blocked"]);
export const mcpRiskEnum = pgEnum("mcp_risk", ["low", "medium", "high"]);

// An external MCP server the agent may draw tools from. Scope reuses the tool
// library's visibility model (personal/department/org). Secrets (auth tokens,
// stdio env) live in tool_secrets keyed `mcp/<serverId>/<KEY>` — never here.
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    scope: toolScopeEnum("scope").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => departments.id, {
      onDelete: "cascade",
    }),
    transport: mcpTransportEnum("transport").notNull(),
    url: text("url"), // http transport
    command: text("command"), // stdio transport
    args: jsonb("args").$type<string[]>(), // stdio argv
    source: mcpSourceEnum("source").notNull().default("manual"),
    repoUrl: text("repo_url"), // P3: source repo
    repoCommit: text("repo_commit"), // pinned commit hash
    enabled: boolean("enabled").default(false).notNull(),
    healthStatus: mcpHealthEnum("health_status").default("unknown").notNull(),
    lastCheckAt: timestamp("last_check_at"),
    failCount: integer("fail_count").default(0).notNull(),
    auditReport: jsonb("audit_report"), // { summary, overallRisk, scan:[...] }
    lastAuditAt: timestamp("last_audit_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => employees.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("mcp_servers_scope_idx").on(t.scope),
    index("mcp_servers_owner_idx").on(t.ownerId),
    index("mcp_servers_dept_idx").on(t.departmentId),
  ],
);

// Per-tool policy + rug-pull pin. descHash is the SHA-256 of the tool's
// description+schema at approval time; a live mismatch at run time means the
// server changed its surface after approval → auto-downgrade to hitl.
export const mcpTools = pgTable(
  "mcp_tools",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    inputSchema: jsonb("input_schema"),
    policy: mcpPolicyEnum("policy").notNull().default("hitl"),
    risk: mcpRiskEnum("risk").notNull().default("medium"),
    flags: jsonb("flags").$type<string[]>(), // deterministic-scan + audit flags
    descHash: text("desc_hash").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    lastSeenAt: timestamp("last_seen_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("mcp_tools_server_idx").on(t.serverId),
    uniqueIndex("mcp_tools_server_name_uq").on(t.serverId, t.name),
  ],
);

// Calendar events. `source`/`externalUid` reserve room for CalDAV/ICS sync
// with the company mail account (self-hosted friendly) — sync itself is TODO.
export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    source: text("source").notNull().default("local"), // local | caldav | ics
    externalUid: text("external_uid"),
    handoverId: uuid("handover_id"), // provenance of a handover reassignment
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("events_emp_time_idx").on(t.employeeId, t.startsAt)],
);

// Notes attached to an event — by the employee or by the AI on their behalf.
export const eventNotes = pgTable(
  "event_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => employees.id),
    authorType: text("author_type").notNull().default("user"), // user | ai
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("event_notes_event_idx").on(t.eventId)],
);

// Human-in-the-loop gate: sensitive agent tools park their intent here and
// only run after the user explicitly approves (fresh session + role check at
// execution time). status: pending | approved | rejected | expired.
export const pendingActions = pgTable(
  "pending_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    params: jsonb("params").notNull(),
    status: text("status").notNull().default("pending"),
    result: jsonb("result"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (t) => [index("pending_actions_req_idx").on(t.requesterId, t.status)],
);

// NFR-AUDITABILITY: every meaningful action logged.
export const auditLog = pgTable("audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  employeeId: uuid("employee_id").references(() => employees.id),
  action: text("action").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
