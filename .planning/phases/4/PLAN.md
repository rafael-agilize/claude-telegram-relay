# PLAN.md — Phase 4: Three-Layer Memory System

**Goal:** Rich contextual memory with per-thread and cross-thread knowledge. Every prompt is assembled from: soul (personality) + global memory (learned facts) + thread summary + recent messages. Old v1 intent system replaced with streamlined [LEARN:]/[FORGET:] intents.

**Requirements:** R3 (Three-Layer Memory), partial R4 (Bot Soul integration into prompts)
**Depends on:** Phase 3 (done)

**Key insight:** All the v2 Supabase helpers already exist from Phase 1 (`getActiveSoul()`, `getGlobalMemory()`, `insertGlobalMemory()`, `deleteGlobalMemory()`, `updateThreadSummary()`, `getRecentThreadMessages()`). Phase 4 wires them into `buildPrompt()` and `processIntents()`, replacing the old v1 memory system. The thread summary auto-generation is the only net-new capability.

---

## Prompt 1: Rewrite buildPrompt() for three-layer memory

**File:** `src/relay.ts`
**What:** Replace the current `buildPrompt()` (lines 996-1028) that uses old v1 `getMemoryContext()` with a new version that assembles the three memory layers from v2 tables, accepts `threadInfo`, and instructs Claude on the new intent tags.

### Changes:

1. **Change the signature** to accept optional threadInfo:
   ```typescript
   async function buildPrompt(userMessage: string, threadInfo?: ThreadInfo): Promise<string> {
   ```

2. **Replace the body** (remove `getMemoryContext()` call, build layered prompt):
   ```typescript
   async function buildPrompt(userMessage: string, threadInfo?: ThreadInfo): Promise<string> {
     const now = new Date();
     const timeStr = now.toLocaleString("en-US", {
       timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
       weekday: "long",
       year: "numeric",
       month: "long",
       day: "numeric",
       hour: "2-digit",
       minute: "2-digit",
     });

     // Layer 1: Soul (personality)
     const soul = await getActiveSoul();

     // Layer 2: Global memory (cross-thread learned facts)
     const globalMemory = await getGlobalMemory();

     // Layer 3: Thread context (summary + recent messages as fallback)
     let threadContext = "";
     if (threadInfo?.dbId) {
       if (threadInfo.summary) {
         threadContext += `\nTHREAD SUMMARY:\n${threadInfo.summary}\n`;
       }
       const recentMessages = await getRecentThreadMessages(threadInfo.dbId, 5);
       if (recentMessages.length > 0) {
         threadContext += "\nRECENT MESSAGES (this thread):\n";
         threadContext += recentMessages
           .map((m) => `${m.role}: ${m.content}`)
           .join("\n");
       }
     }

     let prompt = `${soul}\n\nCurrent time: ${timeStr}`;

     if (globalMemory.length > 0) {
       prompt += "\n\nTHINGS I KNOW ABOUT THE USER:\n";
       prompt += globalMemory.map((m) => `- ${m}`).join("\n");
     }

     if (threadContext) {
       prompt += threadContext;
     }

     prompt += `

MEMORY INSTRUCTIONS:
You can automatically learn and remember facts about the user. When you notice something worth remembering (preferences, name, job, habits, important dates, etc.), include this tag in your response — it will be saved and removed before delivery:

[LEARN: concise fact about the user]

Keep learned facts very concise (under 15 words each). Only learn genuinely useful things.

To remove an outdated or wrong fact:
[FORGET: search text matching the fact to remove]

To trigger a voice reply:
[VOICE_REPLY]

User: ${userMessage}`;

     return prompt.trim();
   }
   ```

### Verification:
- `buildPrompt()` accepts optional `threadInfo` parameter
- Soul is loaded at the top of every prompt via `getActiveSoul()`
- Global memory items listed under "THINGS I KNOW ABOUT THE USER"
- Thread summary included when available
- Recent 5 thread messages included as fallback context (supplements `--resume`)
- New intent instructions: `[LEARN:]`, `[FORGET:]`, `[VOICE_REPLY]` only
- No more `[REMEMBER:]`, `[GOAL:]`, `[DONE:]` in instructions
- `getMemoryContext()` no longer called (becomes dead code)

---

## Prompt 2: Rewrite processIntents() for [LEARN:]/[FORGET:] system

**File:** `src/relay.ts`
**What:** Replace the current `processIntents()` (lines 401-474) that uses the old v1 `memory` table with a new version that handles `[LEARN:]` → `global_memory` table and `[FORGET:]` → `deleteGlobalMemory()`. Remove `[REMEMBER:]`, `[GOAL:]`, and `[DONE:]` handlers entirely.

### Changes:

1. **Change the signature** to accept optional thread DB ID (for source tracking):
   ```typescript
   async function processIntents(response: string, threadDbId?: string): Promise<string> {
   ```

2. **Replace the entire body**:
   ```typescript
   async function processIntents(response: string, threadDbId?: string): Promise<string> {
     let clean = response;

     // [LEARN: concise fact about the user]
     const learnMatches = response.matchAll(/\[LEARN:\s*(.+?)\]/gi);
     for (const match of learnMatches) {
       const fact = match[1].trim();
       await insertGlobalMemory(fact, threadDbId);
       clean = clean.replace(match[0], "");
       console.log(`Learned: ${fact}`);
     }

     // [FORGET: search text to remove a fact]
     const forgetMatches = response.matchAll(/\[FORGET:\s*(.+?)\]/gi);
     for (const match of forgetMatches) {
       const searchText = match[1].trim();
       const deleted = await deleteGlobalMemory(searchText);
       if (deleted) {
         console.log(`Forgot memory matching: ${searchText}`);
       }
       clean = clean.replace(match[0], "");
     }

     return clean.trim();
   }
   ```

### Verification:
- `[LEARN: fact]` → calls `insertGlobalMemory(fact, threadDbId)` — facts stored in `global_memory` table with source thread tracking
- `[FORGET: text]` → calls `deleteGlobalMemory(text)` — searches and deletes from `global_memory`
- `[REMEMBER:]` handler removed (was writing to old `memory` table)
- `[GOAL:]` handler removed
- `[DONE:]` handler removed
- `[VOICE_REPLY]` still handled in the message handlers (not in processIntents), no change needed
- Old `memory` table is no longer written to by any code path

---

## Prompt 3: Update all message handlers for new signatures

**File:** `src/relay.ts`
**What:** Update all 4 message handlers to pass `ctx.threadInfo` to `buildPrompt()` and `ctx.threadInfo?.dbId` to `processIntents()`. Also remove v1 logging calls (`logMessage`, `logEvent`) since v2 thread-aware logging handles it.

### Text handler (line ~806):

Replace:
```typescript
const enrichedPrompt = await buildPrompt(text);
const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
const response = await processIntents(rawResponse);
```

With:
```typescript
const enrichedPrompt = await buildPrompt(text, ctx.threadInfo);
const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
const response = await processIntents(rawResponse, ctx.threadInfo?.dbId);
```

Remove these v1 logging lines:
```typescript
await logMessage("user", text);          // before callClaude
await logMessage("assistant", cleanResponse);  // after processIntents
await logEvent("message", text.substring(0, 100));
```

### Voice handler (line ~846):

Replace:
```typescript
const enrichedPrompt = await buildPrompt(transcription);
const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
const claudeResponse = await processIntents(rawResponse);
```

With:
```typescript
const enrichedPrompt = await buildPrompt(transcription, ctx.threadInfo);
const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
const claudeResponse = await processIntents(rawResponse, ctx.threadInfo?.dbId);
```

Remove these v1 logging lines:
```typescript
await logMessage("user", `[Voice]: ${transcription}`);
await logMessage("assistant", claudeResponse);
await logEvent("voice_message", transcription.substring(0, 100));
```

### Photo handler (line ~902):

Replace:
```typescript
const caption = ctx.message.caption || "Analyze this image.";
const prompt = `[Image: ${filePath}]\n\n${caption}`;

await logMessage("user", `[Image] ${caption}`);

const { text: rawResponse } = await callClaude(prompt, ctx.threadInfo);
const claudeResponse = await processIntents(rawResponse);
```

With:
```typescript
const caption = ctx.message.caption || "Analyze this image.";
const enrichedPrompt = await buildPrompt(`[Image: ${filePath}]\n\n${caption}`, ctx.threadInfo);
const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
const claudeResponse = await processIntents(rawResponse, ctx.threadInfo?.dbId);
```

Note: The `[Image: path]` reference is now part of the user message inside `buildPrompt()`, so soul and memory context appear before it in the final prompt.

Also remove:
```typescript
await logMessage("assistant", claudeResponse);
```

### Document handler (line ~948):

Replace:
```typescript
const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
const prompt = `[File: ${filePath}]\n\n${caption}`;

await logMessage("user", `[File: ${doc.file_name}] ${caption}`);

const { text: rawResponse } = await callClaude(prompt, ctx.threadInfo);
const claudeResponse = await processIntents(rawResponse);
```

With:
```typescript
const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
const enrichedPrompt = await buildPrompt(`[File: ${filePath}]\n\n${caption}`, ctx.threadInfo);
const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
const claudeResponse = await processIntents(rawResponse, ctx.threadInfo?.dbId);
```

Same pattern as photos — media reference is part of the user message, so soul/memory context appears before it.

Also remove:
```typescript
await logMessage("assistant", claudeResponse);
```

### Verification:
- All 4 handlers pass `ctx.threadInfo` to `buildPrompt()`
- All 4 handlers pass `ctx.threadInfo?.dbId` to `processIntents()`
- Photos and documents now get full memory context via `buildPrompt()` (previously they had none)
- V1 `logMessage()` and `logEvent()` calls removed from all handlers
- V2 thread-aware logging (`insertThreadMessage`, `incrementThreadMessageCount`, `logEventV2`) remains unchanged
- DMs still work: `threadInfo` may be undefined, `buildPrompt()` gracefully skips thread context

---

## Prompt 4: Add thread summary auto-generation

**File:** `src/relay.ts`
**What:** Add a `maybeUpdateThreadSummary()` function that triggers after every 5 exchanges (based on message count). It fetches recent messages and makes a standalone Claude call to generate a summary, then stores it via `updateThreadSummary()`. Call it from each message handler after incrementing the count.

### Add new function (after `callClaude()`, around line ~778):

```typescript
async function maybeUpdateThreadSummary(threadInfo: ThreadInfo): Promise<void> {
  if (!threadInfo?.dbId) return;

  // Only update summary every 5 exchanges
  const newCount = await incrementThreadMessageCount(threadInfo.dbId);
  if (newCount === 0 || newCount % 5 !== 0) return;

  try {
    const recentMessages = await getRecentThreadMessages(threadInfo.dbId, 10);
    if (recentMessages.length < 3) return;

    const messagesText = recentMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const summaryPrompt = `Summarize this conversation thread concisely in 2-3 sentences. Focus on the main topics discussed and any decisions or outcomes. Do NOT include any tags like [LEARN:] or [FORGET:].

${messagesText}`;

    // Standalone call — no --resume, no thread session
    const { text: summary } = await callClaude(summaryPrompt);
    if (summary && !summary.startsWith("Error:")) {
      await updateThreadSummary(threadInfo.dbId, summary);
      console.log(`Thread summary updated (${threadInfo.dbId}): ${summary.substring(0, 80)}...`);
    }
  } catch (e) {
    console.error("Thread summary generation error:", e);
  }
}
```

### Update all 4 message handlers:

In each handler's v2 logging block, replace:
```typescript
await incrementThreadMessageCount(ctx.threadInfo.dbId);
```

With:
```typescript
await maybeUpdateThreadSummary(ctx.threadInfo);
```

Note: `maybeUpdateThreadSummary()` already calls `incrementThreadMessageCount()` internally, so the explicit call is removed to avoid double-counting.

### Verification:
- `maybeUpdateThreadSummary()` calls `incrementThreadMessageCount()` — no double counting
- Summary only generated when `messageCount % 5 === 0`
- Summary call is standalone (no `--resume`, no threadInfo passed) — doesn't pollute conversation
- Summary prompt explicitly tells Claude not to include intent tags
- Recent 10 messages used for summary context (more than the 5 shown in prompt)
- Errors are caught and logged, never break the main response flow
- All 4 handlers call `maybeUpdateThreadSummary()` instead of `incrementThreadMessageCount()`

---

## Prompt 5: Clean up dead v1 code

**File:** `src/relay.ts`
**What:** Remove v1 functions and code that are no longer called after Prompts 1-4. Keep the old `memory` table data intact in Supabase (it's just no longer read/written).

### Remove these functions:

1. **`getMemoryContext()`** (lines 345-399) — replaced by layered loading in `buildPrompt()`
2. **`processIntents()` old version** — already replaced in Prompt 2

### Remove these v1 logging functions (no longer called by any handler):

3. **`logMessage()`** (lines 316-328) — replaced by `insertThreadMessage()`
4. **`logEvent()`** (lines 330-343) — replaced by `logEventV2()`

### Update startup call:

5. **Replace `logEvent()` at startup** (line ~1073):
   ```typescript
   // REPLACE:
   await logEvent("bot_started", "Relay started");
   // WITH:
   await logEventV2("bot_started", "Relay started");
   ```

### Keep:
- All v2 Supabase helpers (they're actively used)
- The Supabase client initialization
- `readFile`, `writeFile`, `unlink` imports (used by voice, TTS, lock)

### Verification:
- Grep for `getMemoryContext` → 0 results
- Grep for `logMessage(` → 0 results (only `insertThreadMessage` remains)
- Grep for `logEvent(` → only `logEventV2(` references remain
- Startup `logEvent("bot_started"` replaced with `logEventV2("bot_started"` — no runtime error
- No import changes needed
- Supabase v1 tables still exist in database, just unused by code

---

## Execution Order

1. **Prompt 1** → Rewrite `buildPrompt()` (foundation — new memory assembly)
2. **Prompt 2** → Rewrite `processIntents()` (new intent handlers)
3. **Prompt 3** → Update all message handlers (wire new signatures, remove v1 logging)
4. **Prompt 4** → Add thread summary generation (depends on Prompt 3 handler changes)
5. **Prompt 5** → Clean up dead v1 code (depends on all above removing references)

## Files Modified

| File | Changes |
|------|---------|
| `src/relay.ts` | `buildPrompt()` rewrite, `processIntents()` rewrite, handler updates, `maybeUpdateThreadSummary()` addition, v1 dead code removal |

## Risk Assessment

- **Medium risk**: Prompt engineering for `[LEARN:]` auto-extraction. Claude needs to be instructed clearly but concisely. If it over-learns (too many facts) or under-learns (misses important things), the prompt instructions in `buildPrompt()` may need tuning. Mitigated by keeping instructions minimal and explicit ("under 15 words each", "only genuinely useful things").
- **Medium risk**: Thread summary generation makes an extra Claude CLI call every 5 messages. This adds latency to every 5th message. Mitigated by: the summary call is standalone (no session), and errors don't block the main response.
- **Low risk**: Removing v1 logging. Data in old Supabase tables is preserved, just no longer written to.
- **Rollback**: Revert `buildPrompt()` to use `getMemoryContext()`, restore old `processIntents()`, and re-add v1 logging calls in handlers.
