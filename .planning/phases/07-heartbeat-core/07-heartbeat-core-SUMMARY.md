# Phase 7: Heartbeat Core Summary

**One-liner:** Periodic heartbeat loop that reads HEARTBEAT.md, calls Claude, suppresses HEARTBEAT_OK responses and duplicates, and delivers noteworthy messages to Telegram DM.

---

## Overview

**Phase:** 7 - Heartbeat Core
**Plan:** 07-heartbeat-core-PLAN.md
**Subsystem:** Heartbeat
**Status:** Complete
**Completed:** 2026-02-12

### Requirements Coverage

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| HB-01: Periodic heartbeat loop at configurable interval | ✅ Complete | heartbeatTick() runs on interval from Phase 6 timer, now calls Claude |
| HB-02: Reads HEARTBEAT.md as checklist | ✅ Complete | readHeartbeatChecklist() reads file, buildHeartbeatPrompt() includes contents, HEARTBEAT.md created |
| HB-03: HEARTBEAT_OK token suppresses message delivery | ✅ Complete | heartbeatTick() checks for HEARTBEAT_OK in Claude response, skips Telegram delivery |
| HB-06: Identical messages deduplicated within 24h | ✅ Complete | isHeartbeatDuplicate() queries logs_v2, heartbeatTick() suppresses delivery if duplicate found |

### Tags
`heartbeat`, `periodic-agent`, `suppression`, `deduplication`, `telegram`

---

## Dependency Graph

### Requires
- Phase 6 complete (heartbeat_config table, lifecycle integration)
- Supabase logs_v2 table for dedup queries
- Bot API access for sending DM messages

### Provides
- Fully functional heartbeat system with checklist reading
- HEARTBEAT_OK suppression mechanism
- 24-hour deduplication for identical messages
- Intent processing in heartbeat context ([LEARN:], [FORGET:])
- Comprehensive heartbeat event logging

### Affects
- relay.ts heartbeat flow (now fully implemented)
- User experience (receives proactive check-ins)
- Supabase logs_v2 (new event types: heartbeat_ok, heartbeat_delivered, heartbeat_dedup, heartbeat_skip)

---

## Technical Implementation

### Tech Stack

**Added:**
- HEARTBEAT.md checklist file format
- Standalone Claude calls (no --resume) for heartbeat
- HTML chunking for long heartbeat messages
- 24h sliding window dedup queries

**Patterns:**
- Guard flag pattern (heartbeatRunning) to prevent overlapping calls
- Graceful degradation (missing HEARTBEAT.md → skip silently)
- Fail-open dedup (Supabase down → deliver rather than suppress)
- Distinct event logging for each heartbeat outcome

### Key Files

**Created:**
- `HEARTBEAT.md` — Default checklist file for heartbeat cycles

**Modified:**
- `src/relay.ts` — Added 5 helper functions, replaced heartbeatTick() skeleton with full implementation (143 lines added)
- `CLAUDE.md` — Updated heartbeat documentation (3 sections modified)

### Architecture

**Heartbeat Flow:**
1. heartbeatTick() fires on timer (Phase 6 integration)
2. Check heartbeatRunning guard → skip if already running
3. Verify heartbeat is enabled in config
4. Read HEARTBEAT.md checklist (skip if missing)
5. Build prompt with soul + global memory + checklist + HEARTBEAT_OK instructions
6. Call Claude in standalone mode (no --resume, no thread context)
7. Check for HEARTBEAT_OK token → suppress if found
8. Process intents ([LEARN:], [FORGET:]) so heartbeat can learn facts
9. Strip [VOICE_REPLY] tag (heartbeat is text-only)
10. Query logs_v2 for duplicate messages in last 24h → suppress if found
11. Send to Telegram DM with HTML formatting and chunking
12. Log outcome with message_text in metadata for future dedup

**Helper Functions:**
- `readHeartbeatChecklist()` — Reads HEARTBEAT.md from PROJECT_DIR, returns empty string if missing
- `buildHeartbeatPrompt()` — Assembles prompt with soul, memory, checklist, and HEARTBEAT_OK instructions
- `isHeartbeatDuplicate()` — Queries logs_v2 for identical message_text in last 24h
- `sendHeartbeatToTelegram()` — Sends to user DM using bot.api.sendMessage with HTML parsing and chunking

**Event Types:**
- `heartbeat_tick` — Timer fired (includes interval_minutes)
- `heartbeat_skip` — No HEARTBEAT.md file found
- `heartbeat_ok` — Claude returned HEARTBEAT_OK (nothing to report)
- `heartbeat_dedup` — Duplicate message suppressed (includes message_preview)
- `heartbeat_delivered` — Message sent to user (includes message_text, message_length)
- `heartbeat_error` — Error occurred (includes error substring)

---

## Deviations from Plan

None — plan executed exactly as written.

---

## Decisions Made

1. **heartbeatRunning guard flag** — Added module-level boolean to prevent overlapping heartbeat calls if Claude takes longer than interval. Uses `finally` block to ensure flag is always reset.

2. **HEARTBEAT_OK detection** — Checks for exact match OR substring match to handle cases where Claude includes the token with other text.

3. **Graceful degradation for missing HEARTBEAT.md** — Logs `heartbeat_skip` event and returns silently rather than erroring. Allows heartbeat timer to run even if user hasn't created checklist yet.

4. **Fail-open dedup** — If Supabase query fails, delivers message rather than suppressing. Prevents legitimate messages from being lost due to transient DB issues.

5. **Intent processing in heartbeat** — Heartbeat can use [LEARN:] and [FORGET:] to update global memory. Enables heartbeat to remember patterns across cycles.

6. **Voice tag stripping** — Explicitly strips [VOICE_REPLY] tag even though instructions tell Claude not to use it. Defense-in-depth approach for instruction-following errors.

---

## Verification Results

### Task 1 & 3 Verification (Wave 1)
- ✅ heartbeatRunning boolean flag exists at module scope
- ✅ readHeartbeatChecklist() reads HEARTBEAT.md from PROJECT_DIR
- ✅ buildHeartbeatPrompt() includes soul, global memory, checklist, and HEARTBEAT_OK instructions
- ✅ isHeartbeatDuplicate() queries logs_v2 for heartbeat_delivered events with matching message_text
- ✅ sendHeartbeatToTelegram() sends to user's DM using bot.api.sendMessage with HTML formatting
- ✅ HEARTBEAT.md file created at project root with clear instructions

### Task 2 Verification (Wave 2)
- ✅ heartbeatRunning guard prevents overlapping calls
- ✅ finally block always resets heartbeatRunning to false
- ✅ Reads HEARTBEAT.md and skips if missing (with log)
- ✅ Calls Claude in standalone mode (no threadInfo, no --resume)
- ✅ Detects HEARTBEAT_OK (exact match OR contained in response)
- ✅ Processes [LEARN:] and [FORGET:] intents
- ✅ Strips [VOICE_REPLY] tag
- ✅ Checks dedup before delivery (24h window)
- ✅ Delivers to Telegram via sendHeartbeatToTelegram()
- ✅ Logs distinct events for each outcome

### Task 4 Verification (Wave 2)
- ✅ CLAUDE.md describes HEARTBEAT.md file and its role
- ✅ HEARTBEAT_OK suppression behavior documented
- ✅ Dedup mentioned in heartbeat timer description
- ✅ Event types list updated with new Phase 7 event types

---

## Performance Metrics

**Execution:**
- Duration: 1m 54s
- Tasks completed: 4/4
- Files created: 1 (HEARTBEAT.md)
- Files modified: 2 (src/relay.ts, CLAUDE.md)
- Lines added: ~143 (relay.ts)
- Lines modified: ~6 (CLAUDE.md)

**Code Quality:**
- No new dependencies added
- No new imports needed (reused existing functions)
- All functions use existing error handling patterns
- Follows existing naming conventions

---

## Self-Check

### Created Files
```
FOUND: /Users/roviana/Documents/Projetos/telegram-claude-code/HEARTBEAT.md
```

### Commits
```
FOUND: 2a75618 (feat(07-heartbeat-core): add heartbeat helper functions and HEARTBEAT.md)
FOUND: e9017be (feat(07-heartbeat-core): replace heartbeatTick() skeleton with full implementation)
FOUND: 7ec33ed (docs(07-heartbeat-core): update CLAUDE.md with heartbeat core behavior)
```

### Self-Check Result
**PASSED** — All files created, all commits exist, all verification criteria met.

---

## Next Steps

1. **Phase 8: Dedicated Heartbeat Thread** — Create Telegram topic for heartbeat messages, add thread persistence via --resume
2. **Phase 9: Cron Engine** — Implement croner-based scheduled jobs with [CRON:] intent
3. **Manual testing** — Test heartbeat cycle: create custom HEARTBEAT.md, verify HEARTBEAT_OK suppression, test dedup within 24h
4. **Observability** — Query logs_v2 for heartbeat events to verify logging is working

---

*Generated: 2026-02-12T15:33:43Z*
*Execution model: claude-sonnet-4-5*
