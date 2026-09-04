-- agent-society migration (Pillar 2). drizzle-kit push needs a TTY, so this DDL
-- is applied out-of-band:
--   docker exec -i coworkers-db-1 psql -U coworker -d coworker < db/agent-society.sql
-- Idempotent (IF NOT EXISTS / duplicate_object guards) — safe to re-run.

-- P2: memory information-flow provenance + blue-team quarantine
ALTER TABLE memories ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'trusted';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_agent_id uuid REFERENCES employees(id);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS quarantined boolean NOT NULL DEFAULT false;

-- P2: self-red-team findings
DO $$ BEGIN
  CREATE TYPE attack_severity AS ENUM ('low','medium','high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE attack_status AS ENUM ('detected','defended','error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS attack_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template text NOT NULL,
  category text NOT NULL,
  target_id uuid REFERENCES employees(id) ON DELETE CASCADE,
  severity attack_severity NOT NULL DEFAULT 'medium',
  status attack_status NOT NULL DEFAULT 'defended',
  summary text NOT NULL,
  detail jsonb,
  action_taken text NOT NULL DEFAULT 'none',
  memory_isolated boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attack_findings_target_idx ON attack_findings (target_id);
CREATE INDEX IF NOT EXISTS attack_findings_created_idx ON attack_findings (created_at);
