# PLAN.md — Phase 3: Conversation Continuity

**Goal:** Each thread maintains a persistent Claude CLI session via `--resume`, giving real multi-turn conversation instead of stateless one-shot prompts.

**Requirements:** R2 (True Conversation Continuity)
**Depends on:** Phase 2 (done)

**Key insight:** The current `callClaude()` uses `--output-format text`, which never exposes the session ID (the regex on line 773 never matches). Switching to `--output-format json` gives us both the response text and the session ID in a parseable structure. Per-thread session IDs are already stored in Supabase's `threads` table via `updateThreadSession()` (written in Phase 1). The global `session.json` file becomes obsolete.

---

## Prompt 1: Refactor callClaude() for JSON output and per-thread sessions

**File:** `src/relay.ts`
**What:** Rewrite `callClaude()` to use `--output-format json`, accept thread info for per-thread session continuity, parse the JSON response, and store session IDs in Supabase.

### Changes:

1. **Change the `callClaude()` signature** (line ~742) to accept optional thread info:
   ```typescript
   async function callClaude(
     prompt: string,
     threadInfo?: ThreadInfo
   ): Promise<{ text: string; sessionId: string | null }> {
   ```
   Remove the old `options?: { resume?: boolean }` parameter entirely.

2. **Build args with JSON output and per-thread resume** (replace lines 746-752):
   ```typescript
   const args = [CLAUDE_PATH, "-p", prompt];

   // Resume from thread's stored session if available
   if (threadInfo?.sessionId) {
     args.push("--resume", threadInfo.sessionId);
   }

   args.push("--output-format", "json", "--dangerously-skip-permissions");
   ```

3. **Parse JSON response** (replace lines 764-780):
   ```typescript
   const output = await new Response(proc.stdout).text();
   const stderr = await new Response(proc.stderr).text();
   const exitCode = await proc.exited;

   if (exitCode !== 0) {
     // If we used --resume and it failed, retry without it (session may be expired/corrupt)
     if (threadInfo?.sessionId) {
       console.warn(`Session ${threadInfo.sessionId} failed (exit ${exitCode}), starting fresh`);
       // Pass threadInfo with cleared sessionId so the new session still gets stored to Supabase
       return callClaude(prompt, { ...threadInfo, sessionId: null });
     }
     console.error("Claude error:", stderr);
     return { text: `Error: ${stderr || "Claude exited with code " + exitCode}`, sessionId: null };
   }

   // Parse JSON response
   let resultText: string;
   let newSessionId: string | null = null;
   try {
     const json = JSON.parse(output);
     // result is the response text string
     resultText = typeof json.result === "string"
       ? json.result
       : json.result?.content?.[0]?.text || output;
     newSessionId = json.session_id || null;
   } catch {
     // Fallback: if JSON parse fails, treat entire output as text
     console.warn("Failed to parse Claude JSON output, using raw text");
     resultText = output;
   }

   // Store session ID in Supabase for this thread
   if (newSessionId && threadInfo?.dbId) {
     await updateThreadSession(threadInfo.dbId, newSessionId);
   }

   return { text: resultText.trim(), sessionId: newSessionId };
   ```

4. **Remove the broken regex session parsing** — the lines with `sessionMatch` and `saveSession()` (lines 773-778) are completely replaced by the JSON parsing above.

### Verification:
- `callClaude()` returns `{ text, sessionId }` instead of a raw string
- First call to a thread: no `--resume`, gets session ID from JSON, stores in Supabase
- Second call: `--resume <sessionId>` passed, conversation continues
- If `--resume` fails (any non-zero exit when session was used), retries without `--resume` but preserves `threadInfo.dbId` so the new session ID gets stored back to Supabase
- After recovery, subsequent messages use the new (valid) session ID from Supabase — no repeated fail-retry cycle
- No more regex parsing of session IDs from text output

---

## Prompt 2: Update all message handlers for new callClaude() return type

**File:** `src/relay.ts`
**What:** Update all 4 message handlers (text, voice, photo, document) to pass `ctx.threadInfo` to `callClaude()` and destructure the new return type.

### Text handler (line ~822-851):

Replace:
```typescript
const rawResponse = await callClaude(enrichedPrompt, { resume: true });
const response = await processIntents(rawResponse);
```

With:
```typescript
const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
const response = await processIntents(rawResponse);
```

Everything else in the handler stays the same — `response` is still a string that flows through `processIntents()`, voice logic, v1/v2 logging, and `sendResponse()`.

### Voice handler (line ~876-878):

Replace:
```typescript
const rawResponse = await callClaude(enrichedPrompt, { resume: true });
const claudeResponse = await processIntents(rawResponse);
```

With:
```typescript
const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
const claudeResponse = await processIntents(rawResponse);
```

### Photo handler (line ~933-934):

Replace:
```typescript
const rawResponse = await callClaude(prompt, { resume: true });
const claudeResponse = await processIntents(rawResponse);
```

With:
```typescript
const { text: rawResponse } = await callClaude(prompt, ctx.threadInfo);
const claudeResponse = await processIntents(rawResponse);
```

### Document handler (line ~978-979):

Replace:
```typescript
const rawResponse = await callClaude(prompt, { resume: true });
const claudeResponse = await processIntents(rawResponse);
```

With:
```typescript
const { text: rawResponse } = await callClaude(prompt, ctx.threadInfo);
const claudeResponse = await processIntents(rawResponse);
```

### Verification:
- All 4 handlers pass `ctx.threadInfo` (which may be `undefined` — handled by callClaude)
- Return type destructured correctly (`{ text: rawResponse }`)
- Rest of each handler unchanged — processIntents, logging, sendResponse all still work
- DMs work: threadInfo has `sessionId: null` on first call, gets session after first reply
- Group topics work: each topic has its own threadInfo with its own sessionId

---

## Prompt 3: Remove legacy session management

**File:** `src/relay.ts`
**What:** Remove the global session state (`session.json`, `SessionState`, `loadSession()`, `saveSession()`, global `session` variable) since per-thread sessions in Supabase replace it entirely.

### Remove these items:

1. **`SESSION_FILE` constant** (line ~60):
   ```typescript
   // DELETE:
   const SESSION_FILE = join(RELAY_DIR, "session.json");
   ```

2. **`SessionState` interface** (lines ~62-65):
   ```typescript
   // DELETE:
   interface SessionState {
     sessionId: string | null;
     lastActivity: string;
   }
   ```

3. **`loadSession()` function** (lines ~602-609):
   ```typescript
   // DELETE entire function
   ```

4. **`saveSession()` function** (lines ~611-613):
   ```typescript
   // DELETE entire function
   ```

5. **Global `session` variable** (line ~615):
   ```typescript
   // DELETE:
   let session = await loadSession();
   ```

6. **Keep `readFile` and `writeFile` imports** — they're still used by transcription, TTS, and lock file.

### Verification:
- No references to `session.sessionId` remain
- No references to `SESSION_FILE`, `loadSession`, `saveSession` remain
- `readFile` and `writeFile` still imported (used elsewhere)
- `session.json` file will be orphaned on disk but harmless (user can delete manually)
- All session state now lives in Supabase `threads.claude_session_id`

---

## Execution Order

1. **Prompt 1** → Core: refactor `callClaude()` (foundation for everything else)
2. **Prompt 2** → Update handlers to use new signature (depends on Prompt 1)
3. **Prompt 3** → Remove dead code (depends on Prompt 2 removing all old references)

## Files Modified

| File | Changes |
|------|---------|
| `src/relay.ts` | `callClaude()` rewrite, handler updates, legacy session removal |

## Risk Assessment

- **Medium risk**: JSON output parsing. Mitigated by fallback to raw text if parse fails, and by handling both `result` as string and as object.
- **Medium risk**: `--resume` with stale session. Mitigated by retry without `--resume` on any non-zero exit code when a session was used. New session ID is stored back to Supabase so recovery is permanent (no repeated retries).
- **Low risk**: Handler signature changes are mechanical — just swapping `{ resume: true }` for `ctx.threadInfo` and destructuring.
- **Rollback**: Revert `--output-format json` back to `text` and restore old session logic. V1/V2 logging is unaffected.
