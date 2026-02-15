---
phase: 17-three-layer-soul-schema
plan: 02
subsystem: database
tags: [soul-evolution, supabase, rpcs, milestone-v1.4]
dependency_graph:
  requires: [17-01-schema]
  provides: [soul-rpcs, milestone-rpcs]
  affects: [prompt-integration, evolution-engine]
tech_stack:
  added: []
  patterns: [postgresql-rpcs, auto-increment-version, return-type-consistency]
key_files:
  created:
    - supabase/migrations/20260215100001_soul_rpcs.sql
  modified:
    - examples/supabase-schema-v2.sql
decisions:
  - choice: "Auto-increment version using COALESCE(MAX(version), -1) + 1"
    rationale: "Safe for empty table (starts at 0), avoids race conditions with single transaction"
  - choice: "Exclude reflection_notes from get_soul_history()"
    rationale: "Large text field not needed for evolution context, reduces token overhead"
  - choice: "Default limits: 7 versions, 10 milestones"
    rationale: "7 days = one week of daily evolution, 10 milestones = substantial formative events"
metrics:
  duration_seconds: 89
  tasks_completed: 2
  files_created: 1
  files_modified: 1
  commits: 2
  completed_at: "2026-02-15T23:49:27Z"
---

# Phase 17 Plan 02: Soul & Milestone RPCs Summary

**One-liner:** Created 5 PostgreSQL RPCs for soul version CRUD (get/save/history) and milestone moments (save/get) with auto-increment versioning and sensible defaults.

## What Was Built

Created the database API layer for the Three-Layer Soul Schema via 5 Supabase RPCs:

**Soul Version RPCs:**
- `get_current_soul()` — Returns latest soul version (all 3 layers + metadata)
- `save_soul_version()` — Inserts new version with auto-incremented version number
- `get_soul_history(p_limit=7)` — Returns recent versions without reflection_notes

**Milestone Moment RPCs:**
- `save_milestone_moment()` — Inserts milestone with emotional weight and lesson
- `get_milestone_moments(p_limit=10)` — Returns milestones ordered by recency

All RPCs follow established patterns from `typed_memory_schema.sql` (see get_facts, get_active_goals, match_memory).

## Technical Implementation

### Auto-Increment Version Logic
```sql
SELECT COALESCE(MAX(version), -1) + 1 INTO v_next_version FROM soul_versions;
```
Safe first-run behavior (starts at 0), avoids race conditions within transaction.

### History Query Optimization
`get_soul_history()` excludes `reflection_notes` column (large uncompressed journal text) to minimize token overhead. Evolution engine gets concise 3-layer snapshots, full reflection available via `get_current_soul()` when needed.

### Return Type Consistency
- Soul RPCs return TABLE rows (multiple columns)
- `save_soul_version()` returns INTEGER (new version number)
- `save_milestone_moment()` returns UUID (created row ID)

Matches existing RPC patterns (get_facts returns TABLE, get_active_soul returns TEXT).

## Files Changed

| File | Lines | Change Type |
|------|-------|-------------|
| supabase/migrations/20260215100001_soul_rpcs.sql | 147 | Created |
| examples/supabase-schema-v2.sql | +110 | Modified |

**Migration file:** 5 RPCs with DROP IF EXISTS guards for idempotent execution.

**Reference schema:** Added section "SOUL VERSION & MILESTONE RPCs (v1.4 Phase 17)" after existing helper functions, before CRON JOBS TABLE.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 1c13455 | feat(17-02): create soul version and milestone RPCs |
| 2 | e6ceef4 | docs(17-02): add soul and milestone RPCs to reference schema |

## Verification

All success criteria met:
- All 5 RPCs defined with correct parameter types, return types, and query logic ✓
- get_current_soul returns 3 layers + metadata from latest version (ORDER BY version DESC LIMIT 1) ✓
- save_soul_version auto-increments version using COALESCE(MAX(version), -1) + 1 ✓
- get_soul_history excludes reflection_notes, default limit 7 ✓
- save_milestone_moment inserts and returns UUID ✓
- get_milestone_moments ordered by created_at DESC, default limit 10 ✓
- Reference schema includes all 5 RPCs with section header ✓

## Deviations from Plan

None - plan executed exactly as written.

## Integration Points

**Upstream dependencies (requires):**
- Phase 17 Plan 01: soul_versions and soul_milestones tables

**Downstream consumers (provides):**
- Phase 18: Prompt integration will call `get_current_soul()` in `buildPrompt()`
- Phase 19: Daily evolution engine will call `save_soul_version()` after Claude reflection
- Phase 20: Milestone moments will use `save_milestone_moment()` via [MILESTONE:] intent tag

**Affected systems:**
- relay.ts (will add RPC calls in Phase 18+)
- Supabase migrations (new RPCs available for all queries)

## Next Steps

1. Phase 18 Plan 01: Load 3-layer soul into prompt (replace `get_active_soul()` with `get_current_soul()`)
2. Phase 18 Plan 02: Add intent tag for Claude to request soul evolution
3. Phase 19: Implement daily evolution engine that calls `save_soul_version()`

## Self-Check

Verifying created files exist:
```bash
[ -f "supabase/migrations/20260215100001_soul_rpcs.sql" ] && echo "FOUND: supabase/migrations/20260215100001_soul_rpcs.sql"
```

Verifying commits exist:
```bash
git log --oneline --all | grep -q "1c13455" && echo "FOUND: 1c13455"
git log --oneline --all | grep -q "e6ceef4" && echo "FOUND: e6ceef4"
```

Running checks now...

**Self-Check: PASSED**

All files created:
- FOUND: supabase/migrations/20260215100001_soul_rpcs.sql

All commits verified:
- FOUND: 1c13455 (Task 1: Create soul and milestone RPCs)
- FOUND: e6ceef4 (Task 2: Update reference schema)
