---
phase: 21-evolution-controls
plan: 01
subsystem: daily-evolution
tags:
  - soul-evolution
  - user-controls
  - database-schema
dependency_graph:
  requires:
    - 19-daily-evolution-engine (evolution tick infrastructure)
    - heartbeat_config table
  provides:
    - evolution_enabled flag
    - /soul pause and /soul resume commands
  affects:
    - evolutionTick() execution flow
    - /soul command behavior
tech_stack:
  added:
    - Database column: evolution_enabled BOOLEAN
  patterns:
    - Subcommand parsing for bot commands
    - Database-gated background tasks
key_files:
  created:
    - supabase/migrations/20260216100000_evolution_enabled.sql
  modified:
    - src/relay.ts (/soul command handler, evolutionTick gate)
    - examples/supabase-schema-v2.sql (schema reference)
decisions:
  - choice: "evolution_enabled gates evolutionTick before hour check"
    rationale: "No need to check time if evolution is globally paused"
  - choice: "Subcommand parsing preserves backward compatibility"
    rationale: "/soul <text> still sets personality, any non-subcommand text passes through"
  - choice: "Silent skip when paused (no log event)"
    rationale: "Reduces log noise during paused periods, user already knows state"
  - choice: "Show 3-layer soul with formatSoulForPrompt() instead of flat getActiveSoul()"
    rationale: "Richer context when checking current soul state"
metrics:
  duration_seconds: 504
  tasks_completed: 2
  files_modified: 3
  commits: 2
  completed_date: "2026-02-16"
---

# Phase 21 Plan 01: Evolution Pause/Resume Controls Summary

**One-liner:** Added /soul pause and /soul resume commands with database-gated evolution control.

## Objective Outcome

Successfully added pause/resume evolution controls via /soul subcommands, gated by a new evolution_enabled flag in the heartbeat_config table. Users can now freeze or unfreeze the daily soul evolution cycle from Telegram without stopping the relay.

## Tasks Executed

### Task 1: Add evolution_enabled column to heartbeat_config
**Status:** Complete
**Commit:** 3bf9152

Created migration `supabase/migrations/20260216100000_evolution_enabled.sql`:
- Added `evolution_enabled BOOLEAN DEFAULT true` column to heartbeat_config
- Column comment explains it's controlled via /soul pause/resume commands
- Updated schema reference `examples/supabase-schema-v2.sql` with Phase 21 annotation

**Files modified:**
- `supabase/migrations/20260216100000_evolution_enabled.sql` (created)
- `examples/supabase-schema-v2.sql` (updated)

### Task 2: Extend /soul command with pause/resume and gate evolutionTick
**Status:** Complete
**Commit:** 1e323e6

Refactored /soul command handler (line ~2852) to parse subcommands:
- Empty args → Show current soul via `formatSoulForPrompt()` (now shows 3-layer soul)
- `pause` → Sets evolution_enabled=false, logs `evolution_paused`, confirms to user
- `resume` → Sets evolution_enabled=true, logs `evolution_resumed`, confirms to user
- Any other text → Sets soul personality (existing behavior preserved)

Added evolution gate to `evolutionTick()` (line ~1626):
- Checks evolution_enabled from heartbeat_config before hour check
- Silently skips when paused (no log spam)
- Returns early if evolution_enabled=false

**Files modified:**
- `src/relay.ts` (/soul command handler extended, evolutionTick gated)

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

All verification criteria met:
- `grep -c "evolution_enabled" src/relay.ts` → 8 occurrences (both /soul handler and evolutionTick)
- `grep "evolution_paused|evolution_resumed" src/relay.ts` → Both log events present
- Migration file exists with ALTER TABLE
- Reference schema includes evolution_enabled column

## Success Criteria

All criteria met:

1. ✅ /soul pause stops evolution by setting evolution_enabled=false in DB
2. ✅ /soul resume restarts evolution by setting evolution_enabled=true in DB
3. ✅ evolutionTick() respects the flag and skips silently when paused
4. ✅ /soul (no args) shows current soul, /soul <text> sets soul — backward compatible

## Self-Check: PASSED

Verification results:

```bash
# Check created migration file
FOUND: supabase/migrations/20260216100000_evolution_enabled.sql

# Check commits exist
FOUND: 3bf9152
FOUND: 1e323e6
```

All files and commits verified successfully.
