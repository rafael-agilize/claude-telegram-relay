# Roadmap: Claude Telegram Relay

## Milestones

- ✅ **v1.0 MVP** — Phases 1-5 (shipped 2026-02-10)
- ✅ **v1.1 Heartbeat & Proactive Agent** — Phases 6-11 (shipped 2026-02-12)
- ✅ **v1.2 Streaming & Long-Running Tasks** — Phases 12-13 (shipped 2026-02-13)
- ✅ **v1.3 Smart Memory** — Phases 14-16 (shipped 2026-02-13)
- ✅ **v1.4 Soul Evolution** — Phases 17-22 (shipped 2026-02-16)
- 🚧 **v1.5 Security Hardening** — Phases 23-25 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-5) — SHIPPED 2026-02-10</summary>

- [x] Phase 1: Thread Infrastructure (3/3 plans)
- [x] Phase 2: Memory System (2/2 plans)
- [x] Phase 3: Voice I/O (2/2 plans)
- [x] Phase 4: Intent System (2/2 plans)
- [x] Phase 5: Thread Context Assembly (1/1 plan)

</details>

<details>
<summary>✅ v1.1 Heartbeat & Proactive Agent (Phases 6-11) — SHIPPED 2026-02-12</summary>

- [x] Phase 6: Heartbeat Foundation (2/2 plans)
- [x] Phase 7: Heartbeat Core Logic (3/3 plans)
- [x] Phase 8: Cron Schema & Storage (1/1 plan)
- [x] Phase 9: Cron Scheduler Engine (2/2 plans)
- [x] Phase 10: Cron Management Commands (2/2 plans)
- [x] Phase 11: Agent Self-Scheduling (2/2 plans)

</details>

<details>
<summary>✅ v1.2 Streaming & Long-Running Tasks (Phases 12-13) — SHIPPED 2026-02-13</summary>

- [x] Phase 12: Stream-JSON Parsing Engine (2/2 plans)
- [x] Phase 13: Real-Time Feedback (2/2 plans)

</details>

<details>
<summary>✅ v1.3 Smart Memory (Phases 14-16) — SHIPPED 2026-02-13</summary>

- [x] Phase 14: Typed Memory System (2/2 plans)
- [x] Phase 15: Goals Lifecycle (2/2 plans)
- [x] Phase 16: Semantic Search (3/3 plans)

</details>

<details>
<summary>✅ v1.4 Soul Evolution (Phases 17-22) — SHIPPED 2026-02-16</summary>

- [x] Phase 17: Three-Layer Soul Schema (2/2 plans) — completed 2026-02-15
- [x] Phase 18: Prompt Integration (2/2 plans) — completed 2026-02-16
- [x] Phase 19: Daily Evolution Engine (2/2 plans) — completed 2026-02-16
- [x] Phase 20: Milestone Moments (2/2 plans) — completed 2026-02-16
- [x] Phase 21: Evolution Controls (2/2 plans) — completed 2026-02-16
- [x] Phase 22: Growth Safeguards (2/2 plans) — completed 2026-02-16

</details>

### 🚧 v1.5 Security Hardening (In Progress)

**Milestone Goal:** Fix all 13 security vulnerabilities from full audit (4 HIGH, 9 MEDIUM) without breaking existing capabilities.

- [x] **Phase 23: Edge Function Security** — Authenticated, validated, and hardened Edge Functions (completed 2026-02-17)
- [x] **Phase 24: Intent Injection Defense** — Context-aware intent restrictions with user confirmation (completed 2026-02-17)
- [x] **Phase 25: Intent Validation + Input Hardening** — Validated intents, capped inputs, atomic locks (completed 2026-02-17)

## Phase Details

### Phase 23: Edge Function Security
**Goal**: Authenticated, validated, and hardened Edge Functions
**Depends on**: Nothing (security foundation)
**Requirements**: EDGE-01, EDGE-02, EDGE-03, EDGE-04
**Success Criteria** (what must be TRUE):
  1. Edge Functions reject requests without service_role JWT
  2. Embed function fetches content from database, never trusts client input
  3. Search function enforces match_count ≤ 20 and match_threshold ≥ 0.5
  4. Edge Function errors return generic messages to callers, detailed logs stay server-side
**Plans**: 2 plans

Plans:
- [ ] 23-01-PLAN.md — Auth guards + error sanitization (EDGE-01, EDGE-04)
- [ ] 23-02-PLAN.md — Input validation hardening (EDGE-02, EDGE-03)

### Phase 24: Intent Injection Defense
**Goal**: Context-aware intent restrictions with user confirmation
**Depends on**: Phase 23
**Requirements**: INTENT-01, INTENT-02, INTENT-03
**Success Criteria** (what must be TRUE):
  1. Heartbeat and cron contexts cannot create new cron jobs or delete memories
  2. Agent-created cron jobs require user approval before activation
  3. processIntents() enforces context-specific allowlists (interactive allows all, heartbeat/cron restricted)
**Plans**: 2 plans

Plans:
- [ ] 24-01-PLAN.md — Context-aware intent allowlists in processIntents() (INTENT-01, INTENT-02)
- [ ] 24-02-PLAN.md — Agent cron confirmation flow with inline buttons (INTENT-03)

### Phase 25: Intent Validation + Input Hardening
**Goal**: Validated intents, capped inputs, atomic locks
**Depends on**: Phase 24
**Requirements**: VALID-01, VALID-02, INPUT-01, INPUT-02, INPUT-03, PROC-01
**Success Criteria** (what must be TRUE):
  1. FORGET requires 10+ char search text and 50%+ content overlap to match
  2. Per-response caps enforced (max 5 REMEMBER, 3 GOAL, 1 CRON, 3 FORGET) with content deduplication
  3. /soul command rejects content >2000 chars with user feedback
  4. Memory capped at 100 facts + 50 goals with automatic eviction of oldest entries
  5. Filename sanitization uses allowlist regex, strips null bytes
**Plans**: 2 plans

Plans:
- [ ] 25-01-PLAN.md — Intent validation: FORGET safety guards + per-response intent caps with dedup
- [ ] 25-02-PLAN.md — Input hardening: /soul cap, memory eviction, filename allowlist, atomic lock

## Progress

**Execution Order:**
Phases execute in numeric order: 23 → 24 → 25

| Phase | Milestone | Plans | Status | Completed |
|-------|-----------|-------|--------|-----------|
| 1. Thread Infrastructure | v1.0 | 3/3 | Complete | 2026-02-10 |
| 2. Memory System | v1.0 | 2/2 | Complete | 2026-02-10 |
| 3. Voice I/O | v1.0 | 2/2 | Complete | 2026-02-10 |
| 4. Intent System | v1.0 | 2/2 | Complete | 2026-02-10 |
| 5. Thread Context Assembly | v1.0 | 1/1 | Complete | 2026-02-10 |
| 6. Heartbeat Foundation | v1.1 | 2/2 | Complete | 2026-02-12 |
| 7. Heartbeat Core Logic | v1.1 | 3/3 | Complete | 2026-02-12 |
| 8. Cron Schema & Storage | v1.1 | 1/1 | Complete | 2026-02-12 |
| 9. Cron Scheduler Engine | v1.1 | 2/2 | Complete | 2026-02-12 |
| 10. Cron Management Commands | v1.1 | 2/2 | Complete | 2026-02-12 |
| 11. Agent Self-Scheduling | v1.1 | 2/2 | Complete | 2026-02-12 |
| 12. Stream-JSON Parsing Engine | v1.2 | 2/2 | Complete | 2026-02-13 |
| 13. Real-Time Feedback | v1.2 | 2/2 | Complete | 2026-02-13 |
| 14. Typed Memory System | v1.3 | 2/2 | Complete | 2026-02-13 |
| 15. Goals Lifecycle | v1.3 | 2/2 | Complete | 2026-02-13 |
| 16. Semantic Search | v1.3 | 3/3 | Complete | 2026-02-13 |
| 17. Three-Layer Soul Schema | v1.4 | 2/2 | Complete | 2026-02-15 |
| 18. Prompt Integration | v1.4 | 2/2 | Complete | 2026-02-16 |
| 19. Daily Evolution Engine | v1.4 | 2/2 | Complete | 2026-02-16 |
| 20. Milestone Moments | v1.4 | 2/2 | Complete | 2026-02-16 |
| 21. Evolution Controls | v1.4 | 2/2 | Complete | 2026-02-16 |
| 22. Growth Safeguards | v1.4 | 2/2 | Complete | 2026-02-16 |
| 23. Edge Function Security | v1.5 | Complete    | 2026-02-17 | - |
| 24. Intent Injection Defense | v1.5 | Complete    | 2026-02-17 | - |
| 25. Intent Validation + Input Hardening | v1.5 | Complete    | 2026-02-17 | - |

---

*Last updated: 2026-02-16 — v1.5 Security Hardening roadmap created*
