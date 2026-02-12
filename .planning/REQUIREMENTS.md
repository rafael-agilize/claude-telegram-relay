# Requirements: Claude Telegram Relay

**Defined:** 2026-02-12
**Core Value:** Proactive agent that checks in and schedules tasks without waiting for user input

## v1.1 Requirements

Requirements for Milestone v1.1: Heartbeat & Proactive Agent. Each maps to roadmap phases.

### Heartbeat

- [ ] **HB-01**: Bot runs a periodic heartbeat loop at configurable interval (default 1h)
- [ ] **HB-02**: Heartbeat reads HEARTBEAT.md file from workspace as checklist for what to check
- [ ] **HB-03**: Bot detects HEARTBEAT_OK token in Claude response and suppresses message delivery (nothing to report)
- [ ] **HB-04**: Heartbeat respects active hours window (configurable start/end time + timezone, default 08:00-22:00)
- [ ] **HB-05**: Heartbeat messages are delivered to a dedicated "Heartbeat" topic thread in the Telegram group
- [ ] **HB-06**: Identical heartbeat messages are deduplicated within a 24-hour window
- [ ] **HB-07**: Heartbeat configuration (interval, active hours, enabled/disabled) is stored in Supabase

### Cron Scheduler

- [ ] **CRON-01**: Cron jobs are stored in a new `cron_jobs` Supabase table (id, name, schedule, prompt, target_thread, enabled, created_at)
- [ ] **CRON-02**: User can create cron jobs with 5-field cron expressions (e.g., `0 7 * * *`) via croner library
- [ ] **CRON-03**: User can create one-shot timer jobs (e.g., "in 20 minutes")
- [ ] **CRON-04**: User can create fixed-interval jobs (e.g., "every 2 hours")
- [ ] **CRON-05**: Cron job execution spawns a Claude call with the job's prompt in the job's target thread context
- [ ] **CRON-06**: Cron job results are delivered to the job's target thread (or DM if no thread specified)

### Cron Management

- [ ] **CMGMT-01**: User can add cron jobs via `/cron add <schedule> <prompt>` Telegram command
- [ ] **CMGMT-02**: User can list active cron jobs via `/cron list` Telegram command
- [ ] **CMGMT-03**: User can remove cron jobs via `/cron remove <id>` Telegram command
- [ ] **CMGMT-04**: User can configure heartbeat/cron via HEARTBEAT.md file (read on each heartbeat cycle)

### Agent Self-Scheduling

- [ ] **AGENT-01**: Claude can create cron jobs via `[CRON: <schedule> | <prompt>]` intent tag in responses
- [ ] **AGENT-02**: Agent-created jobs are stored in Supabase identically to user-created jobs (with source=agent marker)
- [ ] **AGENT-03**: Claude receives instructions in its system prompt about the [CRON:] intent capability

### Schema & Infrastructure

- [ ] **INFRA-01**: New `cron_jobs` Supabase table with migration SQL
- [ ] **INFRA-02**: New `heartbeat_config` row/table in Supabase for heartbeat settings
- [ ] **INFRA-03**: Heartbeat and cron events logged in logs_v2 table
- [ ] **INFRA-04**: Heartbeat timer integrates with existing relay lifecycle (starts on boot, stops on shutdown)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Advanced Automation

- **AUTO-01**: Webhook-triggered heartbeats (external events wake the agent)
- **AUTO-02**: Cron job chaining (output of one job feeds into another)
- **AUTO-03**: Cron job templates (pre-built common patterns like "morning briefing")

### Monitoring

- **MON-01**: Heartbeat health dashboard in Telegram (uptime, last run, cost)
- **MON-02**: Cron job execution history viewable via Telegram command

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-user cron | Single authorized user only, no need for per-user scheduling |
| Web-based cron management | Telegram commands + file config is sufficient |
| Sub-minute cron intervals | Unnecessary precision, wasteful API calls |
| Heartbeat model override | Single model (Claude CLI), no need for per-heartbeat model selection |
| Isolated cron sessions | Our relay reuses thread sessions; OpenClaw-style isolation is overkill |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 6 | Pending |
| INFRA-02 | Phase 6 | Pending |
| INFRA-03 | Phase 6 | Pending |
| INFRA-04 | Phase 6 | Pending |
| HB-01 | Phase 7 | Pending |
| HB-02 | Phase 7 | Pending |
| HB-03 | Phase 7 | Pending |
| HB-06 | Phase 7 | Pending |
| HB-04 | Phase 8 | Pending |
| HB-05 | Phase 8 | Pending |
| HB-07 | Phase 8 | Pending |
| CRON-01 | Phase 9 | Pending |
| CRON-02 | Phase 9 | Pending |
| CRON-03 | Phase 9 | Pending |
| CRON-04 | Phase 9 | Pending |
| CRON-05 | Phase 9 | Pending |
| CRON-06 | Phase 9 | Pending |
| CMGMT-01 | Phase 10 | Pending |
| CMGMT-02 | Phase 10 | Pending |
| CMGMT-03 | Phase 10 | Pending |
| CMGMT-04 | Phase 10 | Pending |
| AGENT-01 | Phase 11 | Pending |
| AGENT-02 | Phase 11 | Pending |
| AGENT-03 | Phase 11 | Pending |

**Coverage:**
- v1.1 requirements: 24 total
- Mapped to phases: 24/24 (100%)
- Unmapped: 0

---
*Requirements defined: 2026-02-12*
*Last updated: 2026-02-12 after roadmap creation*
