# STATE.md

## Current Position

Phase: 9 - Cron Engine
Plan: Not yet planned
Status: Ready to plan
Last activity: 2026-02-12 -- Phase 8 executed and verified (3/6 phases complete)

**Progress:** [██████████░░░░░░░░░░] 3/6 phases

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-12)

**Core value:** Proactive agent that checks in and schedules tasks without waiting for user input
**Current focus:** Milestone v1.1 -- Heartbeat & Proactive Agent

## Performance Metrics

**Milestone v1.1:**
- Phases: 6 total (Phase 6-11)
- Requirements: 24 total
- Coverage: 24/24 (100%)
- Completed: 3/6 phases
- Started: 2026-02-12

| Phase | Name | Duration | Tasks | Files | Status |
|-------|------|----------|-------|-------|--------|
| 6 | Schema & Infrastructure | N/A | 5 | 2 | ✅ Complete |
| 7 | Heartbeat Core | 1m 54s | 4 | 3 | ✅ Complete |
| 8 | Heartbeat Refinement | ~2m | 3 | 2 | ✅ Complete |

**Milestone 1 (archived):**
- Phases: 5 total (Phase 1-5)
- Status: Complete (2026-02-10)
- Delivered: Conversational threading, three-layer memory, voice I/O

## Accumulated Context

### From Milestone 1
- Relay architecture: single-file relay.ts (~730 lines), Bun runtime
- Threading: per-thread Claude sessions via --resume, stored in Supabase
- Memory: soul + global_memory + thread summary + recent messages
- Intent system: [LEARN:], [FORGET:], [VOICE_REPLY] parsed in processIntents()
- Voice: Groq Whisper transcription + ElevenLabs TTS
- Schema: threads, thread_messages, global_memory, bot_soul, logs_v2 tables

### From OpenClaw Research
- Heartbeat: periodic agent turns with HEARTBEAT.md checklist, HEARTBEAT_OK suppression
- Cron: croner library for 5-field expressions, isolated sessions per job
- Active hours: timezone-aware gating, configurable start/end
- Deduplication: identical heartbeat messages suppressed within 24h window
- Agent scheduling: [CRON: ...] intent allows Claude to create its own jobs

### From Phase 7 Implementation
- Heartbeat loop fully functional: reads HEARTBEAT.md, calls Claude standalone, handles suppression
- HEARTBEAT_OK detection: exact match OR substring (handles mixed responses)
- 24h deduplication: queries logs_v2 for heartbeat_delivered events with matching message_text
- Guard flag pattern: heartbeatRunning prevents overlapping calls if Claude takes longer than interval
- Graceful degradation: missing HEARTBEAT.md → skip silently; Supabase down → fail open (deliver)
- Intent processing in heartbeat: [LEARN:] and [FORGET:] work in heartbeat context
- Event types: heartbeat_tick, heartbeat_ok, heartbeat_delivered, heartbeat_dedup, heartbeat_skip, heartbeat_error

### From Phase 8 Implementation
- Active hours gating: isWithinActiveHours() uses Intl.DateTimeFormat for timezone-aware comparison
- Handles both normal ranges (08:00-22:00) and overnight ranges (22:00-06:00)
- Defaults: America/Sao_Paulo timezone, 08:00-22:00 window
- Dedicated heartbeat thread: getOrCreateHeartbeatTopic() finds/creates "Heartbeat" forum topic
- Three-tier topic lookup: module cache → Supabase query → Grammy createForumTopic() API
- Fallback chain: no group → DM, topic creation fail → DM, topic deleted → reset cache + DM
- TELEGRAM_GROUP_ID env var controls routing (optional, falls back to DM)
- Config re-read on each tick: Supabase changes take effect next cycle without restart

### Key Decisions for v1.1
- Dedicated heartbeat thread in Telegram group (keeps proactive messages separate)
- 1h default heartbeat interval (balance responsiveness vs API cost)
- croner library for cron expressions (same as OpenClaw, 5-field + timezone support)
- Both Telegram commands + HEARTBEAT.md file for cron management (phone + power user access)
- Agent can self-schedule via [CRON: ...] intent (true proactivity)

## Decisions

1. **Phase 7: heartbeatRunning guard flag** — Prevents overlapping heartbeat calls if Claude takes longer than interval. Uses finally block to ensure flag is always reset.
2. **Phase 7: Fail-open deduplication** — If Supabase query fails, delivers message rather than suppressing to avoid losing legitimate messages.
3. **Phase 7: HEARTBEAT_OK substring matching** — Detects HEARTBEAT_OK as exact match OR substring to handle cases where Claude includes token with other text.
4. **Phase 8: Module-level topic cache** — heartbeatTopicId cached to avoid Supabase lookup on every heartbeat tick. Reset on topic deletion.
5. **Phase 8: Triple fallback for heartbeat delivery** — Topic thread → DM (on topic error) → plain text (on HTML parse error). Ensures messages are never lost.

## Session Continuity

**Next action:** Run `/gsd:plan-phase 9` to plan the cron engine

**Context for next session:**
- Heartbeat stack complete (Phases 6-8): schema, core loop, active hours, dedicated thread
- Cron stack starts: Phase 9 (engine), Phase 10 (management), Phase 11 (agent scheduling)
- cron_jobs table already exists from Phase 6 migration
- croner library planned for 5-field cron expressions
- Need: cron tick loop, job execution via Claude calls, one-shot/interval/cron schedule types

---

*Created: 2026-02-12*
*Last updated: 2026-02-12 after Phase 8 execution*
