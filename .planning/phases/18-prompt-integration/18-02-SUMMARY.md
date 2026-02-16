---
phase: 18-prompt-integration
plan: 02
subsystem: prompt-building
tags: [soul-system, token-budget, prompt-validation, token-estimation]

# Dependency graph
requires:
  - phase: 18-prompt-integration-01
    provides: formatSoulForPrompt() function assembling 3-layer soul text
provides:
  - estimateTokens() word-based token estimation helper (no dependency added)
  - SOUL_TOKEN_BUDGET constant (800 tokens)
  - Token validation and graceful truncation in formatSoulForPrompt()
affects: [19-daily-evolution-engine, prompt-building, personality-system]

# Tech tracking
tech-stack:
  added: []
  patterns: [word-based-token-estimation, graceful-truncation-by-priority]

key-files:
  created: []
  modified: [src/relay.ts]

key-decisions:
  - "Use word-count * 1.3 approximation for token estimation (no new dependency)"
  - "Truncation priority: Recent Growth (ephemeral) -> Active Values -> Core Identity (hard-truncate)"
  - "800-token budget enforced at prompt injection time as safety net"
  - "Log warning when truncation happens for observability"

patterns-established:
  - "Token budget validation pattern: estimate -> compare -> graceful truncation by priority"
  - "Module-level constants for tunable limits (SOUL_TOKEN_BUDGET)"

# Metrics
duration: 2min
completed: 2026-02-16
---

# Phase 18 Plan 02: Token Validation Summary

**Soul text injected into prompts now enforces 800-token budget with graceful layer-by-layer truncation and logged warnings**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-16T00:58:19Z
- **Completed:** 2026-02-16T01:00:15Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Added lightweight token estimation using word-count approximation (no new dependency)
- Enforced 800-token budget in formatSoulForPrompt() with validation and truncation
- Implemented priority-based truncation: Recent Growth removed first, then Active Values, then Core Identity hard-truncated
- Added warning logging when truncation occurs for debugging

## Task Commits

Each task was committed atomically:

1. **Task 1: Add estimateTokens() helper and token validation in formatSoulForPrompt()** - `c39e34e` (feat)

## Files Created/Modified
- `src/relay.ts` - Added SOUL_TOKEN_BUDGET constant, estimateTokens() helper, and token validation/truncation logic in formatSoulForPrompt()

## Decisions Made

None - plan executed exactly as written.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Token validation complete. Soul text is now guaranteed to never exceed ~800 tokens when injected into prompts. The truncation is graceful (removes least important layers first) and logged for observability.

Ready for Phase 18-03 (if planned) or Phase 19 (Daily Evolution Engine).

## Self-Check: PASSED

All claimed artifacts verified:
- FOUND: src/relay.ts
- FOUND: c39e34e (Task 1 commit)
- FOUND: estimateTokens function
- FOUND: SOUL_TOKEN_BUDGET = 800

---
*Phase: 18-prompt-integration*
*Completed: 2026-02-16*
