---
phase: 21-evolution-controls
plan: 02
subsystem: daily-evolution
tags:
  - soul-evolution
  - user-controls
  - history-rollback
dependency_graph:
  requires:
    - 17-three-layer-soul (soul_versions table, save_soul_version RPC)
    - 21-01-evolution-controls (pause/resume subcommands)
  provides:
    - /soul history command
    - /soul rollback command
  affects:
    - /soul command behavior
tech_stack:
  patterns:
    - Subcommand parsing for bot commands
    - Direct table queries for version lookup
    - RPC-based version creation (preserves history)
key_files:
  modified:
    - src/relay.ts (/soul command handler with history and rollback subcommands)
decisions:
  - choice: "Direct query soul_versions table for rollback target"
    rationale: "get_soul_history RPC excludes reflection_notes; we only need the three layers for restoration"
  - choice: "Rollback creates NEW version via save_soul_version RPC"
    rationale: "Preserves full history, never deletes entries. Rollback becomes part of the evolution timeline"
  - choice: "Display last 10 versions in history (vs default 3)"
    rationale: "History command is for user inspection, more context is useful. Evolution still uses limit=3 to minimize token overhead"
  - choice: "reflection_notes records 'Rollback to vN by user'"
    rationale: "Documents the rollback action in version metadata for audit trail"
metrics:
  duration_seconds: 146
  tasks_completed: 2
  files_modified: 1
  commits: 2
  completed_date: "2026-02-16"
---

# Phase 21 Plan 02: Soul History and Rollback Summary

**One-liner:** Added /soul history and /soul rollback commands for viewing and restoring previous soul versions.

## Objective Outcome

Successfully added history and rollback subcommands to /soul, enabling Rafa to inspect the soul evolution timeline and undo unwanted changes. Rollback preserves full history by creating a new version with old content, maintaining a complete audit trail.

## Tasks Executed

### Task 1: Add /soul history subcommand
**Status:** Complete
**Commit:** ff72aa6

Extended /soul command handler with "history" case:
- Calls `getSoulHistory(10)` to fetch last 10 versions
- Formats each line as: `v{version} ({date}) — {token_count} tokens`
- Dates formatted using EVOLUTION_TIMEZONE for consistency
- Empty state message: "No soul versions yet. Evolution hasn't run."
- Includes rollback hint at bottom: "Use /soul rollback <version> to restore."

**Files modified:**
- `src/relay.ts` (added history subcommand case)

### Task 2: Add /soul rollback subcommand
**Status:** Complete
**Commit:** b5e6b4a

Extended /soul command handler with "rollback" case:
- Parses version number from second arg: `/soul rollback 3`
- Validates version number (must be integer >= 0)
- Queries `soul_versions` table directly for target version's layers
- Saves old layers as NEW version via `save_soul_version()` RPC
- reflection_notes set to: "Rollback to v{targetVersion} by user"
- Logs `soul_rollback` event with source version and new version number
- Confirms to user: "Rolled back to vN. Created as new vM. The previous soul is preserved in history."

Error handling:
- Invalid/missing version arg → Usage hint with example
- Target version not found → Clear error with history hint
- Supabase unavailable → "Supabase not available"

**Files modified:**
- `src/relay.ts` (added rollback subcommand case)

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

All verification criteria met:

1. ✅ `grep "Soul Version History" src/relay.ts` → String exists in /soul handler
2. ✅ `grep "getSoulHistory" src/relay.ts | grep 10` → Called with limit 10 for history display
3. ✅ `grep "soul_rollback" src/relay.ts` → Log event exists
4. ✅ `grep "save_soul_version" src/relay.ts` → Used in rollback case (line 2995)
5. ✅ `grep "Rolled back to" src/relay.ts` → Confirmation message exists
6. ✅ Rollback does NOT delete any rows from soul_versions (uses RPC to create new version)

## Success Criteria

All criteria met:

1. ✅ /soul history shows last 10 versions with version number, date, token count
2. ✅ /soul rollback <version> restores target version as new active soul
3. ✅ Rollback creates a NEW version number (history preserved, no deletion)
4. ✅ Invalid version number returns clear error with usage hint
5. ✅ All /soul subcommands coexist: (empty), pause, resume, history, rollback, <text>

## Self-Check: PASSED

Verification results:

```bash
# Check modified file exists
FOUND: src/relay.ts

# Check commits exist
FOUND: ff72aa6
FOUND: b5e6b4a
```

All files and commits verified successfully.
