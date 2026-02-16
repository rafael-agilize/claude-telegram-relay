# Requirements: Claude Telegram Relay

**Defined:** 2026-02-16
**Core Value:** Full-featured Telegram relay to Claude Code CLI with streaming, memory, proactive agent, semantic search, real-time feedback, and self-evolving personality

## v1.5 Requirements

Requirements for security hardening release. Each maps to roadmap phases.

### Edge Function Security

- [ ] **EDGE-01**: Edge Functions verify caller carries service_role JWT before processing requests
- [ ] **EDGE-02**: Embed function fetches content from DB by row ID instead of trusting client-supplied content
- [ ] **EDGE-03**: Search function clamps match_count (max 20) and match_threshold (min 0.5)
- [ ] **EDGE-04**: Edge Functions return generic error messages to callers; detailed errors logged server-side only

### Intent Injection Defense

- [ ] **INTENT-01**: processIntents() accepts a context parameter that restricts which intent types are allowed per execution context (interactive, heartbeat, cron)
- [ ] **INTENT-02**: Heartbeat and cron execution contexts disable CRON and FORGET intents (silently dropped)
- [ ] **INTENT-03**: Agent-created cron jobs ([CRON:] intent) send a Telegram confirmation message; job only activates after user approves

### Intent Validation

- [ ] **VALID-01**: FORGET requires minimum 10-character search text and matching entry must have >50% content overlap with search text
- [ ] **VALID-02**: Per-response intent caps enforced (max 5 REMEMBER, 3 GOAL, 1 CRON, 3 FORGET) with content deduplication

### Relay Input Hardening

- [ ] **INPUT-01**: /soul command caps content at 2000 characters with user feedback on rejection
- [ ] **INPUT-02**: Memory entry count capped at 100 facts and 50 goals; oldest entries evicted when limit reached
- [ ] **INPUT-03**: sanitizeFilename uses allowlist regex replacing non-`[a-zA-Z0-9._-]` characters with `_` and strips null bytes

### Process Safety

- [ ] **PROC-01**: Lock file acquisition fails immediately on "wx" error — no fallback non-atomic overwrite path

## Future Requirements

None — this is a focused security patch.

## Out of Scope

| Feature | Reason |
|---------|--------|
| RLS policies on Supabase tables | Service role key bypasses RLS by design; auth gate is at Edge Function level |
| End-to-end encryption of memories | Overkill for single-user; auth gate sufficient |
| Prompt injection detection model | Complex ML approach; context-aware allowlisting is pragmatic and effective |
| Rate limiting on Edge Functions | Supabase API gateway already rate-limits; auth gate blocks unauthorized callers |
| User confirmation for REMEMBER/GOAL intents | Low-risk intents; caps + dedup sufficient |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EDGE-01 | Phase 23 | Pending |
| EDGE-02 | Phase 23 | Pending |
| EDGE-03 | Phase 23 | Pending |
| EDGE-04 | Phase 23 | Pending |
| INTENT-01 | Phase 24 | Pending |
| INTENT-02 | Phase 24 | Pending |
| INTENT-03 | Phase 24 | Pending |
| VALID-01 | Phase 25 | Pending |
| VALID-02 | Phase 25 | Pending |
| INPUT-01 | Phase 25 | Pending |
| INPUT-02 | Phase 25 | Pending |
| INPUT-03 | Phase 25 | Pending |
| PROC-01 | Phase 25 | Pending |

**Coverage:**
- v1.5 requirements: 13 total
- Mapped to phases: 13
- Unmapped: 0

**Phase mapping:**
- Phase 23 (Edge Function Security): 4 requirements
- Phase 24 (Intent Injection Defense): 3 requirements
- Phase 25 (Intent Validation + Input Hardening): 6 requirements

---
*Requirements defined: 2026-02-16*
*Last updated: 2026-02-16 after roadmap creation*
