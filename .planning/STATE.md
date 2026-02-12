# STATE.md

## Current Position

Phase: 11 - Agent Scheduling
Plan: 1 plan in 1 wave (PLAN.md)
Status: Complete
Last activity: 2026-02-12 -- Phase 11 executed (6/6 phases complete, milestone v1.1 done)

**Progress:** [████████████████████] 6/6 phases

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-12)

**Core value:** Proactive agent that checks in and schedules tasks without waiting for user input
**Current focus:** Milestone v1.1 -- Heartbeat & Proactive Agent (COMPLETE)

## Performance Metrics

**Milestone v1.1:**
- Phases: 6 total (Phase 6-11)
- Requirements: 24 total
- Coverage: 24/24 (100%)
- Completed: 6/6 phases
- Started: 2026-02-12

| Phase | Name | Duration | Tasks | Files | Status |
|-------|------|----------|-------|-------|--------|
| 6 | Schema & Infrastructure | N/A | 5 | 2 | ✅ Complete |
| 7 | Heartbeat Core | 1m 54s | 4 | 3 | ✅ Complete |
| 8 | Heartbeat Refinement | ~2m | 3 | 2 | ✅ Complete |
| 9 | Cron Engine | ~2m | 2 | 3 | ✅ Complete |
| 10 | Cron Management | ~2m | 3 | 3 | ✅ Complete |
| 11 | Agent Scheduling | ~2m | 3 | 2 | ✅ Complete |

**Milestone 1 (archived):**
- Phases: 5 total (Phase 1-5)
- Status: Complete (2026-02-10)
- Delivered: Conversational threading, three-layer memory, voice I/O

## Accumulated Context

### From Milestone 1
- Relay architecture: single-file relay.ts (~730 lines), Bun runtime
- Threading: per-thread Claude sessions via --resume, stored in Supabase
- Memory: soul + global_memory + thread summary + recent messages
- Intent system: [LEARN:], [FORGET:], [VOICE_REPLY], [CRON:] parsed in processIntents()
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

### From Phase 9 Implementation
- Cron engine: 8 functions added to relay.ts (cronTick, computeNextRun, isJobDue, getThreadInfoForCronJob, sendCronResultToTelegram, executeCronJob, startCronScheduler, stopCronScheduler)
- Three schedule types: cron (5-field via croner), interval ("every 2h" regex), once ("in 20m" regex)
- cronTick fires every 60s, polls cron_jobs table, checks next_run_at to determine due jobs
- cronRunning guard prevents overlapping ticks (same pattern as heartbeatRunning)
- executeCronJob: builds prompt with soul + memory + thread context, calls Claude, processes intents, delivers result
- One-shot jobs auto-disable after execution
- Cron results prefixed with [Cron: job_name] header for user clarity
- Event types: cron_executed, cron_delivered, cron_error
- Lifecycle: startCronScheduler() in onStart, stopCronScheduler() in SIGINT/SIGTERM
- croner v10.0.1 installed for 5-field cron expression parsing

### From Phase 10 Implementation
- /cron command: add, list, remove, enable, disable subcommands
- detectScheduleType(): auto-classifies schedule strings into cron/interval/once
- createCronJob(): inserts job with computed initial next_run_at
- getAllCronJobs(): returns all jobs (enabled + disabled) for listing
- deleteCronJob(): hard-deletes job from database
- List uses numbered positions (not UUIDs) for usability
- Schedule format: quoted schedule + prompt (e.g., /cron add "0 7 * * *" morning briefing)
- HEARTBEAT.md cron sync: parseCronJobsFromChecklist() + syncCronJobsFromFile()
- File-based cron definitions in ## Cron Jobs section (format: - "schedule" prompt)
- Sync is idempotent: creates new, updates changed schedules, disables removed
- source='file' distinguishes file-sourced jobs from user/agent
- Migration: cron_jobs_source_check updated to include 'file'
- Event types added: cron_created, cron_deleted

### From Phase 11 Implementation
- [CRON: schedule | prompt] intent tag parsing in processIntents()
- Regex: \[CRON:\s*(.+?)\s*\|\s*(.+?)\] captures schedule and prompt
- Uses existing detectScheduleType() and createCronJob() with source='agent'
- Prompt length capped at 500 chars for security
- buildPrompt() has full SCHEDULING section with syntax, formats, and examples
- buildHeartbeatPrompt() has compact one-line CRON intent mention
- Three cron sources complete: user (/cron), file (HEARTBEAT.md), agent ([CRON:] intent)

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
6. **Phase 9: Sequential job execution** — Jobs execute sequentially within a tick to prevent concurrent Claude CLI calls. cronRunning guard prevents overlapping ticks.
7. **Phase 9: Manual regex for interval/once** — croner only used for 5-field cron expressions. Interval ("every Xh Ym") and once ("in Xh Ym") parsed via simple regex.
8. **Phase 10: Numbered position for job references** — /cron remove/enable/disable use list position (1-based) instead of UUIDs for usability from a phone keyboard.
9. **Phase 10: File sync matched by prompt** — HEARTBEAT.md cron jobs matched to database by exact prompt text. Changed prompt = new job. Keeps sync deterministic.
10. **Phase 10: Disabled not deleted on file removal** — File-sourced jobs removed from HEARTBEAT.md are disabled, not deleted. Preserves execution history and logs.
11. **Phase 11: Prompt length cap** — CRON intent prompt capped at 500 chars to prevent abuse while being generous enough for real use cases.

## Session Continuity

**Next action:** Run `/gsd:complete-milestone` to archive milestone v1.1

**Context for next session:**
- All 6 phases complete, all 24 requirements delivered
- Milestone v1.1 delivers: heartbeat, cron engine, cron management, agent scheduling
- Ready for milestone archival and planning next milestone

---

*Created: 2026-02-12*
*Last updated: 2026-02-12 after Phase 11 execution*
