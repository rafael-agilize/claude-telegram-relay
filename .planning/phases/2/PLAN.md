# PLAN.md — Phase 2: Thread-Aware Message Routing

**Goal:** Bot works in both DMs and group forum topics, routing messages to the correct thread context.

**Requirements:** R1 (Telegram Group Thread Support), R4 (Bot Soul), R6 (Backward Compatibility)
**Depends on:** Phase 1 (done)

**Key insight:** Grammy ^1.37.1 handles auto-threading natively — `ctx.reply()` automatically replies in the same forum topic without extra configuration.

---

## Prompt 1: Thread context types and routing middleware

**File:** `src/relay.ts`
**What:** Add typed context, thread extraction helper, and Grammy middleware that resolves thread for every incoming message.

### Changes:

1. **Define `CustomContext` type** (after imports, before config):
   ```typescript
   interface ThreadInfo {
     dbId: string;
     chatId: number;
     threadId: number | null;
     title: string;
     sessionId: string | null;
     summary: string;
     messageCount: number;
   }

   type CustomContext = Context & { threadInfo?: ThreadInfo };
   ```

2. **Change bot instantiation** (line ~665):
   ```typescript
   // Before:
   const bot = new Bot(BOT_TOKEN);
   // After:
   const bot = new Bot<CustomContext>(BOT_TOKEN);
   ```

3. **Add thread routing middleware** (after the security middleware, before handlers):
   ```typescript
   // Thread routing: resolve thread for every incoming message
   bot.use(async (ctx, next) => {
     if (!ctx.message && !ctx.callbackQuery) {
       await next();
       return;
     }

     const chatId = ctx.chat?.id;
     if (!chatId) {
       await next();
       return;
     }

     // Extract thread ID: present in forum topic messages, null for DMs
     const telegramThreadId = ctx.message?.message_thread_id ?? null;

     // Determine title: topic name for groups, "DM" for direct messages
     const title = ctx.message?.is_topic_message
       ? `Topic ${telegramThreadId}`
       : "DM";

     const thread = await getOrCreateThread(chatId, telegramThreadId, title);

     if (thread) {
       ctx.threadInfo = {
         dbId: thread.id,
         chatId: thread.telegram_chat_id,
         threadId: thread.telegram_thread_id,
         title: thread.title || title,
         sessionId: thread.claude_session_id,
         summary: thread.summary || "",
         messageCount: thread.message_count || 0,
       };
     }

     await next();
   });
   ```

4. **Update the security middleware** to use `CustomContext` type:
   - Change `async (ctx, next)` to `async (ctx: CustomContext, next)` if needed for type inference (Grammy's `bot.use` should handle this via the generic).

### Verification:
- `bot` is typed as `Bot<CustomContext>`
- Security middleware still blocks unauthorized users
- Thread middleware runs after security, before all handlers
- DMs get a thread with `threadId: null`, title "DM"
- Forum topic messages get a thread with the actual `message_thread_id`

---

## Prompt 2: Refactor message handlers for thread awareness

**File:** `src/relay.ts`
**What:** Update all 4 message handlers (text, voice, photo, document) to use `ctx.threadInfo` for v2 logging. Keep v1 logging in parallel for backward compatibility during migration.

### Changes for each handler:

**General pattern** (apply to text, voice, photo, document handlers):

After calling `callClaude()` and `processIntents()`, add v2 logging alongside existing v1 calls:

```typescript
// V2 thread-aware logging (add alongside existing logMessage/logEvent calls)
if (ctx.threadInfo) {
  await insertThreadMessage(ctx.threadInfo.dbId, "user", userContent);
  await insertThreadMessage(ctx.threadInfo.dbId, "assistant", cleanResponse);
  await incrementThreadMessageCount(ctx.threadInfo.dbId);
  await logEventV2("message", userContent.substring(0, 100), {}, ctx.threadInfo.dbId);
}
```

### Text handler (`bot.on("message:text", ...)`) — line ~735:

1. Keep existing `logMessage("user", text)` (v1 compat)
2. After processIntents, add v2 thread logging:
   ```typescript
   // V2 logging
   if (ctx.threadInfo) {
     await insertThreadMessage(ctx.threadInfo.dbId, "user", text);
     await insertThreadMessage(ctx.threadInfo.dbId, "assistant", cleanResponse);
     await incrementThreadMessageCount(ctx.threadInfo.dbId);
     await logEventV2("message", text.substring(0, 100), {}, ctx.threadInfo.dbId);
   }
   ```
3. Keep existing `logMessage("assistant", cleanResponse)` and `logEvent()` (v1 compat)

### Voice handler (`bot.on("message:voice", ...)`) — line ~767:

1. Keep existing v1 logging
2. Add v2 logging with thread context:
   ```typescript
   if (ctx.threadInfo) {
     await insertThreadMessage(ctx.threadInfo.dbId, "user", `[Voice]: ${transcription}`);
     await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
     await incrementThreadMessageCount(ctx.threadInfo.dbId);
     await logEventV2("voice_message", transcription.substring(0, 100), {}, ctx.threadInfo.dbId);
   }
   ```

### Photo handler (`bot.on("message:photo", ...)`) — line ~815:

1. Keep existing v1 logging
2. Add v2 logging:
   ```typescript
   if (ctx.threadInfo) {
     await insertThreadMessage(ctx.threadInfo.dbId, "user", `[Image] ${caption}`);
     await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
     await incrementThreadMessageCount(ctx.threadInfo.dbId);
     await logEventV2("photo_message", caption.substring(0, 100), {}, ctx.threadInfo.dbId);
   }
   ```

### Document handler (`bot.on("message:document", ...)`) — line ~853:

1. Keep existing v1 logging
2. Add v2 logging:
   ```typescript
   if (ctx.threadInfo) {
     await insertThreadMessage(ctx.threadInfo.dbId, "user", `[File: ${doc.file_name}] ${caption}`);
     await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
     await incrementThreadMessageCount(ctx.threadInfo.dbId);
     await logEventV2("document_message", `${doc.file_name}`.substring(0, 100), {}, ctx.threadInfo.dbId);
   }
   ```

### Verification:
- All 4 handlers log to both v1 and v2 tables
- Thread messages are associated with the correct thread
- Message count increments per exchange
- DMs still work (threadInfo will have threadId: null, but dbId will be valid)
- No handler crashes if threadInfo is undefined (all guarded by `if (ctx.threadInfo)`)

---

## Prompt 3: Add /soul command handler

**File:** `src/relay.ts`
**What:** Register a `/soul` command that sets the bot personality stored in the `bot_soul` Supabase table. Place it after the thread middleware and before the message handlers.

### Changes:

1. **Add /soul command** (between middleware and `bot.on("message:text", ...)`):
   ```typescript
   // /soul command: set bot personality
   bot.command("soul", async (ctx) => {
     const text = ctx.match; // Grammy extracts text after the command
     if (!text || text.trim().length === 0) {
       // Show current soul
       const currentSoul = await getActiveSoul();
       await ctx.reply(`Current soul:\n\n${currentSoul}\n\nUsage: /soul <personality description>`);
       return;
     }

     const success = await setSoul(text.trim());
     if (success) {
       await logEventV2("soul_updated", text.trim().substring(0, 100), {}, ctx.threadInfo?.dbId);
       await ctx.reply(`Soul updated! New personality:\n\n${text.trim()}`);
     } else {
       await ctx.reply("Failed to update soul. Check Supabase connection.");
     }
   });
   ```

2. **Ensure Grammy's `ctx.match`** works: Grammy automatically populates `ctx.match` with the text after the command name. For `/soul You are a pirate`, `ctx.match` = `"You are a pirate"`.

### Verification:
- `/soul` with no text shows current soul
- `/soul <text>` updates the soul and confirms
- Works in both DMs and group topics (Grammy auto-threads the reply)
- Soul is persisted to Supabase `bot_soul` table
- Previous soul is deactivated (handled by existing `setSoul()` function)

---

## Prompt 4: Update sendResponse and verify backward compatibility

**File:** `src/relay.ts`
**What:** Confirm `sendResponse()` works in thread contexts. Grammy ^1.37.1 auto-threads replies, so minimal changes needed. Add a type annotation for safety.

### Changes:

1. **Update sendResponse signature** to accept `CustomContext`:
   ```typescript
   async function sendResponse(ctx: CustomContext, response: string): Promise<void> {
   ```
   (Grammy's auto-thread means `ctx.reply()` already replies in the correct topic — no other changes needed.)

2. **Add startup log for thread support**:
   ```typescript
   console.log(`Thread support: Grammy ${require("grammy/package.json").version} (auto-thread)`);
   ```
   Or simpler:
   ```typescript
   console.log("Thread support: enabled (Grammy auto-thread)");
   ```

3. **Verify backward compatibility checklist** (manual, not code):
   - DMs: chatId is used as thread identifier, `message_thread_id` is null → synthetic thread created in Supabase → messages logged to v2 tables → `ctx.reply()` works normally
   - Group topics: `message_thread_id` extracted → thread created/found → messages logged per-thread → `ctx.reply()` auto-threads to same topic
   - Voice transcription: works in both DM and thread (only handler logic changed, not transcription)
   - TTS: works in both (audio reply via `ctx.replyWithVoice()` also auto-threads)
   - Photos/documents: works in both (same pattern as text)
   - All existing .env variables: unchanged
   - Lock file: unchanged
   - Session management (v1): still works as fallback until Phase 3 replaces it

### Verification:
- `sendResponse` typed correctly for `CustomContext`
- No regression in DM mode
- Forum topic messages get threaded replies
- Startup logs show thread support info

---

## Execution Order

1. **Prompt 1** → Thread types + middleware (foundation)
2. **Prompt 2** → Handler refactoring (depends on Prompt 1 for threadInfo)
3. **Prompt 3** → /soul command (independent but placed after middleware)
4. **Prompt 4** → sendResponse update + verification (depends on Prompt 1-3)

## Files Modified

| File | Changes |
|------|---------|
| `src/relay.ts` | Thread types, middleware, handler refactoring, /soul command, sendResponse |

## Risk Assessment

- **Medium risk**: Changing message handler signatures. Mitigated by keeping v1 logging in parallel.
- **Low risk**: Grammy auto-threading is well-tested in ^1.37.1.
- **Low risk**: /soul command uses existing `setSoul()` function.
- **Rollback**: All v1 functions are preserved. Remove middleware and v2 logging calls to revert.
