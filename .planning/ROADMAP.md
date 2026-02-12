# ROADMAP.md — Milestone v1.1: Heartbeat & Proactive Agent

**Milestone Goal:** Make the bot proactive with periodic check-ins and scheduled tasks.

**Phases:** 6 (Phase 6-11)
**Coverage:** 24/24 v1.1 requirements mapped
**Started:** 2026-02-12

**Previous milestone:** Milestone 1 (Phases 1-5) completed 2026-02-10. Delivered conversational threading, three-layer memory, and voice I/O.

---

## Progress

| Phase | Goal | Requirements | Status |
|-------|------|--------------|--------|
| 6 - Schema & Infrastructure | Database foundation for heartbeat and cron | INFRA-01, INFRA-02, INFRA-03, INFRA-04 | Done |
| 7 - Heartbeat Core | Periodic agent loop with smart suppression | HB-01, HB-02, HB-03, HB-06 | Done |
| 8 - Heartbeat Refinement | Active hours, dedicated thread, config | HB-04, HB-05, HB-07 | Done |
| 9 - Cron Engine | Scheduled job execution system | CRON-01, CRON-02, CRON-03, CRON-04, CRON-05, CRON-06 | Done |
| 10 - Cron Management | User-facing controls via Telegram and files | CMGMT-01, CMGMT-02, CMGMT-03, CMGMT-04 | Done |
| 11 - Agent Scheduling | Claude creates its own reminders | AGENT-01, AGENT-02, AGENT-03 | Done |

---

## Phase 6: Schema & Infrastructure

**Goal:** Database tables and logging infrastructure ready for heartbeat and cron.

**Dependencies:** None (foundation phase)

**Requirements:**
- INFRA-01: New `cron_jobs` Supabase table with migration SQL
- INFRA-02: New `heartbeat_config` row/table in Supabase for heartbeat settings
- INFRA-03: Heartbeat and cron events logged in logs_v2 table
- INFRA-04: Heartbeat timer integrates with existing relay lifecycle (starts on boot, stops on shutdown)

**Success Criteria:**
1. New Supabase migration exists with `cron_jobs` table (columns: id, name, schedule, prompt, target_thread_id, enabled, created_at, source)
2. Heartbeat config is stored in Supabase (interval, active_hours_start, active_hours_end, timezone, enabled)
3. Heartbeat timer starts when relay boots and stops on clean shutdown
4. Heartbeat and cron events appear in logs_v2 table with event type and metadata

---

## Phase 7: Heartbeat Core

**Goal:** Periodic agent loop running with basic suppression logic.

**Dependencies:** Phase 6 (needs schema and lifecycle integration)

**Requirements:**
- HB-01: Bot runs a periodic heartbeat loop at configurable interval (default 1h)
- HB-02: Heartbeat reads HEARTBEAT.md file from workspace as checklist for what to check
- HB-03: Bot detects HEARTBEAT_OK token in Claude response and suppresses message delivery
- HB-06: Identical heartbeat messages are deduplicated within a 24-hour window

**Success Criteria:**
1. Bot spawns a Claude call every N minutes (interval from config, default 60)
2. HEARTBEAT.md file contents are included in the heartbeat prompt
3. When Claude response contains HEARTBEAT_OK token, no message is sent to Telegram
4. If same heartbeat message was sent in last 24h, second occurrence is suppressed
5. Heartbeat loop runs continuously in background without blocking message handlers

---

## Phase 8: Heartbeat Refinement

**Goal:** Heartbeat respects user preferences for timing and thread routing.

**Dependencies:** Phase 7 (extends heartbeat core)

**Requirements:**
- HB-04: Heartbeat respects active hours window (configurable start/end time + timezone, default 08:00-22:00)
- HB-05: Heartbeat messages are delivered to a dedicated "Heartbeat" topic thread in the Telegram group
- HB-07: Heartbeat configuration (interval, active hours, enabled/disabled) is stored in Supabase

**Success Criteria:**
1. Heartbeat checks current time against active hours window before running (timezone-aware)
2. When outside active hours, heartbeat is skipped and next run is scheduled
3. All heartbeat messages are routed to a dedicated Telegram topic thread (created automatically if missing)
4. User can enable/disable heartbeat by updating Supabase config (relay picks up changes on next cycle)

---

## Phase 9: Cron Engine

**Goal:** Scheduled jobs execute at precise times and intervals.

**Dependencies:** Phase 6 (needs schema)

**Plans:** 1 plan

Plans:
- [ ] 09-01-PLAN.md — Cron engine: schedule parsing, tick loop, execution, delivery, lifecycle integration

**Requirements:**
- CRON-01: Cron jobs are stored in a new `cron_jobs` Supabase table
- CRON-02: User can create cron jobs with 5-field cron expressions (e.g., `0 7 * * *`) via croner library
- CRON-03: User can create one-shot timer jobs (e.g., "in 20 minutes")
- CRON-04: User can create fixed-interval jobs (e.g., "every 2 hours")
- CRON-05: Cron job execution spawns a Claude call with the job's prompt in the job's target thread context
- CRON-06: Cron job results are delivered to the job's target thread (or DM if no thread specified)

**Success Criteria:**
1. Cron jobs with 5-field expressions (e.g., "0 7 * * *") execute at correct times
2. One-shot timer jobs execute once after specified delay and are auto-disabled
3. Interval jobs (e.g., "every 2h") execute repeatedly at fixed intervals
4. Each cron execution spawns Claude call with job prompt and target thread context
5. Cron output is delivered to correct Telegram thread or DM as specified

---

## Phase 10: Cron Management

**Goal:** User can create, list, and remove cron jobs via Telegram and files.

**Dependencies:** Phase 9 (needs cron engine)

**Plans:** 1 plan

Plans:
- [ ] PLAN.md — /cron commands (add/list/remove/enable/disable) + HEARTBEAT.md cron sync

**Requirements:**
- CMGMT-01: User can add cron jobs via `/cron add <schedule> <prompt>` Telegram command
- CMGMT-02: User can list active cron jobs via `/cron list` Telegram command
- CMGMT-03: User can remove cron jobs via `/cron remove <id>` Telegram command
- CMGMT-04: User can configure heartbeat/cron via HEARTBEAT.md file (read on each heartbeat cycle)

**Success Criteria:**
1. `/cron add "0 7 * * *" "morning briefing"` creates a new enabled job in database
2. `/cron list` returns all cron jobs with id, schedule, prompt, enabled status
3. `/cron remove 3` disables/deletes job with id=3 and confirms to user
4. HEARTBEAT.md file can include cron job definitions that are parsed and synced to database

---

## Phase 11: Agent Scheduling

**Goal:** Claude can create its own scheduled tasks via intent tags.

**Dependencies:** Phase 9 (needs cron engine), Phase 10 (reuses cron storage)

**Requirements:**
- AGENT-01: Claude can create cron jobs via `[CRON: <schedule> | <prompt>]` intent tag in responses
- AGENT-02: Agent-created jobs are stored in Supabase identically to user-created jobs (with source=agent marker)
- AGENT-03: Claude receives instructions in its system prompt about the [CRON:] intent capability

**Success Criteria:**
1. When Claude includes `[CRON: 0 9 * * * | check project status]` in response, job is created in database
2. Agent-created jobs have `source='agent'` field to distinguish from user-created
3. Agent-created jobs execute identically to user-created jobs
4. System prompt includes instructions on CRON intent syntax and use cases

---

## Dependencies Graph

```
Phase 6 (Schema)
  ├─→ Phase 7 (Heartbeat Core)
  │     └─→ Phase 8 (Heartbeat Refinement)
  └─→ Phase 9 (Cron Engine)
        ├─→ Phase 10 (Cron Management)
        └─→ Phase 11 (Agent Scheduling)
```

**Critical path:** 6 → 7 → 8 (heartbeat stack)
**Parallel track:** 6 → 9 → 10/11 (cron stack)

---

## Coverage

All 24 v1.1 requirements mapped:

**Heartbeat (7):** HB-01, HB-02, HB-03, HB-04, HB-05, HB-06, HB-07
**Cron (6):** CRON-01, CRON-02, CRON-03, CRON-04, CRON-05, CRON-06
**Cron Management (4):** CMGMT-01, CMGMT-02, CMGMT-03, CMGMT-04
**Agent (3):** AGENT-01, AGENT-02, AGENT-03
**Infrastructure (4):** INFRA-01, INFRA-02, INFRA-03, INFRA-04

**No orphaned requirements.**

---

*Roadmap created: 2026-02-12*
*Last updated: 2026-02-12 — Phase 11 complete, milestone v1.1 done*
