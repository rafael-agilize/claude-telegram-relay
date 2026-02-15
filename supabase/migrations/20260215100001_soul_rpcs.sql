-- ============================================================
-- Soul Version & Milestone RPCs
-- ============================================================
-- Part of Milestone v1.4: Soul Evolution (Phase 17)
-- Creates 5 RPCs for soul version and milestone moment CRUD operations.
-- These are the API that Phase 18 (prompt integration) and Phase 19
-- (daily evolution engine) will call from relay.ts.

-- ============================================================
-- RPC: get_current_soul()
-- ============================================================
-- Returns the latest soul version (highest version number).
-- Used to load the 3-layer soul into every prompt.
DROP FUNCTION IF EXISTS get_current_soul();

CREATE OR REPLACE FUNCTION get_current_soul()
RETURNS TABLE (
  id UUID,
  version INTEGER,
  core_identity TEXT,
  active_values TEXT,
  recent_growth TEXT,
  reflection_notes TEXT,
  token_count INTEGER,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT sv.id, sv.version, sv.core_identity, sv.active_values,
         sv.recent_growth, sv.reflection_notes, sv.token_count, sv.created_at
  FROM soul_versions sv
  ORDER BY sv.version DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: save_soul_version()
-- ============================================================
-- Inserts a new soul version with auto-incremented version number.
-- Returns the new version number.
-- Used by the daily evolution engine to persist evolved souls.
DROP FUNCTION IF EXISTS save_soul_version(TEXT, TEXT, TEXT, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION save_soul_version(
  p_core_identity TEXT,
  p_active_values TEXT,
  p_recent_growth TEXT,
  p_reflection_notes TEXT DEFAULT NULL,
  p_token_count INTEGER DEFAULT 0
)
RETURNS INTEGER AS $$
DECLARE
  v_next_version INTEGER;
BEGIN
  SELECT COALESCE(MAX(version), -1) + 1 INTO v_next_version FROM soul_versions;

  INSERT INTO soul_versions (version, core_identity, active_values, recent_growth, reflection_notes, token_count)
  VALUES (v_next_version, p_core_identity, p_active_values, p_recent_growth, p_reflection_notes, p_token_count);

  RETURN v_next_version;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: get_soul_history()
-- ============================================================
-- Returns recent soul versions for evolution context.
-- Excludes reflection_notes to keep query lightweight (large text not needed).
-- Default limit: 7 versions (one week of daily evolution).
DROP FUNCTION IF EXISTS get_soul_history(INTEGER);

CREATE OR REPLACE FUNCTION get_soul_history(
  p_limit INTEGER DEFAULT 7
)
RETURNS TABLE (
  id UUID,
  version INTEGER,
  core_identity TEXT,
  active_values TEXT,
  recent_growth TEXT,
  token_count INTEGER,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT sv.id, sv.version, sv.core_identity, sv.active_values,
         sv.recent_growth, sv.token_count, sv.created_at
  FROM soul_versions sv
  ORDER BY sv.version DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: save_milestone_moment()
-- ============================================================
-- Inserts a milestone moment with emotional weight and lesson learned.
-- Returns the UUID of the created row.
-- Used by Claude via [MILESTONE:] intent tag to record formative events.
DROP FUNCTION IF EXISTS save_milestone_moment(TEXT, TEXT, TEXT, UUID);

CREATE OR REPLACE FUNCTION save_milestone_moment(
  p_event_description TEXT,
  p_emotional_weight TEXT DEFAULT 'meaningful',
  p_lesson_learned TEXT DEFAULT '',
  p_source_thread_id UUID DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO soul_milestones (event_description, emotional_weight, lesson_learned, source_thread_id)
  VALUES (p_event_description, p_emotional_weight, p_lesson_learned, p_source_thread_id)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: get_milestone_moments()
-- ============================================================
-- Returns milestone moments for evolution context.
-- Ordered by recency (created_at DESC).
-- Default limit: 10 milestones.
DROP FUNCTION IF EXISTS get_milestone_moments(INTEGER);

CREATE OR REPLACE FUNCTION get_milestone_moments(
  p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  event_description TEXT,
  emotional_weight TEXT,
  lesson_learned TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT sm.id, sm.event_description, sm.emotional_weight,
         sm.lesson_learned, sm.created_at
  FROM soul_milestones sm
  ORDER BY sm.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
