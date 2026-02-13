# ROADMAP.md

## Active Milestone: v1.3 — Smart Memory

**Goal:** Evolve flat memory into typed system with goals tracking and semantic search, adapting upstream's memory module to our threaded architecture.

**Origin:** Upstream commit [fced316](https://github.com/rafael-agilize/claude-telegram-relay/commit/fced3162c65657635e97164f7ba4f519e145283a)

### Phase 14: Schema Migration & Typed Memory
**Goal:** Evolve `global_memory` table to support typed entries with embeddings.
**Requirements:** R1, R12, NF3
**Plans:** 1 plan
Plans:
- [ ] 14-01-PLAN.md — Migration SQL + reference schema update (columns, RPCs, extensions, backfill)

**Delivers:**
- Migration SQL: add `type`, `deadline`, `completed_at`, `priority`, `embedding` columns to `global_memory`
- Enable `vector` and `pg_net` extensions
- Create `match_memory()`, `get_facts()`, `get_active_goals()` RPCs
- Backfill existing rows as type `fact`
- Update reference schema (`examples/supabase-schema-v2.sql`)

### Phase 15: Intent System Upgrade
**Goal:** Rename tags to upstream convention and add goals lifecycle intents.
**Requirements:** R2, R3, R4, R5, R6, R11
**Delivers:**
- Rename `[LEARN:]` → `[REMEMBER:]` in `processIntents()` and all `buildPrompt()` instructions
- Add `[GOAL: text]` and `[GOAL: text | DEADLINE: date]` intent parsing
- Add `[DONE: search text]` intent parsing (marks goal as completed)
- Keep `[FORGET:]` unchanged
- Update `/memory` command to show facts + active goals separately
- Update `insertGlobalMemory()` to accept type parameter
- Rename functions: `insertGlobalMemory` → `insertMemory`, `deleteGlobalMemory` → `deleteMemory`, `getGlobalMemory` → `getMemoryContext`

### Phase 16: Semantic Search via Edge Functions
**Goal:** Add auto-embedding and semantic search powered by OpenAI embeddings in Supabase.
**Requirements:** R7, R8, R9, R10, NF1, NF2
**Delivers:**
- `supabase/functions/embed/index.ts` — auto-embed on INSERT via database webhook
- `supabase/functions/search/index.ts` — semantic search via query embedding + `match_memory()` RPC
- `getRelevantMemory(query)` function in relay that invokes search Edge Function
- Integration in `buildPrompt()` — append `RELEVANT MEMORIES:` section
- Graceful fallback (empty result) when Edge Functions unavailable
- Setup documentation (webhook config, Supabase secrets)

---

## Completed Milestones

- **v1.0** — Conversational Threading & Memory System (Phases 1-5, completed 2026-02-10). Delivered threaded conversations, three-layer memory, voice I/O.
- **v1.1** — Heartbeat & Proactive Agent (Phases 6-11, completed 2026-02-12). Delivered heartbeat system, cron engine, cron management, agent self-scheduling. [Archive](milestones/v1.1-ROADMAP.md)
- **v1.2** — Streaming & Long-Running Task Resilience (Phases 12-13, completed 2026-02-13). Delivered stream-json NDJSON parsing, activity-based 15-min timeout, typing indicators, tool-use progress messages. [Archive](milestones/v1.2-ROADMAP.md)

---

*Last updated: 2026-02-13 — Phase 14 planned*
