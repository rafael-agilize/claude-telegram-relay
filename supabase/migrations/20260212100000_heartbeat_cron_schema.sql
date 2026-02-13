-- ============================================================
-- Schema v2.1: Heartbeat & Cron Infrastructure
-- ============================================================
-- Adds tables for heartbeat configuration and cron job storage.
-- Part of Milestone v1.1: Heartbeat & Proactive Agent.

-- ============================================================
-- CRON JOBS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS cron_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,                    -- Cron expression ("0 7 * * *") or interval ("every 2h") or one-shot ("in 20m")
  schedule_type TEXT NOT NULL DEFAULT 'cron' CHECK (schedule_type IN ('cron', 'interval', 'once')),
  prompt TEXT NOT NULL,                      -- What to tell Claude
  target_thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
  enabled BOOLEAN DEFAULT true,
  source TEXT DEFAULT 'user' CHECK (source IN ('user', 'agent')),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at) WHERE enabled = true;

-- ============================================================
-- HEARTBEAT CONFIG TABLE (single-row config)
-- ============================================================
CREATE TABLE IF NOT EXISTS heartbeat_config (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  active_hours_start TEXT NOT NULL DEFAULT '08:00',
  active_hours_end TEXT NOT NULL DEFAULT '22:00',
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  enabled BOOLEAN DEFAULT true
);

-- Insert default config row
INSERT INTO heartbeat_config (interval_minutes, active_hours_start, active_hours_end, timezone, enabled)
VALUES (60, '08:00', '22:00', 'America/Sao_Paulo', true);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE cron_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE heartbeat_config ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "service_role_all" ON cron_jobs FOR ALL
    TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "service_role_all" ON heartbeat_config FOR ALL
    TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
