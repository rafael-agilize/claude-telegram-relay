---
phase: 23
plan: 02
subsystem: edge-functions
tags: [security, input-validation, parameter-clamping]
dependency-graph:
  requires:
    - Edge Functions (embed, search)
    - Phase 23-01 (JWT authentication)
  provides:
    - DB-sourced content for embedding
    - Clamped search parameters
  affects:
    - supabase/functions/embed/index.ts
    - supabase/functions/search/index.ts
tech-stack:
  added: []
  patterns:
    - Database-sourced content validation
    - Parameter clamping with Math.min/max
    - Query length limits
key-files:
  created: []
  modified:
    - supabase/functions/embed/index.ts
    - supabase/functions/search/index.ts
decisions:
  - decision: Embed function fetches content from database by row ID only
    rationale: Prevents malicious callers from injecting arbitrary content for embedding generation
    impact: Client payloads can only specify the row ID; content always comes from global_memory table
  - decision: Search function clamps match_count to [1, 20] and match_threshold to [0.5, 1.0]
    rationale: Prevents callers from requesting unbounded result sets or overly-broad matches
    impact: Search queries bounded to reasonable limits regardless of client input
  - decision: Query length capped at 1000 characters
    rationale: Prevents abuse via excessively long search queries
    impact: Search requests rejected if query exceeds 1000 chars
metrics:
  duration: 75s
  tasks: 2
  files_modified: 2
  commits: 2
  completed: 2026-02-17
---

# Phase 23 Plan 02: Edge Function Input Validation Summary

**One-liner:** DB-sourced content for embed function and parameter clamping for search function to prevent content injection and excessive queries.

## Objective

Harden input validation for both Edge Functions: embed fetches from DB instead of trusting client content, search clamps query parameters to safe bounds.

## Implementation Summary

### Task 1: Embed Function Fetches Content from Database by Row ID

Refactored the embed function to eliminate client-supplied content from the embedding generation flow:

**Previous flow:**
1. Client sends `{ record: { id, content } }` (webhook) or `{ id, content }` (direct)
2. Function uses client-supplied `record.content` directly in OpenAI API call

**New flow:**
1. Client sends only `id` (extracted from `payload.record?.id || payload.id`)
2. Function validates `id` exists (returns 400 if missing)
3. Function queries `global_memory` table by ID to fetch authoritative content
4. Returns 404 if row not found
5. Returns 400 if row has no content
6. Idempotency check uses DB-fetched `row.embedding`
7. Uses DB-sourced `row.content` for OpenAI embedding generation

**Key changes:**
- Removed all references to `record.content` and `payload.content`
- Added database SELECT query: `supabase.from("global_memory").select("id, content, embedding").eq("id", id).single()`
- Content for embedding now exclusively comes from database query result (`row.content`)
- Added 404 response when record not found
- Added 400 response when record has no content

**Security impact:** Prevents EDGE-02 vulnerability where malicious callers could inject arbitrary text for embedding generation.

**Files modified:**
- `supabase/functions/embed/index.ts` - Lines 25-83 refactored to use DB-sourced content

### Task 2: Search Function Clamps Parameters to Safe Bounds

Added parameter validation and clamping after extracting client inputs:

**Parameter clamping:**
```typescript
const rawMatchCount = body.match_count ?? 5;
const rawMatchThreshold = body.match_threshold ?? 0.7;

// EDGE-03: Clamp parameters to safe bounds
const matchCount = Math.min(Math.max(Math.round(rawMatchCount), 1), 20);
const matchThreshold = Math.max(Math.min(rawMatchThreshold, 1.0), 0.5);
```

**Clamping rules:**
- `match_count`: Integer between 1 and 20 (rounds to nearest integer, floors at 1, caps at 20)
- `match_threshold`: Float between 0.5 and 1.0 (floors at 0.5, caps at 1.0)

**Query length limit:**
```typescript
if (query.length > 1000) {
  return new Response(
    JSON.stringify({ error: "Query too long" }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}
```

**Security impact:** Prevents EDGE-03 vulnerability where callers could request unbounded result sets or set thresholds so low that every memory matches.

**Files modified:**
- `supabase/functions/search/index.ts` - Lines 36-49 added validation and clamping

## Deviations from Plan

None - plan executed exactly as written.

## Success Criteria

- [x] Embed function queries global_memory by ID and uses DB content for embedding
- [x] Search function enforces match_count <= 20 and match_threshold >= 0.5
- [x] Query length capped at 1000 characters
- [x] No client-supplied content used for embedding generation
- [x] All parameter clamping uses clamped values in downstream calls

## Verification

**Embed function (supabase/functions/embed/index.ts):**
- Line 30: ID extraction from payload only (`payload.record?.id || payload.id`)
- Line 32-37: Missing ID validation (returns 400)
- Line 40-44: Database SELECT query fetches content by ID
- Line 46-52: 404 returned when row not found
- Line 55: Idempotency check uses DB-fetched `row.embedding`
- Line 63-67: 400 returned when record has no content
- Line 81: OpenAI API receives `row.content` (DB-sourced, not client-supplied)
- No references to `record.content` or `payload.content` in embedding generation

**Search function (supabase/functions/search/index.ts):**
- Line 37-42: Query length check (max 1000 chars)
- Line 44-45: Raw parameter extraction
- Line 48: `match_count` clamped with `Math.min(Math.max(Math.round(rawMatchCount), 1), 20)`
- Line 49: `match_threshold` clamped with `Math.max(Math.min(rawMatchThreshold, 1.0), 0.5)`
- Line 89-90: RPC call uses clamped values, not raw values

## Self-Check

**Created files:**
- [x] .planning/phases/23-edge-function-security/23-02-SUMMARY.md

**Modified files:**
- [x] supabase/functions/embed/index.ts - FOUND
- [x] supabase/functions/search/index.ts - FOUND

**Commits:**
- [x] 8936cab - FOUND (feat(23-02): embed function fetches content from database)
- [x] cfb26b0 - FOUND (feat(23-02): clamp search parameters to safe bounds)

## Self-Check: PASSED
