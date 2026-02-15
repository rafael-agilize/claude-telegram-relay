---
phase: 17-three-layer-soul-schema
plan: 01
status: complete
started: 2026-02-15
completed: 2026-02-15
---

## What Was Built

Database foundation for the 3-layer soul versioning system — `soul_versions` table stores daily personality snapshots (core_identity, active_values, recent_growth) with reflection notes and token counting, `soul_milestones` stores formative events with emotional weight classification. Current bot_soul content preserved as version 0 seed.

## Key Files

### Created
- `supabase/migrations/20260215100000_soul_versions_milestones.sql` — Migration with both tables, indexes, seed data, and RLS

### Modified
- `examples/supabase-schema-v2.sql` — Reference schema updated with soul_versions and soul_milestones sections

## Decisions Made

- **Version 0 seed**: Active bot_soul content copied to core_identity (Layer 1), with active_values and recent_growth left empty for Phase 19 to populate
- **Emotional weight enum**: Used CHECK constraint with 3 values (formative/meaningful/challenging) rather than a separate enum type, consistent with project patterns

## Deviations

None — executed as planned.

## Self-Check: PASSED

- [x] soul_versions table with all required columns and UNIQUE(version)
- [x] soul_milestones table with emotional_weight CHECK constraint
- [x] Seed migration from bot_soul WHERE is_active=true
- [x] RLS enabled with service_role_all policies
- [x] Indexes on created_at DESC and version DESC
- [x] Reference schema updated
- [x] 2 atomic commits
