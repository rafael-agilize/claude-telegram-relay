-- ============================================================
-- Schema v2.4: Soul Versions & Milestone Moments
-- ============================================================
-- Three-layer soul versioning system for personality evolution.
-- soul_versions: Daily snapshots of compressed soul (core_identity,
--   active_values, recent_growth) with reflection notes.
-- soul_milestones: Formative events that anchor personality growth.
-- Part of Milestone v1.4: Soul Evolution (Phase 17).

-- ============================================================
-- SOUL VERSIONS TABLE
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
-- SOUL MILESTONES TABLE
-- ============================================================
-- Stores formative events that anchor personality evolution.
-- Prevents drift by preserving key moments that shaped the bot.
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
-- SEED MIGRATION: Preserve current bot_soul as version 0
-- ============================================================
-- Copy the active bot_soul content into soul_versions as version 0.
-- This seeds Layer 1 (core_identity) from the existing personality.
-- active_values and recent_growth start empty — the daily evolution
-- engine (Phase 19) will populate them.
INSERT INTO soul_versions (version, core_identity, active_values, recent_growth, reflection_notes, token_count)
SELECT
  0,
  bs.content,
  '',
  '',
  'Seed from original bot_soul at migration time',
  0
FROM bot_soul bs
WHERE bs.is_active = true
ORDER BY bs.updated_at DESC
LIMIT 1
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE soul_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE soul_milestones ENABLE ROW LEVEL SECURITY;

-- Allow all operations for service_role (relay uses service key)
CREATE POLICY "service_role_all" ON soul_versions FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON soul_milestones FOR ALL
  TO service_role USING (true) WITH CHECK (true);
