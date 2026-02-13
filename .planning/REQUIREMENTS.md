# REQUIREMENTS.md — v1.3: Smart Memory

## Origin

Upstream commit [fced316](https://github.com/rafael-agilize/claude-telegram-relay/commit/fced3162c65657635e97164f7ba4f519e145283a): "Add Supabase memory system with semantic search". Adapted to our v2 schema (threaded conversations, three-layer memory, cron/heartbeat).

## Scope

Evolve the flat `global_memory` system into a typed memory with goals tracking, rename intent tags to upstream convention, and add semantic search via OpenAI embeddings in Supabase Edge Functions.

## Functional Requirements

### R1: Typed Memory System
Evolve `global_memory` table to support typed entries: `fact`, `goal`, `completed_goal`, `preference`. Add `deadline` (TIMESTAMPTZ), `completed_at` (TIMESTAMPTZ), `priority` (INTEGER), and `embedding` (VECTOR(1536)) columns. Existing data backfilled as type `fact`.

### R2: Goals Lifecycle
Goals can be created with `[GOAL: text]` or `[GOAL: text | DEADLINE: date]`. Goals are marked complete via `[DONE: search text]`, which flips type to `completed_goal` and sets `completed_at`. Active goals shown in prompt context.

### R3: Rename LEARN → REMEMBER Intent
Replace `[LEARN: fact]` with `[REMEMBER: fact]` across processIntents, buildPrompt instructions, and prompt templates. Old `[LEARN:]` tag no longer recognized.

### R4: Add GOAL Intent
New `[GOAL: text]` tag parsed in processIntents. Optional deadline syntax: `[GOAL: text | DEADLINE: date]`. Inserts into memory table with type `goal`.

### R5: Add DONE Intent
New `[DONE: search text]` tag parsed in processIntents. Finds matching active goal by content ilike, updates type to `completed_goal` and sets `completed_at`.

### R6: Keep FORGET Intent
`[FORGET: search text]` remains unchanged. Can delete facts, goals, or any memory entry.

### R7: Auto-Embedding Edge Function
Supabase Edge Function (`embed`) triggered by database webhook on INSERT to `global_memory`. Generates OpenAI text-embedding-3-small vector and updates the row. OpenAI API key stored in Supabase secrets only.

### R8: Semantic Search Edge Function
Supabase Edge Function (`search`) accepts a query, generates its embedding, calls `match_memory()` RPC to find similar memory entries. Returns ranked results with similarity scores.

### R9: Semantic Memory in Prompt Context
`buildPrompt()` calls the search Edge Function with the current user message to retrieve semantically relevant memories. Appended as `RELEVANT MEMORIES:` section in prompt. Complementary to (not replacing) the existing global memory listing.

### R10: Graceful Degradation
If Edge Functions are not deployed or fail, semantic search silently returns empty. All non-semantic features (typed memory, goals, intents) work without Edge Functions.

### R11: Updated /memory Command
`/memory` command shows facts and active goals separately. Format: "Facts:" section + "Active Goals:" section with deadlines where applicable.

### R12: Database Migration
Supabase migration file that adds columns to `global_memory`, creates helper RPCs (`get_facts`, `get_active_goals`, `match_memory`), enables `vector` and `pg_net` extensions. Non-destructive — preserves all existing data.

## Non-Functional Requirements

### NF1: No New Env Vars in Relay
OpenAI API key lives exclusively in Supabase Edge Function secrets. Relay `.env` unchanged.

### NF2: Single-File Architecture Preserved
All relay changes go into `src/relay.ts`. Edge Functions are separate Supabase deployments.

### NF3: Backward Compatible
Existing memories (facts) continue working after migration. No data loss.

## Out of Scope

- Semantic search on `thread_messages` (decision: memory-only for now)
- Embedding provider alternatives (OpenAI text-embedding-3-small chosen)
- Memory management UI (Telegram commands sufficient)
- Auto-cleanup of old/stale memories

## Success Criteria

- [ ] `[REMEMBER:]` creates typed fact entries
- [ ] `[GOAL:]` creates goals with optional deadlines
- [ ] `[DONE:]` completes matching goals
- [ ] `/memory` shows facts and goals separately
- [ ] Edge Functions deploy and auto-embed on INSERT
- [ ] Semantic search returns relevant memories for queries
- [ ] `buildPrompt()` includes semantically relevant context
- [ ] System works fully even without Edge Functions deployed
- [ ] Existing global_memory data preserved after migration
