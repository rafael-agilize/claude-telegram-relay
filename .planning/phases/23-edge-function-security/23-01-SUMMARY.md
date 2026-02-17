---
phase: 23
plan: 01
subsystem: edge-functions
tags: [security, authentication, error-handling]
dependency-graph:
  requires:
    - Edge Functions (embed, search)
  provides:
    - JWT authentication guards
    - Sanitized error responses
  affects:
    - supabase/functions/embed/index.ts
    - supabase/functions/search/index.ts
tech-stack:
  added: []
  patterns:
    - JWT token verification
    - Error response sanitization
    - Graceful degradation (search returns empty results)
key-files:
  created: []
  modified:
    - supabase/functions/embed/index.ts
    - supabase/functions/search/index.ts
decisions:
  - decision: Use service_role JWT comparison for auth
    rationale: Supabase client automatically sends service_role key as Bearer token when invoking functions
    impact: Both webhook and direct invocations are authenticated consistently
  - decision: Search function returns only { results: [] } on errors
    rationale: Maintains graceful degradation pattern already used in relay.ts
    impact: Callers see consistent empty-results behavior without error details
  - decision: Preserve all console.error() logging
    rationale: Server-side logs retain full error context for debugging
    impact: Operators can troubleshoot issues without exposing details to callers
metrics:
  duration: 93s
  tasks: 2
  files_modified: 2
  commits: 2
  completed: 2026-02-17
---

# Phase 23 Plan 01: Edge Function Security Summary

**One-liner:** JWT authentication and sanitized error responses for both Edge Functions to prevent unauthorized access and information leakage.

## Objective

Add authentication guards and error sanitization to both Edge Functions (embed and search) to prevent unauthenticated callers from invoking them and stop internal error details from leaking to callers.

## Implementation Summary

### Task 1: JWT Auth Guards

Added authentication checks at the top of both Edge Functions (after method check, before body parsing) that:

- Extract the Authorization header
- Verify it starts with "Bearer "
- Compare token against SUPABASE_SERVICE_ROLE_KEY
- Return 401 Unauthorized with { "error": "Unauthorized" } if missing or mismatched
- Log unauthorized attempts via console.warn()

**Files modified:**
- `supabase/functions/embed/index.ts` - Added auth guard at lines 15-23
- `supabase/functions/search/index.ts` - Added auth guard at lines 15-23

### Task 2: Error Response Sanitization

Replaced all error responses containing internal details with generic messages while preserving server-side logging:

**embed/index.ts changes:**
- OpenAI API error: Changed from "OpenAI API error, details: ..." to "Embedding generation failed"
- No embedding returned: Changed to "Embedding generation failed"
- Database update error: Changed from "Database update failed, details: ..." to "Processing failed"
- Catch-all error: Changed from err.message to "Internal error"

**search/index.ts changes:**
- All error paths now return only `{ results: [] }` with no error field
- OpenAI API error: Removed error field entirely
- No embedding returned: Removed error field entirely
- match_memory RPC error: Removed error field entirely
- Catch-all error: Removed error field entirely

All `console.error()` and `console.warn()` calls preserved for server-side observability.

## Deviations from Plan

None - plan executed exactly as written.

## Success Criteria

- [x] Both Edge Functions return 401 for requests without valid service_role JWT
- [x] No error response in either function contains internal error details
- [x] Server-side console logging preserved for all error paths
- [x] embed function returns generic error messages only
- [x] search function returns only { results: [] } on any error

## Verification

**Auth guards verified:**
- embed/index.ts: Auth check present at line 15-23, before body parsing
- search/index.ts: Auth check present at line 15-23, before body parsing
- Both return 401 with { "error": "Unauthorized" } on auth failure

**Error sanitization verified:**
- No `details:` key in any JSON response
- No `err.message` or `error.message` in any response body
- search function returns only `{ results: [] }` on all error paths
- embed function returns generic error strings only
- All console.error() and console.warn() calls preserved (9 total across both files)

## Self-Check

**Created files:**
- .planning/phases/23-edge-function-security/23-01-SUMMARY.md

**Modified files:**
- supabase/functions/embed/index.ts - FOUND
- supabase/functions/search/index.ts - FOUND

**Commits:**
- 016746e - FOUND (feat(23-01): add JWT auth guard to Edge Functions)
- aef4f80 - FOUND (feat(23-01): sanitize error responses in Edge Functions)

## Self-Check: PASSED
