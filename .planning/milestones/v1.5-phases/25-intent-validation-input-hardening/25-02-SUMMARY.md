---
phase: 25-intent-validation-input-hardening
plan: 02
subsystem: relay-security
tags: [input-validation, memory-management, filesystem-security, concurrency]

dependency_graph:
  requires: [25-01]
  provides: [input-caps, memory-eviction, atomic-locks]
  affects: [soul-command, memory-layer, file-uploads, process-management]

tech_stack:
  added: [memory-eviction-strategy, allowlist-sanitization]
  patterns: [cap-and-evict, atomic-file-ops]

key_files:
  created: []
  modified: [src/relay.ts]

decisions:
  - "/soul content capped at 2000 chars with user feedback"
  - "Memory caps: 100 facts, 50 goals with oldest-first eviction"
  - "Filename sanitization uses allowlist ([a-zA-Z0-9._-]) + null byte stripping"
  - "Lock file acquisition is atomic-only (no fallback overwrite)"

metrics:
  duration: 106s
  completed: 2026-02-17
---

# Phase 25 Plan 02: Input Hardening Summary

**One-liner:** Hardened relay inputs with /soul cap, memory eviction limits, allowlist filename sanitization, and atomic-only lock acquisition

## What Was Built

Four input hardening improvements in `src/relay.ts`:

1. **/soul content cap (INPUT-01)** — Rejects soul text >2000 chars with user feedback before calling `setSoul()`
2. **Memory entry limits with eviction (INPUT-02)** — Facts capped at 100, goals at 50. When at capacity, `evictOldestMemory()` deletes oldest entries before inserting new ones.
3. **Allowlist filename sanitization (INPUT-03)** — `sanitizeFilename()` now strips null bytes and allowlists only `[a-zA-Z0-9._-]` (was blacklist-based)
4. **Atomic lock acquisition (INPUT-04)** — Removed non-atomic `writeFile()` fallback from `acquireLock()`. Stale locks are explicitly deleted before atomic `wx` open. Race conditions result in clean failure.

## Deviations from Plan

None - plan executed exactly as written.

## Implementation Details

### /soul Content Cap
```typescript
if (args.length > 2000) {
  await ctx.reply(`Soul text too long (${args.length} chars). Maximum is 2000 characters.`);
  return;
}
```
Location: Line ~3231 in /soul command handler (before `setSoul()` call)

### Memory Eviction
Constants: `MAX_FACTS = 100`, `MAX_GOALS = 50` (line 360)

```typescript
async function evictOldestMemory(type: string, maxCount: number): Promise<void> {
  // Counts entries by type
  // If at/over capacity, calculates excess
  // Fetches oldest entries (order by created_at ASC)
  // Deletes oldest to make room for new entry
}
```

Called from `insertMemory()` before insert (line 372-375):
```typescript
const typeLimit = type === "fact" ? MAX_FACTS : type === "goal" ? MAX_GOALS : null;
if (typeLimit !== null) {
  await evictOldestMemory(type, typeLimit);
}
```

### Filename Sanitization
Before (blacklist):
```typescript
return name.replace(/[\/\\]/g, "_").replace(/\.\./g, "_");
```

After (allowlist):
```typescript
const clean = name.replace(/\0/g, "");  // Strip null bytes
return clean.replace(/[^a-zA-Z0-9._-]/g, "_");  // Allowlist only safe chars
```

### Atomic Lock Acquisition
Before: Had fallback `writeFile(LOCK_FILE)` if `wx` open failed (race condition)

After:
- Stale lock detected → `unlink(LOCK_FILE)` explicitly
- Then `await open(LOCK_FILE, "wx")` without `.catch()` fallback
- If `wx` throws (file exists) → outer catch handles it, returns false

No non-atomic path exists.

## Verification Results

✅ `/soul` handler rejects text > 2000 chars with user-facing message
✅ `MAX_FACTS = 100` and `MAX_GOALS = 50` constants exist
✅ `evictOldestMemory` function exists and is called from `insertMemory`
✅ `sanitizeFilename` uses `[^a-zA-Z0-9._-]` allowlist and `\0` stripping
✅ `acquireLock` has no `writeFile(LOCK_FILE` fallback — only atomic `wx` open
✅ TypeScript compiles: `bun build src/relay.ts --no-bundle`

## Security Impact

| Issue | Before | After |
|-------|--------|-------|
| Unbounded soul text | User could send 100K+ char soul → bloat DB/prompt | Capped at 2000 chars with rejection message |
| Memory growth | Facts/goals could grow indefinitely → OOM | Capped at 100/50 with LRU eviction |
| Path traversal | Blacklist missed unicode/special chars | Allowlist only safe chars + null byte stripping |
| Lock race condition | Two instances could overwrite lock simultaneously | Atomic wx-only open, clean failure on race |

## Files Modified

- `src/relay.ts` (+45 lines, -13 lines)
  - Line 65-70: `sanitizeFilename` allowlist implementation
  - Line 360-361: Memory cap constants
  - Line 372-375: Eviction call in `insertMemory()`
  - Line 405-430: `evictOldestMemory()` function
  - Line 2511-2535: `acquireLock()` atomic-only implementation
  - Line 3231-3234: /soul length check

## Commits

1. `332ad13` — feat(25-02): add input validation - soul cap, memory eviction, filename allowlist
2. `3c7189e` — fix(25-02): make lock file acquisition atomic without fallback overwrite

## Testing Notes

Manual testing recommended:
- Send `/soul` with 2001+ chars → should reject
- Insert 101st fact → should evict oldest fact
- Upload file with unicode/special chars → should sanitize to underscores
- Start two relay instances simultaneously → second should fail cleanly

## Self-Check: PASSED

Verified commits exist:
```
✓ 332ad13 found in git log
✓ 3c7189e found in git log
```

Verified files modified:
```
✓ src/relay.ts exists and contains all changes
```

Verified key patterns:
```
✓ args.length > 2000 found in /soul handler
✓ MAX_FACTS and MAX_GOALS constants found
✓ evictOldestMemory function found
✓ sanitizeFilename uses allowlist regex
✓ No writeFile(LOCK_FILE fallback exists
✓ acquireLock uses atomic wx open
```
