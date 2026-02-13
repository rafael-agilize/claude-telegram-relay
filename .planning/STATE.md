# STATE.md

## Current Position

Phase: 12 - Streaming Engine
Plan: Not yet created
Status: Pending (needs /gsd:plan-phase 12)
Last activity: 2026-02-13 -- Milestone v1.2 created

**Progress:** [░░░░░░░░░░░░░░░░░░░░] 0/2 phases

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-13)

**Core value:** Robust handling of complex, long-running Claude CLI tasks with real-time progress feedback
**Current focus:** Milestone v1.2 -- Streaming & Long-Running Task Resilience

## Performance Metrics

**Milestone v1.2:**
- Phases: 2 total (Phase 12-13)
- Requirements: 9 total
- Coverage: 9/9 (100%)
- Completed: 0/2 phases
- Started: 2026-02-13

| Phase | Name | Duration | Tasks | Files | Status |
|-------|------|----------|-------|-------|--------|
| 12 | Streaming Engine | — | — | — | Pending |
| 13 | Liveness & Progress | — | — | — | Pending |

**Milestone 1.1 (archived):**
- Phases: 6 total (Phase 6-11)
- Status: Complete (2026-02-12)
- Delivered: Heartbeat, cron engine, cron management, agent scheduling

**Milestone 1.0 (archived):**
- Phases: 5 total (Phase 1-5)
- Status: Complete (2026-02-10)
- Delivered: Conversational threading, three-layer memory, voice I/O

## Accumulated Context

### From Research (stream-json format)
- `--output-format stream-json` requires `--verbose` flag
- Event types: `system` (init, hooks), `assistant` (text/tool_use turns), `user` (tool results), `result` (final)
- Session ID available immediately from `system/init` event
- Tool names in `assistant` events: `message.content[].name` where `type === "tool_use"`
- `result` event is always last, same structure as `--output-format json`
- `--include-partial-messages` NOT needed (only complete turn events required)
- NDJSON format: one JSON object per line, parse line by line

### Key Code Locations
- `callClaude()`: relay.ts line ~1704 — the function to refactor
- `CLAUDE_INACTIVITY_TIMEOUT_MS`: relay.ts line 70 — currently 5 min
- `killOrphanedProcesses()`: relay.ts line 76 — orphan cleanup after timeout
- `resetInactivityTimer()`: relay.ts line 1739 — currently resets on stderr only
- Typing action: sent once per handler at lines 2113, 2151, 2202, 2244

## Session Continuity

**Next action:** Run `/gsd:plan-phase 12` to create execution plan for Streaming Engine phase

**Context for next session:**
- Milestone v1.2 created with 2 phases, 9 requirements
- Research complete on stream-json format (see Accumulated Context above)
- Phase 12 is the core refactor of callClaude(), Phase 13 adds UX on top

---

*Created: 2026-02-13*
