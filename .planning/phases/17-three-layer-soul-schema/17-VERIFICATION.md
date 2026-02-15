---
phase: 17-three-layer-soul-schema
verified: 2026-02-15T23:52:56Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 17: Three-Layer Soul Schema Verification Report

**Phase Goal:** Database structure supports versioned 3-layer souls with milestone moments
**Verified:** 2026-02-15T23:52:56Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | soul_versions table stores daily snapshots with core_identity, active_values, recent_growth, reflection_notes, and token_count | ✓ VERIFIED | Table created in migration 20260215100000 with all 5 required columns (lines 22-26), UNIQUE(version) constraint (line 27), indexes on created_at and version DESC (lines 30-31) |
| 2 | soul_milestones table stores formative events with emotional_weight classification and lesson_learned | ✓ VERIFIED | Table created in migration 20260215100000 with emotional_weight CHECK constraint for 3 values (lines 42-43), lesson_learned column (line 44), indexes on created_at and emotional_weight (lines 48-49) |
| 3 | Current bot_soul content is preserved as seed in new schema (Core Identity Layer 1) | ✓ VERIFIED | Seed migration copies active bot_soul content into soul_versions as version 0 (lines 58-70), uses WHERE is_active=true (line 67), ON CONFLICT DO NOTHING for idempotency (line 70) |
| 4 | Supabase RPCs exist for soul CRUD (get_current_soul, save_soul_version, get_soul_history) | ✓ VERIFIED | All 3 RPCs created in migration 20260215100001: get_current_soul (lines 16-35), save_soul_version (lines 45-63), get_soul_history (lines 73-93) with correct signatures and return types |
| 5 | Supabase RPCs exist for milestone CRUD (save_milestone_moment, get_milestone_moments) | ✓ VERIFIED | Both RPCs created in migration 20260215100001: save_milestone_moment (lines 103-119), get_milestone_moments (lines 129-147) with correct signatures and return types |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `supabase/migrations/20260215100000_soul_versions_milestones.sql` | Migration creating soul_versions and soul_milestones tables with seed data | ✓ VERIFIED | File exists, 83 lines, contains CREATE TABLE for both tables, seed INSERT from bot_soul, RLS policies, all indexes created with IF NOT EXISTS |
| `supabase/migrations/20260215100001_soul_rpcs.sql` | Migration creating 5 RPCs for soul and milestone CRUD | ✓ VERIFIED | File exists, 147 lines, contains all 5 RPCs with DROP IF EXISTS guards, correct signatures, return types, and query logic |
| `examples/supabase-schema-v2.sql` | Updated reference schema with new tables and RPCs | ✓ VERIFIED | Contains SOUL VERSIONS TABLE section (line 90), SOUL MILESTONES TABLE section (line 113), RLS policies (lines 154-155, 169-171), all 5 RPCs (lines 321-426) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| soul_versions | bot_soul | Seed migration copies active bot_soul content into soul_versions as version 0 | ✓ WIRED | INSERT INTO soul_versions...SELECT...FROM bot_soul pattern found (lines 58-66), WHERE is_active=true filter present (line 67) |
| get_current_soul() | soul_versions | SELECT with ORDER BY version DESC LIMIT 1 | ✓ WIRED | Query pattern found (lines 31-33), returns all 8 columns from TABLE return type |
| save_soul_version() | soul_versions | INSERT with auto-increment version from MAX(version)+1 | ✓ WIRED | Auto-increment logic COALESCE(MAX(version), -1) + 1 (line 56), INSERT statement (line 58), returns INTEGER (new version number) |
| save_milestone_moment() | soul_milestones | INSERT with RETURNING id | ✓ WIRED | INSERT statement (line 113), RETURNING id INTO v_id (line 115), returns UUID |
| get_milestone_moments() | soul_milestones | SELECT ordered by created_at DESC | ✓ WIRED | Query pattern found (lines 141-145), default limit 10 |

### Requirements Coverage

Phase 17 Success Criteria from ROADMAP.md:

| Requirement | Status | Evidence |
|-------------|--------|----------|
| 1. soul_versions table stores daily snapshots with core_identity, active_values, recent_growth, reflection_notes, and token_count | ✓ SATISFIED | Migration 20260215100000 lines 18-28 |
| 2. soul_milestones table stores formative events with emotional_weight classification and lesson_learned | ✓ SATISFIED | Migration 20260215100000 lines 38-46 |
| 3. Current bot_soul content is preserved as seed in new schema (Core Identity Layer 1) | ✓ SATISFIED | Migration 20260215100000 lines 58-70 |
| 4. Supabase RPCs exist for soul CRUD (get_current_soul, save_soul_version, get_soul_history) | ✓ SATISFIED | Migration 20260215100001 lines 16-93 |
| 5. Supabase RPCs exist for milestone CRUD (save_milestone_moment, get_milestone_moments) | ✓ SATISFIED | Migration 20260215100001 lines 103-147 |

### Anti-Patterns Found

None detected. All SQL is idempotent, no TODO/FIXME/placeholder comments found, no empty implementations.

### Commits Verified

All 4 commits from SUMMARYs exist in git history:

| Plan | Commit | Description | Verified |
|------|--------|-------------|----------|
| 17-01 | 27ad83d | feat(17-01): create soul_versions and soul_milestones schema | ✓ EXISTS |
| 17-01 | b35c6f3 | docs(17-01): add soul_versions and soul_milestones to reference schema | ✓ EXISTS |
| 17-02 | 1c13455 | feat(17-02): create soul version and milestone RPCs | ✓ EXISTS |
| 17-02 | e6ceef4 | docs(17-02): add soul and milestone RPCs to reference schema | ✓ EXISTS |

### Implementation Quality

**Schema Design:**
- UNIQUE constraint on version prevents duplicate version numbers
- CHECK constraint on emotional_weight enforces 3 valid values (formative/meaningful/challenging)
- Foreign key on source_thread_id with ON DELETE SET NULL preserves milestones when threads deleted
- Indexes optimized for expected query patterns (DESC for recency, version DESC for latest lookup)

**RPC Design:**
- Auto-increment logic uses COALESCE(MAX(version), -1) + 1 for safe first-run (starts at 0)
- get_soul_history() excludes reflection_notes to reduce token overhead (large uncompressed text)
- Sensible defaults: 7 versions (one week), 10 milestones (substantial formative events)
- Return type consistency: TABLE for queries, INTEGER for save_soul_version, UUID for save_milestone_moment

**Migration Quality:**
- All statements idempotent (IF NOT EXISTS, CREATE OR REPLACE, ON CONFLICT DO NOTHING)
- DROP IF EXISTS guards on all RPCs handle return type changes cleanly
- RLS enabled with service_role_all policies following established pattern
- Seed migration preserves active bot_soul as version 0 (Layer 1), leaves Layer 2/3 empty for Phase 19

## Summary

Phase 17 goal **ACHIEVED**. Database structure fully supports versioned 3-layer souls with milestone moments:

1. **soul_versions table** — 3-layer compressed soul (core_identity/active_values/recent_growth) with version control, token counting, and uncompressed reflection notes
2. **soul_milestones table** — Formative events with emotional weight classification and lessons learned
3. **Seed migration** — Preserves current bot_soul as version 0 (Core Identity Layer 1)
4. **5 RPCs** — Complete CRUD API for soul versions (get_current_soul, save_soul_version, get_soul_history) and milestone moments (save_milestone_moment, get_milestone_moments)
5. **Reference schema** — Fully documented with all tables, indexes, RLS policies, and RPCs

All artifacts exist, are substantive (not stubs), and are wired correctly. No gaps found. Ready for Phase 18 (prompt integration) and Phase 19 (daily evolution engine).

---

_Verified: 2026-02-15T23:52:56Z_
_Verifier: Claude (gsd-verifier)_
