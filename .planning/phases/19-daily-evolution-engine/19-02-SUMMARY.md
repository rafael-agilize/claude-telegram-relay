---
phase: 19-daily-evolution-engine
plan: 02
subsystem: evolution-reflection
status: complete
tags: [reflection-logic, structured-parsing, soul-saving, telegram-notification]
dependencies:
  requires: [19-01, 17-02, 18-01]
  provides: [performDailyEvolution, buildEvolutionPrompt, parseEvolutionResponse]
  affects: [relay.ts]
tech_stack:
  added: [structured-output-parsing, evolution-pipeline]
  patterns: [tagged-section-parsing, graceful-skip, token-budget-validation]
key_files:
  created: []
  modified: [src/relay.ts]
decisions:
  - Evolution prompt includes current soul + last 3 versions for continuity
  - Messages truncated to 200 chars each, last 100 messages taken
  - EVOLUTION_SKIP returned when no meaningful interactions
  - Token budget validation logs warning but proceeds (Claude was instructed to stay within budget)
  - Evolution reports delivered via sendHeartbeatToTelegram (reuses heartbeat topic infrastructure)
metrics:
  duration: 469s
  tasks_completed: 2/2
  files_modified: 1
  commits: 2
  completed_at: 2026-02-16T01:56:39Z
---

# Phase 19 Plan 02: Daily Evolution Reflection & Soul Persistence Summary

**One-liner:** Complete daily evolution pipeline: builds reflection prompt with 24h context, calls Claude for structured 3-layer soul output, saves new version, notifies Rafa via Telegram

## Overview

Implemented the core daily evolution logic that reflects on the day's interactions, generates an updated 3-layer soul, persists it via RPC, and delivers an evolution report to Telegram. The system handles graceful skips when there are no meaningful interactions, validates token budgets, and reuses the heartbeat topic infrastructure for notifications.

## Implementation Details

### Task 1: Reflection Prompt & Structured Parsing

**buildEvolutionPrompt():**
- Assembles comprehensive context for Claude's reflection:
  - Current 3-layer soul (formatted with headers)
  - Soul history (last 3 versions with date + preview)
  - Today's interactions from last 24h (grouped by thread, truncated to 200 chars each)
  - Current date and time
- Instructs Claude to generate 4 tagged sections:
  - `[CORE_IDENTITY]...[/CORE_IDENTITY]` — Most stable layer
  - `[ACTIVE_VALUES]...[/ACTIVE_VALUES]` — Evolves weekly
  - `[RECENT_GROWTH]...[/RECENT_GROWTH]` — Ephemeral, daily
  - `[EVOLUTION_REPORT]...[/EVOLUTION_REPORT]` — Report for Rafa
- Includes explicit ~800 token budget instruction
- Provides EVOLUTION_SKIP option for days with no meaningful interactions
- Message processing strategy:
  - Sorts messages by created_at ascending
  - Takes last 100 messages to prevent token explosion
  - Truncates each message content to 200 chars
  - Groups by thread_name with headers

**parseEvolutionResponse():**
- Uses regex to extract content between tagged sections
- Returns null if EVOLUTION_SKIP present or parsing fails
- Trims whitespace from each extracted section
- Validates all 4 sections are present before returning

### Task 2: Evolution Pipeline Integration

**performDailyEvolution():**
1. **Data gathering:**
   - Calls `getLast24hMessages()` — skips if empty
   - Calls `getCurrentSoul()` for current state
   - Calls `getSoulHistory(3)` for recent versions
2. **Reflection:**
   - Builds prompt via `buildEvolutionPrompt()`
   - Calls `callClaude()` standalone (no --resume, like heartbeat)
   - Parses response via `parseEvolutionResponse()`
3. **Validation:**
   - Estimates tokens for combined soul text
   - Logs warning if exceeds SOUL_TOKEN_BUDGET but proceeds
4. **Persistence:**
   - Saves via `supabase.rpc('save_soul_version', {...})`
   - RPC returns new version number
   - Logs success event with version + token count
5. **Notification:**
   - Formats evolution report with version number and token count
   - Delivers via `sendHeartbeatToTelegram()` (reuses heartbeat topic/DM fallback)

**evolutionTick() integration:**
- Replaced placeholder log with try-catch block calling `performDailyEvolution()`
- Errors caught and logged as `evolution_error` events
- Does not break timer on error

**Event types added:**
- `evolution_tick` — Timer fired at configured hour
- `evolution_skip` — No interactions or Claude returned EVOLUTION_SKIP
- `evolution_complete` — New soul version saved successfully
- `evolution_error` — Error during save or notification

## Deviations from Plan

None — plan executed exactly as written.

## Key Decisions

1. **Evolution reports reuse heartbeat infrastructure**: `sendHeartbeatToTelegram()` provides consistent delivery mechanism (dedicated topic or DM fallback) without duplicating routing logic.

2. **Token budget validation is permissive**: Logs warning but proceeds when budget exceeded, trusting that Claude was instructed to stay within budget. This avoids hard failures during daily evolution.

3. **Message truncation strategy**: Takes last 100 messages (not all 24h) and truncates each to 200 chars to balance context richness with token efficiency.

4. **EVOLUTION_SKIP as graceful no-op**: When Claude returns this token or parsing fails, the system logs and returns without error, preserving the previous soul version. This is intentional — not every day requires evolution.

5. **Standalone Claude call**: No --resume flag (like heartbeat), so evolution reflection is independent of user conversations. This keeps the reflection context clean.

## Testing Notes

**Verification checks (all passed):**
- ✅ All 3 functions exist (buildEvolutionPrompt, parseEvolutionResponse, performDailyEvolution)
- ✅ save_soul_version RPC call present
- ✅ EVOLUTION_SKIP handling in parser and performDailyEvolution
- ✅ Telegram delivery via sendHeartbeatToTelegram
- ✅ Event logging for all outcomes (tick, skip, complete, error)
- ✅ No syntax errors (verified with `bun build --no-bundle`)

**Runtime behavior (to be tested):**
- When evolutionTick fires at configured hour:
  1. Checks for messages in last 24h
  2. Skips gracefully if none found
  3. Otherwise builds prompt with soul + history + interactions
  4. Calls Claude for reflection
  5. Parses structured output
  6. Skips if EVOLUTION_SKIP or parsing fails
  7. Saves new version via RPC
  8. Delivers report to Telegram (heartbeat topic or DM)

**Edge cases handled:**
- No interactions → skip with log
- Claude returns EVOLUTION_SKIP → skip with log
- Parsing fails → skip with log
- Token budget exceeded → warn but proceed
- RPC error → log error, do not deliver notification
- Supabase unavailable → log error and return

## Next Steps

**Plan 03 (Evolution Schedule):** Wire the evolution timer to actually run at the configured time (currently infrastructure exists but may need testing/adjustment).

**Plan 04 (Evolution History UI):** Build `/evolution` command to view soul history and evolution reports from Telegram.

## Performance

- **Duration:** 469 seconds (~7.8 minutes)
- **Tasks:** 2/2 completed
- **Commits:** 2 (one per task)
  - 57118f2: Reflection prompt builder and structured output parser
  - 68ebf76: Evolution pipeline integration with save and notify

## Self-Check: PASSED

**Created files:**
✅ .planning/phases/19-daily-evolution-engine/19-02-SUMMARY.md (this file)

**Modified files:**
✅ src/relay.ts (verified by git log)

**Commits exist:**
✅ 57118f2 (Task 1: buildEvolutionPrompt + parseEvolutionResponse)
✅ 68ebf76 (Task 2: performDailyEvolution + evolutionTick wiring)

**Functions exist:**
```bash
$ grep -n "buildEvolutionPrompt\|parseEvolutionResponse\|performDailyEvolution" src/relay.ts
665:function buildEvolutionPrompt(
788:function parseEvolutionResponse(response: string): {
1479:async function performDailyEvolution(): Promise<void>:
```

**Key patterns verified:**
- ✅ getLast24hMessages() called first
- ✅ getCurrentSoul() and getSoulHistory() called for context
- ✅ buildEvolutionPrompt() assembles reflection context
- ✅ callClaude() invoked standalone (no --resume)
- ✅ parseEvolutionResponse() extracts 4 tagged sections
- ✅ save_soul_version RPC saves new version before notification
- ✅ sendHeartbeatToTelegram() delivers report
- ✅ All event types logged (evolution_tick, evolution_skip, evolution_complete, evolution_error)

All artifacts verified present and correct.
