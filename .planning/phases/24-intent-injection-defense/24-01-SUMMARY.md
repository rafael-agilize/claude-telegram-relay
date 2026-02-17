---
phase: 24-intent-injection-defense
plan: 01
subsystem: security
tags: [intent-processing, security, context-aware, injection-defense]

# Dependency graph
requires:
  - phase: 23-edge-function-security
    provides: Edge Function input validation and authentication
provides:
  - Context-aware intent processing with per-context allowlists
  - Protection against prompt injection escalation in automated contexts
  - Intent blocking for CRON and FORGET in heartbeat/cron execution
affects: [security, intent-system]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Context-aware intent processing with allowlist maps"
    - "Silent intent blocking with warning logs (strip tags, don't execute)"

key-files:
  created: []
  modified:
    - src/relay.ts

key-decisions:
  - "Heartbeat and cron contexts exclude CRON and FORGET intents to prevent self-replicating jobs and memory deletion"
  - "Blocked intents are stripped from response text but actions are not executed (silent blocking)"
  - "All message handlers explicitly pass 'interactive' context for full intent access"

patterns-established:
  - "IntentContext type ('interactive' | 'heartbeat' | 'cron') for execution context tracking"
  - "INTENT_ALLOWLIST map defines per-context permitted intents using Sets"
  - "Guard pattern: check allowlist before executing, always strip tag regardless"

# Metrics
duration: 4min
completed: 2026-02-17
---

# Phase 24 Plan 01: Intent Injection Defense Summary

**Context-aware intent processing prevents prompt injection escalation by blocking CRON and FORGET intents in automated contexts (heartbeat, cron)**

## Performance

- **Duration:** 4 min (220 seconds)
- **Started:** 2026-02-17T02:51:17Z
- **Completed:** 2026-02-17T02:54:57Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- Added IntentContext type and INTENT_ALLOWLIST map to processIntents()
- Implemented per-intent guards for all 6 intent types (REMEMBER, GOAL, DONE, FORGET, CRON, MILESTONE)
- Updated all 6 processIntents() call sites with explicit context parameters
- Heartbeat and cron contexts now block CRON (prevents self-replicating jobs) and FORGET (prevents memory deletion)
- Interactive context maintains full intent access (unchanged user behavior)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add IntentContext type and allowlist map to processIntents()** - `dbe49c1` (feat)
2. **Task 2: Pass context parameter from all processIntents() call sites** - `5130f1c` (feat)

## Files Created/Modified
- `src/relay.ts` - Added IntentContext type, INTENT_ALLOWLIST map, context parameter to processIntents(), guards for all 6 intent blocks, updated all 6 call sites (executeCronJob, heartbeatTick, text/voice/photo/document handlers)

## Decisions Made

**1. Heartbeat and cron contexts exclude CRON and FORGET**
- **Rationale:** Prevents prompt injection escalation where Claude responses in automated contexts could create self-replicating cron jobs or delete user memories
- **Implementation:** INTENT_ALLOWLIST restricts heartbeat and cron contexts to REMEMBER, GOAL, DONE, VOICE_REPLY, MILESTONE only
- **Impact:** Automated contexts can still learn facts and track goals, but cannot create new scheduled tasks or delete existing memories

**2. Silent blocking with warning logs**
- **Rationale:** Blocked intents should be invisible to the user (no error messages in Telegram), but visible to operators (logs)
- **Implementation:** Tags are always stripped from response text; actions are only executed if allowed
- **Impact:** User sees clean responses; operators can detect attempted injection via logs

**3. Explicit context for all call sites**
- **Rationale:** Even though 'interactive' is the default, explicit context makes intent clear and prevents accidental misuse
- **Implementation:** All 6 call sites specify context: 4 interactive (message handlers), 1 heartbeat, 1 cron
- **Impact:** Code is self-documenting and easier to audit

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Intent injection defense layer complete. The relay now has context-aware intent processing that prevents automated contexts (heartbeat, cron) from executing dangerous intents (CRON, FORGET).

Ready for next security hardening tasks or continued v1.5 milestone work.

## Self-Check: PASSED

All claims verified:
- src/relay.ts: FOUND
- Commit dbe49c1: FOUND
- Commit 5130f1c: FOUND

---
*Phase: 24-intent-injection-defense*
*Completed: 2026-02-17*
