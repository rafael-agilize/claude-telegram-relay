# Requirements: Milestone v1.2 — Streaming & Long-Running Task Resilience

**Defined:** 2026-02-13
**Core Value:** Make the relay robust for complex, long-running Claude CLI tasks by switching to streaming output, keeping the user informed of progress, and eliminating premature timeouts.

## Problem Statement

When Claude works on complex tasks (deep research, multi-file edits, subagent orchestration), the relay's `callClaude()` function:
1. Uses `--output-format json` which gives zero feedback until completion
2. Monitors only stderr for activity — misses long thinking pauses where stderr is silent
3. Has a 5-minute inactivity timeout that kills healthy but slow processes
4. Sends Telegram `typing` once (expires after ~5 seconds), making the bot look dead

## Requirements

### Streaming Engine

- [ ] **STREAM-01**: Switch `callClaude()` from `--output-format json` to `--output-format stream-json --verbose`
- [ ] **STREAM-02**: Parse stream-json events incrementally — handle `system/init`, `assistant` (text + tool_use), `user` (tool_result), and `result` event types
- [ ] **STREAM-03**: Reset inactivity timer on every stream-json event (replacing stderr-only monitoring)

### Liveness Indicators

- [ ] **LIVE-01**: Send Telegram `typing` chat action every 4-5 seconds while Claude is working
- [ ] **LIVE-02**: Stop typing indicator interval when Claude finishes or times out

### Timeout Tuning

- [ ] **TIMEOUT-01**: Increase inactivity timeout from 5 minutes to 15 minutes
- [ ] **TIMEOUT-02**: Ensure orphan process cleanup (`killOrphanedProcesses`) still works with the new timeout and streaming mode

### Progress Feedback

- [ ] **PROG-01**: Send intermediate Telegram messages showing what Claude is doing — tool names parsed from `assistant` events with `tool_use` content blocks (e.g., "Reading file...", "Running command...", "Searching code...")
- [ ] **PROG-02**: Throttle progress messages to avoid spam — max 1 progress update every 15 seconds, collapsing rapid tool calls into a single message

## Technical Notes

- `stream-json` requires `--verbose` flag
- Session ID available immediately from `system/init` event (no need to wait for `result`)
- Tool names in `assistant` events at `message.content[].name` where `type === "tool_use"`
- `result` event is always last and has same structure as current `json` format
- `--include-partial-messages` is NOT needed (we only need complete turn events, not token-by-token)
- Heartbeat and cron callers also use `callClaude()` — they get streaming benefits for free

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| STREAM-01 | TBD | Pending |
| STREAM-02 | TBD | Pending |
| STREAM-03 | TBD | Pending |
| LIVE-01 | TBD | Pending |
| LIVE-02 | TBD | Pending |
| TIMEOUT-01 | TBD | Pending |
| TIMEOUT-02 | TBD | Pending |
| PROG-01 | TBD | Pending |
| PROG-02 | TBD | Pending |

**Coverage:** 0/9

## Deferred

- **STREAM-PARTIAL**: Token-by-token text streaming to Telegram (send text as it arrives) — adds complexity, defer to v1.3
- **PROG-EDIT**: Show intermediate message with edit summary when Claude edits files — needs careful formatting
- **COST-01**: Show API cost from `result` event after each interaction — nice-to-have

---

*Created: 2026-02-13*
