---
phase: 14-schema-migration-typed-memory
plan: 01
status: completed
completed_at: 2026-02-13
---

# Plan 14-01: Migration SQL + Reference Schema Update

## What Was Done

### Task 1: Created typed memory migration SQL
**File:** `supabase/migrations/20260213_typed_memory_schema.sql`

- Enabled `vector` and `pg_net` extensions (Supabase convention: `WITH SCHEMA extensions`)
- Added 5 new columns to `global_memory`:
  - `type TEXT NOT NULL DEFAULT 'fact'` with CHECK constraint (`fact`, `goal`, `completed_goal`, `preference`)
  - `deadline TIMESTAMPTZ` — optional goal deadline
  - `completed_at TIMESTAMPTZ` — goal completion timestamp
  - `priority INTEGER DEFAULT 0` — ordering weight
  - `embedding VECTOR(1536)` — OpenAI text-embedding-3-small vector
- Created 3 indexes:
  - `idx_global_memory_type` — fast type lookup
  - `idx_global_memory_type_active_goals` — partial index for active goals
  - `idx_global_memory_embedding` — HNSW vector similarity search
- Created 3 RPCs:
  - `get_facts()` — returns fact-type entries, newest first
  - `get_active_goals()` — returns uncompleted goals, priority then recency
  - `match_memory(query_embedding, match_threshold, match_count)` — cosine similarity search
- All statements are idempotent (IF NOT EXISTS / CREATE OR REPLACE)
- Existing rows auto-backfilled as `type = 'fact'` via DEFAULT (PostgreSQL 11+)

### Task 2: Updated reference schema
**File:** `examples/supabase-schema-v2.sql`

- Updated `global_memory` CREATE TABLE with all new columns
- Updated section comment: "Cross-thread typed memory (facts, goals, preferences)"
- Updated intent references: `[REMEMBER:]` and `[FORGET:]`
- Added EXTENSIONS section at top of file
- Added new indexes after existing `idx_global_memory_created`
- Added 3 new RPCs in HELPER FUNCTIONS section after `get_active_soul()`
- Preserved all existing tables, functions, RLS policies, and cron/heartbeat sections

## Verification

| Check | Result |
|-------|--------|
| Migration: extensions enabled | PASS |
| Migration: 5 columns added | PASS |
| Migration: 3 indexes created | PASS |
| Migration: 3 RPCs created | PASS |
| Migration: CHECK constraint on type | PASS |
| Migration: HNSW index (not ivfflat) | PASS |
| Migration: all idempotent | PASS |
| Reference: typed columns in CREATE TABLE | PASS |
| Reference: extensions section | PASS |
| Reference: 3 new RPCs added | PASS |
| Reference: all existing content preserved | PASS |

## Requirements Coverage

- **R1 (Typed Memory System):** Fully delivered — type column with 4 values, deadline, completed_at, priority, embedding
- **R12 (Database Migration):** Fully delivered — migration file with extensions, columns, indexes, RPCs
- **NF3 (Backward Compatible):** Fully delivered — no destructive statements, auto-backfill via DEFAULT
