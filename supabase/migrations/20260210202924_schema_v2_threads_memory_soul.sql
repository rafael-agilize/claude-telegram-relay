-- ============================================================
-- Supabase Schema v2: Threaded Conversations & Memory System
-- ============================================================
-- Run this in Supabase SQL Editor.
-- This replaces v1 schema. Old tables (messages, memory) are left
-- in place but the relay no longer writes to them.

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
-- GLOBAL MEMORY TABLE (Cross-thread learned facts)
-- ============================================================
-- Bot-managed: Claude decides what to [LEARN:] and [FORGET:]
-- Snippets must be very concise to avoid context bloat.
CREATE TABLE IF NOT EXISTS global_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  content TEXT NOT NULL,                -- Concise fact (1-2 sentences max)
  source_thread_id UUID REFERENCES threads(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_global_memory_created ON global_memory(created_at DESC);

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
ALTER TABLE logs_v2 ENABLE ROW LEVEL SECURITY;

-- Allow all for service role (bot uses service key)
CREATE POLICY "service_all" ON threads FOR ALL USING (true);
CREATE POLICY "service_all" ON thread_messages FOR ALL USING (true);
CREATE POLICY "service_all" ON global_memory FOR ALL USING (true);
CREATE POLICY "service_all" ON bot_soul FOR ALL USING (true);
CREATE POLICY "service_all" ON logs_v2 FOR ALL USING (true);

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
