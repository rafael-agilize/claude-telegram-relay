# Roadmap: Claude Telegram Relay

## Milestones

- ✅ **v1.0 MVP** - Phases 1-5 (shipped 2026-02-10)
- ✅ **v1.1 Heartbeat & Proactive Agent** - Phases 6-11 (shipped 2026-02-12)
- ✅ **v1.2 Streaming & Long-Running Tasks** - Phases 12-13 (shipped 2026-02-13)
- ✅ **v1.3 Smart Memory** - Phases 14-16 (shipped 2026-02-13)
- 🚧 **v1.4 Soul Evolution** - Phases 17-22 (in progress)

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

<details>
<summary>✅ v1.0 MVP (Phases 1-5) - SHIPPED 2026-02-10</summary>

### Phase 1: Thread Infrastructure
**Goal**: Per-thread Claude sessions with Supabase state
**Plans**: 3 plans
**Status**: Complete

### Phase 2: Memory System
**Goal**: Three-layer memory (recent messages, thread summary, global memory)
**Plans**: 2 plans
**Status**: Complete

### Phase 3: Voice I/O
**Goal**: Voice transcription and TTS responses
**Plans**: 2 plans
**Status**: Complete

### Phase 4: Intent System
**Goal**: Parse and execute intent tags from Claude responses
**Plans**: 2 plans
**Status**: Complete

### Phase 5: Thread Context Assembly
**Goal**: buildPrompt() assembles all memory layers
**Plans**: 1 plan
**Status**: Complete

</details>

<details>
<summary>✅ v1.1 Heartbeat & Proactive Agent (Phases 6-11) - SHIPPED 2026-02-12</summary>

### Phase 6: Heartbeat Foundation
**Goal**: Periodic agent check-ins with HEARTBEAT.md checklist
**Plans**: 2 plans
**Status**: Complete

### Phase 7: Heartbeat Core Logic
**Goal**: Smart suppression, active hours, dedicated thread
**Plans**: 3 plans
**Status**: Complete

### Phase 8: Cron Schema & Storage
**Goal**: Database tables for scheduled jobs
**Plans**: 1 plan
**Status**: Complete

### Phase 9: Cron Scheduler Engine
**Goal**: Three schedule types (cron/interval/once) with execution
**Plans**: 2 plans
**Status**: Complete

### Phase 10: Cron Management Commands
**Goal**: Telegram commands for job lifecycle
**Plans**: 2 plans
**Status**: Complete

### Phase 11: Agent Self-Scheduling
**Goal**: [CRON:] intent and file-based sync
**Plans**: 2 plans
**Status**: Complete

</details>

<details>
<summary>✅ v1.2 Streaming & Long-Running Tasks (Phases 12-13) - SHIPPED 2026-02-13</summary>

### Phase 12: Stream-JSON Parsing Engine
**Goal**: Activity-based timeout with NDJSON parsing
**Plans**: 2 plans
**Status**: Complete

### Phase 13: Real-Time Feedback
**Goal**: Typing indicators and tool progress messages
**Plans**: 2 plans
**Status**: Complete

</details>

<details>
<summary>✅ v1.3 Smart Memory (Phases 14-16) - SHIPPED 2026-02-13</summary>

### Phase 14: Typed Memory System
**Goal**: Facts, goals, preferences with structured storage
**Plans**: 2 plans
**Status**: Complete

### Phase 15: Goals Lifecycle
**Goal**: [GOAL:] and [DONE:] intents with deadline tracking
**Plans**: 2 plans
**Status**: Complete

### Phase 16: Semantic Search
**Goal**: Vector embeddings via Supabase Edge Functions
**Plans**: 3 plans
**Status**: Complete

</details>

### 🚧 v1.4 Soul Evolution (In Progress)

**Milestone Goal:** Transform static bot soul into self-evolving personality system with daily reflection, compressed 3-layer structure, milestone moments, and full version history.

- [x] **Phase 17: Three-Layer Soul Schema** - Database foundation with soul_versions and soul_milestones tables (completed 2026-02-15)
- [ ] **Phase 18: Prompt Integration** - buildPrompt() uses 3-layer soul structure within 800-token budget
- [ ] **Phase 19: Daily Evolution Engine** - Cron-triggered reflection that generates new soul versions
- [ ] **Phase 20: Milestone Moments** - Formative event detection with emotional weight
- [ ] **Phase 21: Evolution Controls** - User commands for pause/resume/history/rollback
- [ ] **Phase 22: Growth Safeguards** - Upward trajectory enforcement in reflection prompt

## Phase Details

### Phase 17: Three-Layer Soul Schema
**Goal**: Database structure supports versioned 3-layer souls with milestone moments
**Depends on**: Phase 16 (v1.3 complete)
**Requirements**: SCHEMA-01, SCHEMA-02, SCHEMA-03, SCHEMA-04, SCHEMA-05
**Success Criteria** (what must be TRUE):
  1. soul_versions table stores daily snapshots with core_identity, active_values, recent_growth, reflection_notes, and token_count
  2. soul_milestones table stores formative events with emotional weight classification and lesson_learned
  3. Current bot_soul content is preserved as seed in new schema (Core Identity Layer 1)
  4. Supabase RPCs exist for soul CRUD (get_current_soul, save_soul_version, get_soul_history)
  5. Supabase RPCs exist for milestone CRUD (save_milestone_moment, get_milestone_moments)
**Plans:** 2/2 plans complete

Plans:
- [ ] 17-01-PLAN.md — Migration SQL for soul_versions and soul_milestones tables + reference schema
- [ ] 17-02-PLAN.md — Supabase RPCs for soul and milestone CRUD operations + reference schema

### Phase 18: Prompt Integration
**Goal**: Every Claude interaction uses 3-layer soul structure instead of flat content
**Depends on**: Phase 17
**Requirements**: PROMPT-01, PROMPT-02, PROMPT-03
**Success Criteria** (what must be TRUE):
  1. buildPrompt() injects Core Identity + Active Values + Recent Growth in structured format
  2. Active soul text never exceeds 800 tokens (validation at prompt assembly time)
  3. Full soul history and milestones stay in database, never loaded into prompt
  4. Bot responses reflect personality defined in 3-layer soul
**Plans**: 2 plans

Plans:
- [ ] 18-01-PLAN.md — Fetch 3-layer soul via RPC and refactor all prompt injection points
- [ ] 18-02-PLAN.md — Add token estimation and 800-token budget validation with graceful truncation

### Phase 19: Daily Evolution Engine
**Goal**: Bot autonomously reflects on interactions and updates its soul every night
**Depends on**: Phase 18
**Requirements**: EVOL-01, EVOL-02, EVOL-03, EVOL-04, EVOL-05, EVOL-06
**Success Criteria** (what must be TRUE):
  1. Cron job triggers at configured time (default midnight)
  2. Reflection pulls last 24h interactions from thread_messages across all threads
  3. Claude receives current 3-layer soul + recent versions for continuity awareness
  4. Reflection generates new 3-layer soul compressed to ~800 tokens
  5. Old soul saved as version in soul_versions before update
  6. New soul text delivered to Rafa via Telegram (observer report, no approval needed)
**Plans**: TBD

Plans:
- [ ] 19-01: Create daily evolution cron job with configurable schedule
- [ ] 19-02: Build reflection prompt that receives 24h context + current soul
- [ ] 19-03: Implement soul version save-before-update logic
- [ ] 19-04: Add Telegram notification for daily evolution reports

### Phase 20: Milestone Moments
**Goal**: Bot detects and stores formative moments that anchor personality evolution
**Depends on**: Phase 19
**Requirements**: MOMENT-01, MOMENT-02, MOMENT-03, EVOL-07
**Success Criteria** (what must be TRUE):
  1. Bot automatically detects formative moments during normal interactions
  2. [MILESTONE:] intent allows explicit tagging with emotional weight and lesson
  3. Milestone moments stored with weight classification (formative/meaningful/challenging)
  4. Daily evolution consults milestone moments for personality anchoring
**Plans**: TBD

Plans:
- [ ] 20-01: Add [MILESTONE:] intent parsing to processIntents()
- [ ] 20-02: Update daily reflection prompt to include milestone moments
- [ ] 20-03: Test milestone consultation during evolution

### Phase 21: Evolution Controls
**Goal**: User can manage soul evolution lifecycle via Telegram commands
**Depends on**: Phase 20
**Requirements**: EVOL-09, EVOL-10, CTRL-01, CTRL-02, CTRL-03, CTRL-04
**Success Criteria** (what must be TRUE):
  1. /soul pause stops daily evolution (bot keeps current soul frozen)
  2. /soul resume restarts daily evolution from paused state
  3. /soul history shows recent soul versions with version numbers and dates
  4. /soul rollback <version> restores a previous soul version as active
  5. Rollback preserves history (creates new version, doesn't delete)
**Plans**: TBD

Plans:
- [ ] 21-01: Extend /soul command handler with pause/resume subcommands
- [ ] 21-02: Add evolution_enabled flag to bot_soul or heartbeat_config
- [ ] 21-03: Implement /soul history with formatted version list
- [ ] 21-04: Implement /soul rollback with version restore logic

### Phase 22: Growth Safeguards
**Goal**: Evolution always trends upward - no personality regression
**Depends on**: Phase 21
**Requirements**: EVOL-08
**Success Criteria** (what must be TRUE):
  1. Reflection prompt explicitly enforces growth mindset
  2. Daily evolution builds on previous versions, never regresses
  3. Bot learns from challenges without adopting negative patterns
  4. Soul evolution report includes growth indicator (what improved today)
**Plans**: TBD

Plans:
- [ ] 22-01: Craft reflection prompt with growth constraints
- [ ] 22-02: Add growth indicator extraction to evolution report
- [ ] 22-03: Test evolution across multiple days for upward trajectory

## Progress

**Execution Order:**
Phases execute in numeric order: 17 → 18 → 19 → 20 → 21 → 22

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
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
| 17. Three-Layer Soul Schema | v1.4 | Complete    | 2026-02-15 | - |
| 18. Prompt Integration | v1.4 | 0/2 | Not started | - |
| 19. Daily Evolution Engine | v1.4 | 0/4 | Not started | - |
| 20. Milestone Moments | v1.4 | 0/3 | Not started | - |
| 21. Evolution Controls | v1.4 | 0/4 | Not started | - |
| 22. Growth Safeguards | v1.4 | 0/3 | Not started | - |

---

*Last updated: 2026-02-15 — v1.4 roadmap created*
