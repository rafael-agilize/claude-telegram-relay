-- ============================================================
-- Supabase Schema v2: Threaded Conversations & Memory System
-- ============================================================
-- Run this in Supabase SQL Editor.
-- This replaces v1 schema. Old tables (messages, memory) are left
-- in place but the relay no longer writes to them.

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ============================================================
-- THREADS TABLE (Conversation channels)
-- ============================================================
-- Each Telegram forum topic or DM gets one row.
CREATE TABLE IF NOT EXISTS threads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  telegram_chat_id BIGINT NOT NULL,
  telegram_thread_id INTEGER,           -- NULL for DMs
  claude_session_id TEXT,               -- Claude CLI session UUID for --resume
  title TEXT,                           -- Topic title or "DM"
  summary TEXT DEFAULT '',              -- Auto-generated thread summary
  message_count INTEGER DEFAULT 0,      -- Track exchanges for summary triggers
  UNIQUE(telegram_chat_id, telegram_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_threads_chat ON threads(telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_threads_lookup ON threads(telegram_chat_id, telegram_thread_id);

-- ============================================================
-- THREAD MESSAGES TABLE (Per-thread conversation history)
-- ============================================================
CREATE TABLE IF NOT EXISTS thread_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id, created_at DESC);

-- ============================================================
-- GLOBAL MEMORY TABLE (Cross-thread typed memory: facts, goals, preferences)
-- ============================================================
-- Bot-managed: Claude decides what to [REMEMBER:] and [FORGET:]
-- Snippets must be very concise to avoid context bloat.
CREATE TABLE IF NOT EXISTS global_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  content TEXT NOT NULL,                -- Concise entry (1-2 sentences max)
  type TEXT NOT NULL DEFAULT 'fact'     -- fact, goal, completed_goal, preference
    CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference')),
  deadline TIMESTAMPTZ,                 -- Optional deadline for goals
  completed_at TIMESTAMPTZ,            -- When a goal was completed
  priority INTEGER DEFAULT 0,          -- Priority ordering (higher = more important)
  embedding VECTOR(1536),              -- OpenAI text-embedding-3-small vector
  source_thread_id UUID REFERENCES threads(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_global_memory_created ON global_memory(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_global_memory_type ON global_memory(type);
CREATE INDEX IF NOT EXISTS idx_global_memory_type_active_goals
  ON global_memory(created_at DESC) WHERE type = 'goal' AND completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_global_memory_embedding
  ON global_memory USING hnsw (embedding vector_cosine_ops);

-- ============================================================
-- BOT SOUL TABLE (Personality definition)
-- ============================================================
-- Single active row. Set via /soul command in Telegram.
CREATE TABLE IF NOT EXISTS bot_soul (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  content TEXT NOT NULL,                -- The personality prompt
  is_active BOOLEAN DEFAULT true
);

-- Insert default soul
INSERT INTO bot_soul (content, is_active)
VALUES ('You are a helpful, concise assistant responding via Telegram.', true)
ON CONFLICT DO NOTHING;

-- ============================================================
-- SOUL VERSIONS TABLE (Three-layer compressed soul for evolution)
-- ============================================================
-- Stores versioned snapshots of the bot's personality.
-- Three layers balance depth vs token efficiency:
--   Layer 1 (core_identity): Who I am (~200 tokens, stable)
--   Layer 2 (active_values): What I care about now (~300 tokens)
--   Layer 3 (recent_growth): What I learned recently (~300 tokens)
CREATE TABLE IF NOT EXISTS soul_versions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  version INTEGER NOT NULL,
  core_identity TEXT NOT NULL,        -- Layer 1: Who I am (stable, ~200 tokens)
  active_values TEXT NOT NULL,        -- Layer 2: What I care about now (~300 tokens)
  recent_growth TEXT NOT NULL,        -- Layer 3: What I learned recently (~300 tokens)
  reflection_notes TEXT,              -- Uncompressed journal entry (not loaded into prompt)
  token_count INTEGER NOT NULL DEFAULT 0,  -- Actual token count of L1+L2+L3 combined
  UNIQUE(version)
);

CREATE INDEX IF NOT EXISTS idx_soul_versions_created ON soul_versions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soul_versions_version ON soul_versions(version DESC);

-- ============================================================
-- SOUL MILESTONES TABLE (Formative events that anchor personality)
-- ============================================================
-- Stores key moments that shaped the bot's personality evolution.
-- Prevents drift by preserving lessons learned from significant events.
CREATE TABLE IF NOT EXISTS soul_milestones (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  event_description TEXT NOT NULL,
  emotional_weight TEXT NOT NULL DEFAULT 'meaningful'
    CHECK (emotional_weight IN ('formative', 'meaningful', 'challenging')),
  lesson_learned TEXT NOT NULL,
  source_thread_id UUID REFERENCES threads(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_soul_milestones_created ON soul_milestones(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soul_milestones_weight ON soul_milestones(emotional_weight);

-- ============================================================
-- LOGS TABLE (Observability - updated with thread_id)
-- ============================================================
CREATE TABLE IF NOT EXISTS logs_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  level TEXT DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event TEXT NOT NULL,
  message TEXT,
  metadata JSONB DEFAULT '{}',
  thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_logs_v2_created ON logs_v2(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_v2_level ON logs_v2(level);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_soul ENABLE ROW LEVEL SECURITY;
ALTER TABLE soul_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE soul_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs_v2 ENABLE ROW LEVEL SECURITY;

-- Allow all for service role ONLY (bot uses service key)
-- IMPORTANT: These policies restrict anon access. Only the service_role
-- (used by the relay via SUPABASE_SERVICE_KEY) can access data.
CREATE POLICY "service_role_all" ON threads FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON thread_messages FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON global_memory FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON bot_soul FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON soul_versions FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON soul_milestones FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON logs_v2 FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Get or create a thread for a given chat/thread combo
CREATE OR REPLACE FUNCTION get_or_create_thread(
  p_chat_id BIGINT,
  p_thread_id INTEGER DEFAULT NULL,
  p_title TEXT DEFAULT 'DM'
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM threads
  WHERE telegram_chat_id = p_chat_id
    AND (telegram_thread_id = p_thread_id OR (telegram_thread_id IS NULL AND p_thread_id IS NULL));

  IF v_id IS NULL THEN
    INSERT INTO threads (telegram_chat_id, telegram_thread_id, title)
    VALUES (p_chat_id, p_thread_id, p_title)
    RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Get recent messages for a thread
CREATE OR REPLACE FUNCTION get_thread_messages(
  p_thread_id UUID,
  p_limit INTEGER DEFAULT 5
)
RETURNS TABLE (
  role TEXT,
  content TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT tm.role, tm.content, tm.created_at
  FROM thread_messages tm
  WHERE tm.thread_id = p_thread_id
  ORDER BY tm.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Atomic increment for message count (avoids TOCTOU race)
CREATE OR REPLACE FUNCTION increment_thread_message_count(p_thread_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE threads
  SET message_count = message_count + 1
  WHERE id = p_thread_id
  RETURNING message_count INTO v_count;
  RETURN COALESCE(v_count, 0);
END;
$$ LANGUAGE plpgsql;

-- Get active soul
CREATE OR REPLACE FUNCTION get_active_soul()
RETURNS TEXT AS $$
DECLARE
  v_content TEXT;
BEGIN
  SELECT bs.content INTO v_content FROM bot_soul bs
  WHERE bs.is_active = true
  ORDER BY bs.updated_at DESC
  LIMIT 1;

  RETURN COALESCE(v_content, 'You are a helpful, concise assistant responding via Telegram.');
END;
$$ LANGUAGE plpgsql;

-- Get all fact-type memory entries
CREATE OR REPLACE FUNCTION get_facts()
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  content TEXT,
  source_thread_id UUID
) AS $$
BEGIN
  RETURN QUERY
  SELECT gm.id, gm.created_at, gm.content, gm.source_thread_id
  FROM global_memory gm
  WHERE gm.type = 'fact'
  ORDER BY gm.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Get uncompleted goals, ordered by priority then recency
CREATE OR REPLACE FUNCTION get_active_goals()
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  content TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER,
  source_thread_id UUID
) AS $$
BEGIN
  RETURN QUERY
  SELECT gm.id, gm.created_at, gm.content, gm.deadline, gm.priority, gm.source_thread_id
  FROM global_memory gm
  WHERE gm.type = 'goal' AND gm.completed_at IS NULL
  ORDER BY gm.priority DESC NULLS LAST, gm.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Vector similarity search using cosine distance
CREATE OR REPLACE FUNCTION match_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.type,
    1 - (gm.embedding <=> query_embedding) AS similarity
  FROM global_memory gm
  WHERE gm.embedding IS NOT NULL
    AND 1 - (gm.embedding <=> query_embedding) > match_threshold
  ORDER BY gm.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- CRON JOBS TABLE (v1.1: Heartbeat & Proactive Agent)
-- ============================================================
CREATE TABLE IF NOT EXISTS cron_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  schedule_type TEXT NOT NULL DEFAULT 'cron' CHECK (schedule_type IN ('cron', 'interval', 'once')),
  prompt TEXT NOT NULL,
  target_thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
  enabled BOOLEAN DEFAULT true,
  source TEXT DEFAULT 'user' CHECK (source IN ('user', 'agent', 'file')),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at) WHERE enabled = true;

-- ============================================================
-- HEARTBEAT CONFIG TABLE (v1.1: Heartbeat & Proactive Agent)
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

INSERT INTO heartbeat_config (interval_minutes, active_hours_start, active_hours_end, timezone, enabled)
VALUES (60, '08:00', '22:00', 'America/Sao_Paulo', true);

ALTER TABLE cron_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE heartbeat_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON cron_jobs FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON heartbeat_config FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- SEMANTIC SEARCH SETUP (v1.3 Phase 16)
-- ============================================================
-- The embedding column and match_memory() RPC are defined above.
-- To enable auto-embedding, configure a Database Webhook:
--   1. Deploy the embed Edge Function: supabase functions deploy embed
--   2. In Supabase Dashboard: Database > Webhooks > Create
--      - Name: embed_memory
--      - Table: global_memory
--      - Events: INSERT
--      - Type: Supabase Edge Function
--      - Function: embed
--   3. Set the OPENAI_API_KEY secret: supabase secrets set OPENAI_API_KEY=sk-...
--   4. Deploy the search Edge Function: supabase functions deploy search
--
-- See docs/SETUP-SEMANTIC-SEARCH.md for full instructions.
