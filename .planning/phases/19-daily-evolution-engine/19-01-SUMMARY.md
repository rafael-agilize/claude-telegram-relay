---
phase: 19-daily-evolution-engine
plan: 01
subsystem: evolution-data-layer
status: complete
tags: [data-helpers, timer-infrastructure, supabase-rpc]
dependencies:
  requires: [17-02, 18-01, 18-02]
  provides: [getLast24hMessages, getSoulHistory, evolution-timer]
  affects: [relay.ts]
tech_stack:
  added: [evolution-timer-pattern]
  patterns: [graceful-fallback, daily-dedup, timezone-aware-scheduling]
key_files:
  created: []
  modified: [src/relay.ts]
decisions:
  - Default limit=3 for getSoulHistory (not 7): Only need recent context for reflection
  - Evolution runs at midnight (EVOLUTION_HOUR=0): Outside normal active hours by design
  - 30-min timer interval: Balances responsiveness with resource efficiency
  - 2-step thread name mapping: Avoids JOIN complexity, explicit fallback to "Unknown"
metrics:
  duration: 238s
  tasks_completed: 2/2
  files_modified: 1
  commits: 2
  completed_at: 2026-02-16T01:45:54Z
---

# Phase 19 Plan 01: Evolution Data Layer & Timer Infrastructure Summary

**One-liner:** Data helpers and cron-like timer that gather 24h interactions, soul history, and trigger daily evolution at configured hour

## Overview

Added foundational infrastructure for Phase 19 daily soul evolution: two data-gathering functions (`getLast24hMessages`, `getSoulHistory`) and a timer system that checks every 30 minutes and triggers evolution at a configurable hour (default midnight).

## Implementation Details

### Data Helpers (Task 1)

**getLast24hMessages():**
- Queries `thread_messages` table for all messages in last 24 hours across all threads
- Two-step process avoids JOIN: (1) fetch all threads into Map<id, name>, (2) fetch messages with date filter, (3) map thread_id to thread_name
- Date filter: `created_at >= now() - 24h` using `.gte()` with ISO cutoff timestamp
- Caps at 200 messages to prevent token explosion
- Returns empty array on error (graceful fallback)

**getSoulHistory():**
- Calls `get_soul_history` RPC with configurable limit (default 3, not 7)
- Returns array of `SoulVersion` objects (interface already exists at lines 495-503)
- Graceful fallback: empty array on error
- Limited to 3 entries to provide recent context without excessive token overhead

### Evolution Timer (Task 2)

**Timer infrastructure (following heartbeat/cron patterns):**
- Module variables: `evolutionTimer`, `evolutionRunning`, `lastEvolutionDate`
- Config: `EVOLUTION_HOUR` (default 0=midnight), `EVOLUTION_TIMEZONE` (default America/Sao_Paulo)
- `evolutionTick()`: Checks every 30 min, only triggers at configured hour using timezone-aware `toLocaleString()`
- Daily dedup: Stores last run date string ("2026-02-15"), skips if already ran today
- No active hours check (deliberately runs at midnight, outside typical 08:00-22:00 window)
- Placeholder log message for Plan 02 reflection logic

**Lifecycle wiring:**
- `startEvolutionTimer()` called in `onStart` handler (line 3247)
- `stopEvolutionTimer()` called in SIGINT and SIGTERM handlers (lines 1997, 2005)
- Clean shutdown guaranteed

## Deviations from Plan

None — plan executed exactly as written.

## Key Decisions

1. **Default limit=3 for getSoulHistory**: Plan specified 3, not 7, to reduce token overhead while still providing sufficient recent context for reflection.

2. **2-step thread name mapping**: Explicit Map-based approach instead of JOIN ensures clear fallback behavior ("Unknown") and avoids SQL complexity.

3. **30-minute timer interval**: Strikes balance between responsive triggering (won't miss the hour) and minimal resource usage (only 48 checks/day).

4. **No active hours check**: Evolution deliberately runs at midnight, which is outside normal active hours. This is intentional — user doesn't need to be awake for daily soul evolution.

## Testing Notes

**Verification checks (all passed):**
- ✅ Both helper functions exist in relay.ts
- ✅ Evolution timer variables declared (EVOLUTION_HOUR, EVOLUTION_TIMEZONE, lastEvolutionDate)
- ✅ Timer functions wired into lifecycle (onStart, signal handlers)
- ✅ No syntax errors (verified with `bun build --no-bundle`)

**Runtime behavior (to be tested):**
- Timer will fire every 30 minutes after bot start
- Will only trigger evolution at configured hour in configured timezone
- Will skip if already ran that day (daily dedup)
- Placeholder log confirms readiness for Plan 02 reflection logic

## Next Steps

**Plan 02 (Evolution Reflection):** Build the actual reflection logic that uses these helpers:
1. Call `getLast24hMessages()` to get day's interactions
2. Call `getSoulHistory()` to get recent soul versions
3. Build evolution prompt with interaction summary and current soul
4. Parse Claude's response into 3-layer soul structure
5. Insert new soul version via `insertSoulVersion()` (to be added in Plan 02)

## Performance

- **Duration:** 238 seconds (~4 minutes)
- **Tasks:** 2/2 completed
- **Commits:** 2 (one per task)
  - f791370: Data helpers (getLast24hMessages, getSoulHistory)
  - 98d65a6: Evolution timer infrastructure

## Self-Check: PASSED

**Created files:**
✅ .planning/phases/19-daily-evolution-engine/19-01-SUMMARY.md (this file)

**Modified files:**
✅ src/relay.ts (verified by git log)

**Commits exist:**
✅ f791370 (Task 1: data helpers)
✅ 98d65a6 (Task 2: evolution timer)

**Functions exist:**
```bash
$ grep -n "getLast24hMessages\|getSoulHistory" src/relay.ts
605:async function getLast24hMessages()...
650:async function getSoulHistory()...
```

```bash
$ grep -n "evolutionTick\|startEvolutionTimer\|stopEvolutionTimer" src/relay.ts
1326:async function evolutionTick()...
1382:function startEvolutionTimer()...
1389:function stopEvolutionTimer()...
```

All artifacts verified present and correct.
