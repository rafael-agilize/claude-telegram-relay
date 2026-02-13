---
phase: 12-streaming-engine
plan: 01
subsystem: relay-core
tags: [streaming, ndjson, timeout, callClaude]
dependency_graph:
  requires: []
  provides:
    - "stream-json NDJSON output in callClaude()"
    - "Event-based inactivity timer (15 min)"
    - "Infrastructure for Phase 13 typing indicators"
  affects:
    - "All callClaude() callers (handlers, heartbeat, cron, summary)"
tech_stack:
  added: []
  patterns:
    - "NDJSON line-by-line streaming with partial line buffer"
    - "ReadableStream chunked reading via getReader()"
key_files:
  created: []
  modified:
    - src/relay.ts
    - CLAUDE.md
    - .planning/STATE.md
decisions:
  - "Used ReadableStream.getReader() for stdout parsing (native Bun API, no extra deps)"
  - "Session ID captured from system/init event with fallback to any event with session_id"
  - "Stderr no longer used for activity detection -- stdout NDJSON events are more reliable"
  - "Applied CLAUDE.md timeout/resetInactivityTimer doc fixes to STATE.md where the text actually lived"
metrics:
  duration: "~3 min"
  completed: "2026-02-13"
  tasks: 3
  files: 3
---

# Phase 12 Plan 01: Streaming Engine Summary

Stream-json NDJSON parsing in callClaude() with event-based 15-minute inactivity timer, replacing buffered JSON output and stderr-only activity detection.

## What Changed

### Task 1: Increase inactivity timeout to 15 minutes (4c4faca)
- Updated `CLAUDE_INACTIVITY_TIMEOUT_MS` from `5 * 60 * 1000` to `15 * 60 * 1000`
- Updated all timeout log messages and user-facing error messages from "5 minutes" to "15 minutes"
- Files: `src/relay.ts`

### Task 2: Refactor callClaude() to stream-json NDJSON parsing (55b5402)
- Changed CLI args from `--output-format json` to `--output-format stream-json --verbose`
- Replaced `await new Response(proc.stdout).text()` + single `JSON.parse()` with incremental NDJSON stream parsing
- Stdout chunks are read via `ReadableStream.getReader()`, accumulated in a line buffer, split on newlines
- Each complete NDJSON line is parsed individually; `resetInactivityTimer()` called on every parsed line
- Session ID extracted from `system/init` event (with fallback to any event containing `session_id`)
- Result text extracted from `result` event's `.result` field (string or content array)
- Remaining buffer content processed after stream ends (handles case where last line lacks trailing newline)
- Stderr still drained for logging but no longer drives activity detection
- Size guard applied incrementally via `totalBytes` counter during stream parsing
- Same function signature `Promise<{ text: string; sessionId: string | null }>` -- all callers unchanged
- Files: `src/relay.ts`

### Task 3: Update documentation (7b4a258)
- Updated CLAUDE.md `callClaude()` description: stream-json, NDJSON, 15-minute timeout
- Updated STATE.md key code locations: timeout value and resetInactivityTimer behavior
- Files: `CLAUDE.md`, `.planning/STATE.md`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] CLAUDE.md doc targets referenced STATE.md content**
- **Found during:** Task 3
- **Issue:** Plan Changes 2 and 3 referenced strings (`CLAUDE_INACTIVITY_TIMEOUT_MS: relay.ts line 70` and `resetInactivityTimer(): relay.ts line 1739`) that exist in `.planning/STATE.md`, not in `CLAUDE.md`
- **Fix:** Applied those documentation updates to STATE.md where the text actually lives. CLAUDE.md Change 1 was applied correctly as planned.
- **Files modified:** `.planning/STATE.md`
- **Commit:** 7b4a258

## Requirements Coverage

| Requirement | Status | Commit |
|------------|--------|--------|
| STREAM-01: stream-json output format | Done | 55b5402 |
| STREAM-02: NDJSON line-by-line parsing | Done | 55b5402 |
| STREAM-03: Event-based inactivity timer | Done | 55b5402 |
| TIMEOUT-01: 15-minute timeout | Done | 4c4faca |
| TIMEOUT-02: Orphan cleanup on timeout | Done | 55b5402 |

## Verification Results

1. `callClaude()` uses `--output-format stream-json --verbose` -- PASS
2. Stdout parsed as NDJSON with line-by-line splitting and partial buffer -- PASS
3. Inactivity timer resets on every parsed NDJSON line from stdout -- PASS
4. Inactivity timeout is 15 minutes -- PASS
5. Orphan process cleanup still triggers on timeout -- PASS
6. Session ID extracted from system/init event -- PASS
7. Result text extracted from result event -- PASS
8. Session retry logic works (--resume failure -> fresh start) -- PASS
9. Same function signature and return type -- PASS
10. Size guard applied incrementally during stream -- PASS
11. `bun build` passes (syntax valid) -- PASS
12. CLAUDE.md documents streaming internals -- PASS

## Self-Check: PASSED

All files verified present: src/relay.ts, CLAUDE.md, .planning/STATE.md, SUMMARY.md
All commits verified: 4c4faca, 55b5402, 7b4a258
