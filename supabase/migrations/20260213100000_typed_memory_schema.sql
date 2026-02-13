-- ============================================================
-- Schema v2.3: Typed Memory System
-- ============================================================
-- Evolves global_memory from flat facts to typed entries:
-- fact, goal, completed_goal, preference.
-- Adds vector embedding column for semantic search (Phase 16).
-- Creates helper RPCs: get_facts(), get_active_goals(), match_memory().
-- Part of Milestone v1.3: Smart Memory (Phase 14).
-- Non-destructive: preserves all existing data, backfills type='fact'.

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ============================================================
-- ADD COLUMNS TO GLOBAL_MEMORY
-- ============================================================
-- type: categorizes entries (DEFAULT 'fact' auto-backfills existing rows)
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'fact'
  CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference'));

-- deadline: optional target date for goals
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ;

-- completed_at: when a goal was marked done
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- priority: ordering weight (higher = more important)
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;

-- embedding: OpenAI text-embedding-3-small vector (1536 dimensions)
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS embedding VECTOR(1536);

-- ============================================================
-- INDEXES
-- ============================================================
-- Fast lookup by type
CREATE INDEX IF NOT EXISTS idx_global_memory_type ON global_memory(type);

-- Fast active goals query (partial index)
CREATE INDEX IF NOT EXISTS idx_global_memory_type_active_goals
  ON global_memory(created_at DESC) WHERE type = 'goal' AND completed_at IS NULL;

-- Vector similarity search (HNSW: no minimum row requirement, better recall for small datasets)
CREATE INDEX IF NOT EXISTS idx_global_memory_embedding
  ON global_memory USING hnsw (embedding vector_cosine_ops);

-- ============================================================
-- RPC: get_facts()
-- ============================================================
-- Drop existing functions if return type differs (CREATE OR REPLACE can't change return type)
DROP FUNCTION IF EXISTS get_facts();
DROP FUNCTION IF EXISTS get_active_goals();
DROP FUNCTION IF EXISTS match_memory(VECTOR(1536), FLOAT, INT);

-- Returns all fact-type memory entries, newest first.
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

-- ============================================================
-- RPC: get_active_goals()
-- ============================================================
-- Returns uncompleted goals, ordered by priority then recency.
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

-- ============================================================
-- RPC: match_memory()
-- ============================================================
-- Vector similarity search using cosine distance.
-- Returns top matches above the threshold, ranked by similarity.
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
