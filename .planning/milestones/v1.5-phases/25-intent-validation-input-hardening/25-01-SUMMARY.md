---
phase: 25-intent-validation-input-hardening
plan: 01
subsystem: intent-processing
tags: [security, validation, rate-limiting]

dependency-graph:
  requires: [24-02-cron-approval-flow]
  provides: [hardened-intent-validation, per-response-caps, content-overlap-matching]
  affects: [processIntents, deleteMemory]

tech-stack:
  added: []
  patterns: [word-level-overlap-scoring, per-response-deduplication, intent-caps]

key-files:
  created: []
  modified:
    - path: src/relay.ts
      lines: [394-404, 410-434, 2157-2159, 2163-2191, 2197-2228, 2251-2275, 2279-2313]
      description: Added contentOverlap helper, hardened FORGET validation, added per-response caps and deduplication

decisions:
  - title: FORGET requires 10+ char search text and >50% word overlap
    rationale: Prevents mass deletion via short/vague searches (e.g. "[FORGET: a]")
    alternatives: Character overlap (rejected - less semantic), exact match only (rejected - too strict)
  - title: Per-response caps (5 REMEMBER, 3 GOAL, 1 CRON, 3 FORGET)
    rationale: Prevents prompt injection from flooding memory in single response
    alternatives: Higher caps (rejected - still allows abuse), no caps (rejected - vulnerable)
  - title: Content deduplication via normalized Set for REMEMBER/GOAL
    rationale: Prevents duplicate entries within same response via case/whitespace variations
    alternatives: Database-level dedup (rejected - happens after insertion), no dedup (rejected - allows spam)

metrics:
  duration: 2 minutes
  tasks: 2
  files_modified: 1
  commits: 2
  completed: 2026-02-17T04:16Z
---

# Phase 25 Plan 01: Intent Validation & Input Hardening Summary

Hardened intent validation with FORGET safety guards, per-response caps, and content deduplication to prevent prompt injection attacks via intent abuse.

## Tasks Completed

### Task 1: FORGET validation with minimum length and content overlap check
**Commit:** `366846d`
**Files:** `src/relay.ts`

Added three layers of FORGET validation:
1. **contentOverlap() helper function** - Computes word-level overlap ratio between search text and content. Filters out stop words (<=2 chars), returns 0.0-1.0 score.
2. **deleteMemory() minimum length check** - Rejects searchText < 10 chars (was only checking > 200). Logs warning with the short search text.
3. **deleteMemory() overlap validation** - After finding match via `.includes()`, computes overlap and rejects if < 0.5 (50%). Logs warning with overlap score and matched content.
4. **processIntents() pre-validation** - FORGET block now checks searchText.length < 10 before calling deleteMemory(). Adds failure to failures array.

**Example blocked attack:**
```
[FORGET: a]  // Rejected: search text too short (1 chars)
[FORGET: user likes]  // May match "user likes coffee" but overlap check could reject vague matches
```

### Task 2: Per-response intent caps and content deduplication
**Commit:** `8fed754`
**Files:** `src/relay.ts`

Added per-response limits and deduplication:
1. **INTENT_CAPS constant** - Defines max intents per response: REMEMBER(5), GOAL(3), CRON(1), FORGET(3)
2. **intentCounts tracking** - Incremented on successful intent execution, checked before processing
3. **seenContent Set** - Normalizes content (lowercase + trim), tracks seen REMEMBER/GOAL to skip duplicates
4. **REMEMBER block** - Checks cap, dedup, then inserts. Logs warnings for exceeded caps and duplicates.
5. **GOAL block** - Same cap/dedup pattern as REMEMBER
6. **FORGET block** - Checks cap only (no dedup needed)
7. **CRON block** - Checks cap (max 1 per response)

All intent tags are still stripped from response regardless of cap/dedup/validation - only the action is skipped.

**Example protection:**
```
[REMEMBER: fact 1]  // ✓ Processed (count: 1)
[REMEMBER: fact 2]  // ✓ Processed (count: 2)
[REMEMBER: fact 1]  // ✗ Skipped (duplicate)
[REMEMBER: fact 3]  // ✓ Processed (count: 3)
[REMEMBER: fact 4]  // ✓ Processed (count: 4)
[REMEMBER: fact 5]  // ✓ Processed (count: 5)
[REMEMBER: fact 6]  // ✗ Skipped (cap reached)
```

## Deviations from Plan

None - plan executed exactly as written.

## Verification

All verification criteria met:
- ✓ `contentOverlap()` function exists and returns number between 0 and 1
- ✓ `deleteMemory()` rejects searchText < 10 chars
- ✓ `deleteMemory()` rejects matches with < 50% overlap
- ✓ `INTENT_CAPS` constant defines limits for REMEMBER(5), GOAL(3), CRON(1), FORGET(3)
- ✓ `seenContent` Set used for REMEMBER and GOAL deduplication
- ✓ All intent tags still stripped from response regardless of cap/dedup/block
- ✓ Code compiles successfully with `bun build src/relay.ts --no-bundle`

## Success Criteria Met

- ✓ FORGET with short search text (< 10 chars) is rejected
- ✓ FORGET only deletes entries with > 50% word overlap
- ✓ 6th REMEMBER intent in single response is silently skipped
- ✓ 4th GOAL intent in single response is silently skipped
- ✓ 2nd CRON intent in single response is silently skipped
- ✓ Duplicate REMEMBER facts within same response are skipped
- ✓ All intent tags still cleaned from response text

## Impact

**Security hardening:**
- FORGET attacks via short/vague searches (e.g. `[FORGET: a]`) now blocked
- Memory flooding via unlimited REMEMBER/GOAL intents now capped per response
- Duplicate content spam within same response now deduplicated

**User experience:**
- Legitimate FORGET operations require meaningful search terms (10+ chars)
- Legitimate multi-intent responses still work within reasonable caps
- Tags still always stripped regardless of validation outcome (no visible change to user)

**Observable behavior:**
- Warning logs for rejected FORGET (too short, low overlap)
- Warning logs for exceeded caps and duplicate content
- Failures array populated for rejected intents (included in response if failures occur)

## Files Modified

| File | Changes | Lines |
|------|---------|-------|
| `src/relay.ts` | Added contentOverlap(), hardened deleteMemory(), added caps/dedup to processIntents() | ~70 lines modified/added |

## Commits

1. `366846d` - feat(25-01): add FORGET validation with minimum length and content overlap check
2. `8fed754` - feat(25-01): add per-response intent caps and content deduplication

## Next Steps

Proceed to Phase 25 Plan 02: Output sanitization and injection prevention (if exists).

## Self-Check: PASSED

All claimed files and commits verified:
- ✓ FOUND: src/relay.ts
- ✓ FOUND: 366846d (Task 1 commit)
- ✓ FOUND: 8fed754 (Task 2 commit)
