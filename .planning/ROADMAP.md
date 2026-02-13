# ROADMAP.md

## Active Milestone: v1.2 — Streaming & Long-Running Task Resilience

**Goal:** Make the relay robust for complex, long-running Claude CLI tasks.
**Started:** 2026-02-13

### Phases

| Phase | Name | Goal | Requirements | Depends On |
|-------|------|------|--------------|------------|
| 12 | Streaming Engine | Replace JSON output with stream-json parsing and activity-based timeout | STREAM-01, STREAM-02, STREAM-03, TIMEOUT-01, TIMEOUT-02 | — |
| 13 | Liveness & Progress | Keep Telegram showing activity and send progress updates during long tasks | LIVE-01, LIVE-02, PROG-01, PROG-02 | Phase 12 |

### Phase Details

**Phase 12 — Streaming Engine**
Core refactor of `callClaude()`. Switch from `--output-format json` to `--output-format stream-json --verbose`. Parse NDJSON lines incrementally, extract session_id from `init` event, collect final result from `result` event, and reset inactivity timer on every event. Bump timeout to 15 min. Ensure orphan cleanup still works. This phase produces a working relay that behaves identically to before but with streaming internals.

**Phase 13 — Liveness & Progress**
Add a typing indicator interval (every 4-5s) that runs while Claude is working. Parse `assistant` events with `tool_use` content to extract tool names, and send throttled progress messages to Telegram (max 1 per 15s). Stop all indicators on completion or timeout. This phase requires Phase 12's streaming infrastructure to be in place.

### Dependencies

```
Phase 12 (Streaming Engine)
  └─> Phase 13 (Liveness & Progress)
```

### Coverage

| Requirement | Phase |
|-------------|-------|
| STREAM-01 | 12 |
| STREAM-02 | 12 |
| STREAM-03 | 12 |
| TIMEOUT-01 | 12 |
| TIMEOUT-02 | 12 |
| LIVE-01 | 13 |
| LIVE-02 | 13 |
| PROG-01 | 13 |
| PROG-02 | 13 |

**Coverage:** 9/9 requirements mapped (100%)

## Completed Milestones

- **v1.0** — Conversational Threading & Memory System (Phases 1-5, completed 2026-02-10). Delivered threaded conversations, three-layer memory, voice I/O.
- **v1.1** — Heartbeat & Proactive Agent (Phases 6-11, completed 2026-02-12). Delivered heartbeat system, cron engine, cron management, agent self-scheduling. [Archive](milestones/v1.1-ROADMAP.md)

---

*Last updated: 2026-02-13 — Milestone v1.2 created*
