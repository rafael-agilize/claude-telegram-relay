# STATE.md

## Current Position

Phase: 13 - Liveness & Progress
Plan: Not yet created
Status: Pending (needs /gsd:plan-phase 13)
Last activity: 2026-02-13 -- Phase 12 Streaming Engine complete

**Progress:** [##########░░░░░░░░░░] 1/2 phases

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-13)

**Core value:** Robust handling of complex, long-running Claude CLI tasks with real-time progress feedback
**Current focus:** Milestone v1.2 -- Streaming & Long-Running Task Resilience

## Performance Metrics

**Milestone v1.2:**
- Phases: 2 total (Phase 12-13)
- Requirements: 9 total
- Coverage: 9/9 (100%)
- Completed: 1/2 phases
- Started: 2026-02-13

| Phase | Name | Duration | Tasks | Files | Status |
|-------|------|----------|-------|-------|--------|
| 12 | Streaming Engine | ~3 min | 3 | 3 | Complete |
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

### Key Code Locations (post Phase 12)
- `callClaude()`: relay.ts line ~1704 — uses stream-json NDJSON parsing
- `CLAUDE_INACTIVITY_TIMEOUT_MS`: relay.ts line 70 — 15 min (stream-json events reset timer)
- `killOrphanedProcesses()`: relay.ts line 76 — orphan cleanup after timeout
- `resetInactivityTimer()`: relay.ts — resets on every stream-json event from stdout
- Typing action: sent once per handler at lines ~2113, ~2151, ~2202, ~2244

## Decisions

- Used ReadableStream.getReader() for stdout parsing (native Bun API, no extra deps)
- Session ID captured from system/init event with fallback to any event with session_id
- Stderr no longer used for activity detection -- stdout NDJSON events are more reliable

## Session Continuity

**Last session:** 2026-02-13 -- Completed Phase 12 Streaming Engine
**Stopped at:** Completed 12-streaming-engine-PLAN.md

**Next action:** Run `/gsd:plan-phase 13` to create execution plan for Liveness & Progress phase

**Context for next session:**
- Phase 12 complete: callClaude() now uses stream-json NDJSON parsing
- All callers (handlers, heartbeat, cron, summary) work unchanged
- Phase 13 will add typing indicators and progress messages on top of the streaming infrastructure
- Stream events are available for Phase 13 to hook into (assistant events for typing, tool_use for progress)

---

*Created: 2026-02-13*
