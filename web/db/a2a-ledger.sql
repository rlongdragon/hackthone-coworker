-- feat/a2a-ledger migration (P0–P3). Idempotent; apply out-of-band:
--   docker exec -i coworkers-db-1 psql -U coworker -d coworker < db/a2a-ledger.sql

DO $$ BEGIN CREATE TYPE scope_label AS ENUM ('project','team','private','sensitive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE notification_type AS ENUM ('query_allowed','query_denied','task_assigned','message_mention');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE collab_source AS ENUM ('mail','meeting_asr','telegram_group','in_app_chat','manager_dispatch');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- transparent ledger: subject-visible notifications
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  type notification_type NOT NULL,
  scope scope_label,
  purpose text,
  audit_id uuid,
  read_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications (recipient_id, read_at);
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications (created_at);

-- ingestion bones
CREATE TABLE IF NOT EXISTS collab_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type collab_source NOT NULL,
  source_id text,
  scope_label scope_label NOT NULL,
  created_by uuid REFERENCES employees(id) ON DELETE SET NULL,
  content_hash text,
  is_tainted boolean NOT NULL DEFAULT false,
  extracted_data jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS collab_events_source_idx ON collab_events (source_type);
CREATE INDEX IF NOT EXISTS collab_events_scope_idx ON collab_events (scope_label);

-- audit_log doubles as the A2A ledger
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES employees(id);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS query_scope scope_label;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS query_allowed boolean;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS denied_fields jsonb;

-- memory ↔ collab event lineage + field taint
ALTER TABLE memories ADD COLUMN IF NOT EXISTS collab_event_id uuid;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS tainted_source_fields jsonb;

-- manager dispatch (P4-lite)
ALTER TABLE todos ADD COLUMN IF NOT EXISTS assigned_by uuid REFERENCES employees(id);
ALTER TABLE todos ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'assigned';

-- meeting records: link collab events to a project + keep the raw artefact
ALTER TABLE collab_events ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE collab_events ADD COLUMN IF NOT EXISTS content text;
CREATE INDEX IF NOT EXISTS collab_events_project_idx ON collab_events (project_id);

-- Telegram group digest: persisted messages (opt-in groups only)
CREATE TABLE IF NOT EXISTS telegram_group_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
  sender_name text NOT NULL,
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  text text NOT NULL,
  sent_at timestamp NOT NULL DEFAULT now(),
  digested_event_id uuid
);
CREATE INDEX IF NOT EXISTS tg_group_msgs_chat_time_idx ON telegram_group_messages (chat_id, sent_at);

-- P4: in-app channels (SSE)
CREATE TABLE IF NOT EXISTS channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'general',
  created_by uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channels_project_name_uq ON channels (project_id, name);
CREATE TABLE IF NOT EXISTS channel_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  author_type text NOT NULL DEFAULT 'user',
  content text NOT NULL,
  mentions jsonb,
  reply_to_id uuid,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channel_messages_channel_time_idx ON channel_messages (channel_id, created_at);

-- P4: per-employee mailbox (IMAP/SMTP self-auth; password in tool_secrets)
CREATE TABLE IF NOT EXISTS email_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  from_address text NOT NULL,
  username text NOT NULL,
  imap_host text NOT NULL,
  imap_port integer NOT NULL DEFAULT 993,
  imap_secure boolean NOT NULL DEFAULT true,
  smtp_host text NOT NULL,
  smtp_port integer NOT NULL DEFAULT 587,
  smtp_secure boolean NOT NULL DEFAULT false,
  enabled_at timestamp NOT NULL DEFAULT now(),
  disabled_at timestamp,
  last_sync_at timestamp,
  last_uid integer NOT NULL DEFAULT 0
);

-- dispatch consent notifications
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'dispatch_consent';
