# PLAN.md — Phase 5: Polish & Hardening

**Goal:** Error handling, edge cases, user-facing commands, and documentation updates. Make the bot production-ready with `/new` and `/memory` commands, graceful group handling, robust response parsing, and docs that reflect the v2 architecture.

**Requirements:** R6 (Backward Compatibility), all (polish touches everything)
**Depends on:** Phase 4 (done)

**Key insight:** The core relay (`src/relay.ts`) is already clean — main v1 dead code (functions `logMessage`, `logEvent`, `getMemoryContext`, old `processIntents`) was removed in Phase 4. Phase 5 is additive (new commands, better error paths), documentary (CLAUDE.md, README, examples), and handles remaining v1 artifacts (relay.ts header comment, `examples/memory.ts` v1 types/functions). The biggest value is the `/new` and `/memory` commands which give the user direct control over sessions and memory.

---

## Prompt 1: Add /new command to reset thread session

**File:** `src/relay.ts`
**What:** Add a `/new` command that clears the Claude CLI session for the current thread, giving the user a fresh conversation within the same Telegram topic. The thread's message history and summary remain in Supabase — only the `claude_session_id` is cleared.

### Changes:

1. **Add a helper function** to clear a thread's session (after `setSoul()`, around line 289):

   ```typescript
   async function clearThreadSession(threadDbId: string): Promise<boolean> {
     if (!supabase) return false;
     try {
       await supabase
         .from("threads")
         .update({ claude_session_id: null, updated_at: new Date().toISOString() })
         .eq("id", threadDbId);
       return true;
     } catch (e) {
       console.error("clearThreadSession error:", e);
       return false;
     }
   }
   ```

2. **Add the command handler** (after the `/soul` handler, around line 696):

   ```typescript
   bot.command("new", async (ctx) => {
     if (!ctx.threadInfo?.dbId) {
       await ctx.reply("Starting fresh. (No thread context to reset.)");
       return;
     }

     const success = await clearThreadSession(ctx.threadInfo.dbId);
     if (success) {
       ctx.threadInfo.sessionId = null;
       await logEventV2("session_reset", "User started new session", {}, ctx.threadInfo.dbId);
       await ctx.reply("Session reset. Next message starts a fresh conversation.");
     } else {
       await ctx.reply("Could not reset session. Check Supabase connection.");
     }
   });
   ```

### Verification:
- `/new` clears `claude_session_id` to null in the threads table
- Next message in that thread starts a brand new Claude session (no `--resume`)
- Thread history (messages, summary) is preserved — only the CLI session resets
- Works in both DM and group topic contexts
- Graceful fallback when no thread context exists
- Event logged to `logs_v2`

---

## Prompt 2: Add /memory command to show global memory

**File:** `src/relay.ts`
**What:** Add a `/memory` command that displays all learned facts from `global_memory`. This gives the user visibility into what the bot has learned about them and helps them decide what to `[FORGET:]`.

### Changes:

Add command handler (after the `/new` handler):

```typescript
bot.command("memory", async (ctx) => {
  const memories = await getGlobalMemory();

  if (memories.length === 0) {
    await ctx.reply("No memories stored yet. I'll learn facts about you as we chat.");
    return;
  }

  let text = `I know ${memories.length} thing${memories.length === 1 ? "" : "s"} about you:\n\n`;
  text += memories.map((m, i) => `${i + 1}. ${m}`).join("\n");
  text += "\n\nTo remove a fact, just ask me to forget it.";

  await sendResponse(ctx, text);
});
```

### Verification:
- `/memory` shows numbered list of all global memory items
- Uses `sendResponse()` for proper chunking if list is very long
- Empty state handled with a friendly message
- No new Supabase queries needed — reuses `getGlobalMemory()`

---

## Prompt 3: Graceful group handling

**File:** `src/relay.ts`
**What:** Update the thread routing middleware to properly handle groups without Topics enabled. Treat the entire group as a single conversation (titled "Group Chat"). Also handle the "General" topic edge case in groups with Topics (the General topic has no `message_thread_id`).

### Changes:

Replace the thread routing middleware (find `// THREAD ROUTING MIDDLEWARE` section) with:

```typescript
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

  const chatType = ctx.chat?.type;
  const telegramThreadId = ctx.message?.message_thread_id ?? null;

  // Determine title and thread ID based on chat context
  let title: string;
  let threadId: number | null = telegramThreadId;

  if (chatType === "private") {
    // DM: no thread ID, titled "DM"
    title = "DM";
  } else if (telegramThreadId != null && ctx.message?.is_topic_message) {
    // Group with Topics: specific topic
    title = `Topic ${telegramThreadId}`;
  } else if ((chatType === "group" || chatType === "supergroup") && telegramThreadId === null) {
    // Group without Topics, OR the "General" topic in a group with Topics
    // Either way, treat as a single conversation for this chat
    title = "Group Chat";
    threadId = null;
  } else {
    // Fallback
    title = "DM";
  }

  const thread = await getOrCreateThread(chatId, threadId, title);

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

### Verification:
- **DMs** (`chatType === "private"`): Route correctly as before, titled "DM", `threadId = null`
- **Group with Topics** (topic message with `message_thread_id`): Route to specific topic thread
- **Group without Topics** (group/supergroup, no `message_thread_id`): Treated as single conversation titled "Group Chat"
- **General topic** in a group with Topics (no `message_thread_id` but in a supergroup): Falls into "Group Chat" path — correct, as General has no dedicated thread ID
- No crash or confusing error in any scenario
- Existing DM and topic routing is unbroken

---

## Prompt 4: Harden callClaude() with timeout and size guard

**File:** `src/relay.ts`
**What:** Add a 5-minute timeout to `callClaude()` and guard against very large JSON responses that could cause OOM during `JSON.parse`.

### Changes:

1. **Add a constant** at the top of the file (near other constants):

   ```typescript
   const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
   const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB
   ```

2. **Update callClaude()** — replace the output reading section (find `const output = await new Response(proc.stdout).text();`) with timeout-wrapped version:

   ```typescript
   const timeoutPromise = new Promise<never>((_, reject) =>
     setTimeout(() => {
       proc.kill();
       reject(new Error("Claude CLI timed out"));
     }, CLAUDE_TIMEOUT_MS)
   );

   let output: string;
   let stderrText: string;
   let exitCode: number;
   try {
     [output, stderrText, exitCode] = await Promise.race([
       Promise.all([
         new Response(proc.stdout).text(),
         new Response(proc.stderr).text(),
         proc.exited,
       ]),
       timeoutPromise,
     ]);
   } catch (error: any) {
     if (error.message?.includes("timed out")) {
       console.error("Claude CLI timed out");
       return { text: "Sorry, that request took too long. Please try a simpler query.", sessionId: null };
     }
     throw error;
   }
   ```

3. **Add size guard** — before the `JSON.parse(output)` call, add:

   ```typescript
   if (output.length > MAX_OUTPUT_SIZE) {
     console.warn(`Claude output very large (${output.length} bytes), truncating`);
     output = output.substring(0, MAX_OUTPUT_SIZE);
   }
   ```

4. **Rename `stderr` variable** to `stderrText` to avoid shadowing (update all references to `stderr` within `callClaude()` to use `stderrText` instead).

### Verification:
- Claude CLI calls time out after 5 minutes with a user-friendly message
- Timed-out processes are killed (`proc.kill()`)
- Very large responses (>1MB) are truncated before JSON parsing
- Normal operation unaffected — timeout and size guard only trigger on edge cases
- Variable naming clean (no `stderr` shadowing)

---

## Prompt 5: Clean up remaining v1 artifacts

**File:** `src/relay.ts`, `examples/memory.ts`
**What:** Fix the relay.ts header comment (still mentions "goals") and fully rewrite `examples/memory.ts` to remove v1-only types and functions, replacing them with v2 patterns.

### Change A: Fix relay.ts header comment

Find the file header comment (lines 1-10):
```typescript
/**
 * Claude Code Telegram Relay
 *
 * Relay that connects Telegram to Claude Code CLI with:
 * - Supabase persistence (conversations, memory, goals)
 * - Voice transcription via mlx_whisper
 * - Intent-based memory management (Claude manages memory automatically)
 *
 * Run: bun run src/relay.ts
 */
```

Replace with:
```typescript
/**
 * Claude Code Telegram Relay
 *
 * Relay that connects Telegram to Claude Code CLI with:
 * - Threaded conversations (DMs + Telegram Topics)
 * - Three-layer memory (soul, global facts, thread context)
 * - Voice transcription via mlx_whisper
 * - Intent-based memory management ([LEARN:]/[FORGET:] tags)
 *
 * Run: bun run src/relay.ts
 */
```

### Change B: Rewrite examples/memory.ts

Replace the entire file with a v2-aware version that keeps the local JSON pattern (still useful for prototyping) but replaces v1 types (`Goal`, `CompletedGoal`) and functions (`addGoal`, `completeGoal`) with v2 patterns:

```typescript
/**
 * Memory Persistence Example
 *
 * Patterns for giving your bot persistent memory:
 * 1. Local JSON file (simplest, good for prototyping)
 * 2. Intent-based auto-learning (v2 — used by the relay)
 * 3. Supabase cloud persistence (production)
 *
 * The relay uses Option 2 + 3: Claude auto-extracts facts via [LEARN:] tags,
 * stored in Supabase's global_memory table.
 */

import { readFile, writeFile } from "fs/promises";

// ============================================================
// TYPES
// ============================================================

interface Memory {
  facts: string[]; // Things to always remember
}

// ============================================================
// OPTION 1: LOCAL JSON FILE (Simplest — good for prototyping)
// ============================================================

const MEMORY_FILE = process.env.MEMORY_FILE || "/tmp/bot-memory.json";

export async function loadMemory(): Promise<Memory> {
  try {
    const content = await readFile(MEMORY_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { facts: [] };
  }
}

export async function saveMemory(memory: Memory): Promise<void> {
  await writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

export async function addFact(fact: string): Promise<string> {
  const memory = await loadMemory();
  memory.facts.push(fact);
  await saveMemory(memory);
  return `Remembered: "${fact}"`;
}

export async function removeFact(searchText: string): Promise<string> {
  const memory = await loadMemory();
  const index = memory.facts.findIndex((f) =>
    f.toLowerCase().includes(searchText.toLowerCase())
  );

  if (index === -1) {
    return `No fact found matching "${searchText}"`;
  }

  const [removed] = memory.facts.splice(index, 1);
  await saveMemory(memory);
  return `Forgot: "${removed}"`;
}

export async function getMemoryContext(): Promise<string> {
  const memory = await loadMemory();
  let context = "";

  if (memory.facts.length > 0) {
    context += "\nTHINGS I KNOW ABOUT THE USER:\n";
    context += memory.facts.map((f) => `- ${f}`).join("\n");
  }

  return context;
}

// ============================================================
// OPTION 2: INTENT-BASED AUTO-LEARNING (v2 — used by the relay)
// ============================================================

/*
The relay uses intent tags that Claude includes in responses.
These are parsed and stripped before delivery to the user.

Add this to your Claude prompt:

"
MEMORY INSTRUCTIONS:
You can automatically learn and remember facts about the user.
When you notice something worth remembering, include this tag:

[LEARN: concise fact about the user]

Keep learned facts very concise (under 15 words each).
Only learn genuinely useful things.

To remove an outdated or wrong fact:
[FORGET: search text matching the fact to remove]
"

Then parse Claude's response:

async function processIntents(response: string): Promise<string> {
  let clean = response;

  // [LEARN: concise fact about the user]
  const learnMatches = response.matchAll(/\[LEARN:\s*(.+?)\]/gi);
  for (const match of learnMatches) {
    const fact = match[1].trim();
    await insertGlobalMemory(fact);
    clean = clean.replace(match[0], "");
  }

  // [FORGET: search text to remove a fact]
  const forgetMatches = response.matchAll(/\[FORGET:\s*(.+?)\]/gi);
  for (const match of forgetMatches) {
    await deleteGlobalMemory(match[1].trim());
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}
*/

// ============================================================
// OPTION 3: SUPABASE CLOUD PERSISTENCE (Production)
// ============================================================

/*
The relay stores learned facts in Supabase's global_memory table.
See examples/supabase-schema-v2.sql for the full schema.

Tables:
- global_memory: Cross-thread facts (content, source_thread_id)
- bot_soul: Personality definition (content, is_active)
- threads: Conversation channels (session, summary)
- thread_messages: Per-thread message history

Example:

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function getGlobalMemory(): Promise<string[]> {
  const { data } = await supabase
    .from("global_memory")
    .select("content")
    .order("created_at", { ascending: false })
    .limit(30);
  return (data || []).map((m) => m.content);
}

async function insertGlobalMemory(content: string): Promise<void> {
  await supabase.from("global_memory").insert({ content });
}

async function deleteGlobalMemory(searchText: string): Promise<boolean> {
  const { data: items } = await supabase
    .from("global_memory")
    .select("id, content");
  const match = items?.find((m) =>
    m.content.toLowerCase().includes(searchText.toLowerCase())
  );
  if (match) {
    await supabase.from("global_memory").delete().eq("id", match.id);
    return true;
  }
  return false;
}
*/
```

### Verification:
- `relay.ts` header no longer mentions "goals" — lists v2 features instead
- `examples/memory.ts` no longer exports v1-only functions (`addGoal`, `completeGoal`)
- `examples/memory.ts` no longer has v1-only types (`Goal`, `CompletedGoal`)
- `examples/memory.ts` Option 1 (local JSON) is streamlined — only facts, no goals
- `examples/memory.ts` Option 2 shows v2 `[LEARN:]`/`[FORGET:]` pattern
- `examples/memory.ts` Option 3 shows Supabase v2 helpers (not old `memory` table)
- Grep for `\[REMEMBER:\]` in examples → 0 results
- Grep for `\[GOAL:\]` in examples → 0 results
- Grep for `\[DONE:\]` in examples → 0 results

---

## Prompt 6: Update CLAUDE.md with v2 architecture

**File:** `CLAUDE.md`
**What:** Rewrite to reflect the current v2 architecture: threaded conversations, three-layer memory, new intent system, new commands, new Supabase schema.

### Replace entire file content with:

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A relay that bridges Telegram to the Claude Code CLI with threaded conversations, persistent memory, voice I/O, and unrestricted permissions. Messages sent via Telegram are passed to `claude -p --dangerously-skip-permissions`, and responses are sent back. This gives full Claude Code capabilities (tools, MCP servers, file access, shell commands) from a phone.

```
Telegram App → Telegram Bot API → Relay (Bun/TypeScript) → claude CLI → Response back
```

## Commands

```bash
bun run start          # Run the relay
bun run dev            # Run with hot-reload (--watch)
```

**Bot commands (in Telegram):**
- `/soul <text>` — Set the bot's personality (loaded into every prompt)
- `/new` — Reset the Claude session for the current thread (fresh conversation)
- `/memory` — Show all learned facts about the user

**Daemon management (macOS LaunchAgent):**
```bash
launchctl load ~/Library/LaunchAgents/com.claude-telegram-relay.plist
launchctl unload ~/Library/LaunchAgents/com.claude-telegram-relay.plist
launchctl list | grep claude-telegram
tail -f ~/.claude-relay/relay.log
tail -f ~/.claude-relay/relay-error.log
```

## Architecture

**Single file core** — `src/relay.ts` is the entire relay.

**Message flow**: Every message goes through `buildPrompt()` → `callClaude()` → `processIntents()` → response sent back. The prompt includes three memory layers and instructions for intent tags.

**Threading model:**
- Bot works in Telegram DMs (single conversation) and supergroups with Topics (one conversation per topic)
- Each thread gets its own Claude CLI session via `--resume`
- Session IDs stored per-thread in Supabase `threads` table
- Groups without Topics are treated as a single conversation

**Three-layer memory system** (assembled in `buildPrompt()`):
1. **Soul** — Bot personality from `bot_soul` table, loaded at the top of every prompt
2. **Global memory** — Cross-thread facts from `global_memory` table, auto-learned via `[LEARN:]` intent
3. **Thread context** — Per-thread summary + recent 5 messages from Supabase

**Key sections in relay.ts:**

- **Supabase v2 layer** — `getOrCreateThread()`, `updateThreadSession()`, `insertThreadMessage()`, `getRecentThreadMessages()`, `getGlobalMemory()`, `insertGlobalMemory()`, `deleteGlobalMemory()`, `getActiveSoul()`, `setSoul()`, `logEventV2()`
- **Intent system** — Claude includes tags in responses that get parsed and stripped before delivery:
  - `[LEARN: fact]` → inserts into `global_memory` table
  - `[FORGET: search text]` → deletes matching fact from `global_memory`
  - `[VOICE_REPLY]` → triggers ElevenLabs TTS for the response
- **Thread routing middleware** — Extracts `message_thread_id`, creates/finds thread in Supabase, attaches `threadInfo` to context
- **callClaude()** — Spawns `claude -p "<prompt>" --resume <sessionId> --output-format json --dangerously-skip-permissions`. Parses JSON for response text and session ID. Auto-retries without `--resume` if session is expired/corrupt. 5-minute timeout.
- **Thread summary generation** — `maybeUpdateThreadSummary()` triggers every 5 exchanges, makes a standalone Claude call to summarize the conversation
- **Voice transcription** — `transcribeAudio()` converts .oga→.wav via ffmpeg, then runs mlx_whisper (large-v3-turbo, Portuguese default)
- **Text-to-speech** — `textToSpeech()` calls ElevenLabs v3 API, outputs opus format. Max 4500 chars per request.
- **Voice reply logic**:
  - Voice message in → always reply with voice + text
  - Text message in + `[VOICE_REPLY]` tag → voice + text
  - Text message in, no tag → text only

**Message handlers**: Text, voice, photos, documents. Media is downloaded to `~/.claude-relay/uploads/`, file path passed to Claude, cleaned up after processing.

**Examples directory** — Reference patterns, not part of the running relay:
- `morning-briefing.ts`: Cron-triggered daily summary
- `smart-checkin.ts`: Periodic script where Claude decides whether to message you
- `memory.ts`: Memory patterns (local JSON, Supabase, intent-detection)
- `supabase-schema.sql`: Original v1 schema (reference only)
- `supabase-schema-v2.sql`: Current v2 schema (threads, global_memory, bot_soul, logs_v2)

## Supabase Schema (v2)

Tables used by the relay:
- `threads` — Conversation channels (telegram IDs, claude session, summary, message count)
- `thread_messages` — Per-thread message history (role, content)
- `global_memory` — Cross-thread learned facts (content, source thread)
- `bot_soul` — Personality definitions (content, is_active)
- `logs_v2` — Observability events (event, message, metadata, thread_id)

Migration: `supabase/migrations/20260210202924_schema_v2_threads_memory_soul.sql`
Reference SQL: `examples/supabase-schema-v2.sql`

## Environment Variables

Required in `.env`:
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_USER_ID` — numeric ID from @userinfobot (security gate)

Paths:
- `CLAUDE_PATH` — defaults to `claude` in PATH
- `PROJECT_DIR` — working directory for Claude CLI spawns
- `RELAY_DIR` — defaults to `~/.claude-relay`
- `MLX_WHISPER_PATH` — defaults to `/Users/roviana/.local/bin/mlx_whisper`

Supabase:
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (or `SUPABASE_ANON_KEY`)

ElevenLabs TTS:
- `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`

## Runtime State

All state lives in `~/.claude-relay/`:
- `bot.lock` — PID-based single-instance lock
- `uploads/` — temporary media downloads from Telegram (cleaned after processing)
- `temp/` — whisper output and TTS audio files (cleaned after use)
- `relay.log`, `relay-error.log` — daemon stdout/stderr

Note: Session state is stored per-thread in Supabase (`threads.claude_session_id`), not on disk.

## Dependencies

- **grammy** ^1.37+ — Telegram Bot API framework (long-polling, native auto-thread support)
- **@supabase/supabase-js** ^2.95+ — Cloud persistence for threads, memory, and logs
- **Bun runtime** — `Bun.spawn()` for process spawning
- **mlx_whisper** (system) — Local voice transcription on Apple Silicon
- **ffmpeg** (system) — Audio format conversion (.oga → .wav)
- **ElevenLabs API** (external) — Text-to-speech via eleven_v3 model
```

### Verification:
- No references to `[REMEMBER:]`, `[GOAL:]`, `[DONE:]` (old v1 intents)
- No references to `session.json` (replaced by per-thread Supabase storage)
- New commands (`/new`, `/memory`) documented
- Threading model explained
- Three-layer memory system described
- Supabase v2 schema documented
- `--output-format json` documented (not `text`)

---

## Prompt 7: Update README.md

**File:** `README.md`
**What:** Update to mention group/thread support, new commands, v2 memory system, and correct environment variables.

### Changes (identified by content patterns, not line numbers):

1. **Find the Architecture file tree** (the `src/` + `examples/` tree under `## Architecture`) and replace it with:

   ```
   src/
     relay.ts              # Core relay (what you customize)

   examples/
     morning-briefing.ts   # Scheduled daily summary
     smart-checkin.ts      # Proactive check-ins
     memory.ts             # Memory patterns (local JSON + intent-based)
     supabase-schema.sql   # v1 schema (reference)
     supabase-schema-v2.sql  # v2 schema (threads, memory, soul)

   supabase/
     migrations/           # Applied migration files
   ```

2. **Find the "Session Continuity" code block** (under `### Session Continuity`) and replace it with:

   ```typescript
   // Resume conversations with --resume and JSON output
   const proc = spawn([
     "claude", "-p", prompt,
     "--resume", sessionId,
     "--output-format", "json"  // Get session_id in response
   ]);
   const json = JSON.parse(await new Response(proc.stdout).text());
   const response = json.result;
   const newSessionId = json.session_id;  // Store for next call
   ```

3. **Find the "Persistent Memory" code block** (under `### Persistent Memory`) and replace it with:

   ```typescript
   // Three-layer memory: soul + global facts + thread context
   const soul = await getActiveSoul();        // Personality
   const facts = await getGlobalMemory();     // Cross-thread facts
   const summary = thread.summary;            // Thread summary
   const fullPrompt = `${soul}
   Facts: ${facts.join(", ")}
   Thread context: ${summary}
   User: ${prompt}`;
   ```

4. **Find the "Memory Persistence" subsection** (under `### Memory Persistence`) and replace description with:

   ```
   ### Memory Persistence (`examples/memory.ts`)

   Patterns for persistent memory:
   - Local JSON file (simplest, good for prototyping)
   - Intent-based auto-learning (Claude decides what to remember via `[LEARN:]` tags)
   - Supabase cloud persistence (production, used by the relay)
   ```

5. **Find `GEMINI_API_KEY`** in the Environment Variables section and replace that line with:

   ```
   MLX_WHISPER_PATH=         # For voice transcription (mlx_whisper, macOS only)
   ```

6. **Add a "Bot Commands" section** — insert before `## FAQ`:

   ```markdown
   ## Bot Commands

   | Command | Description |
   |---------|-------------|
   | `/soul <text>` | Set the bot's personality (loaded into every prompt) |
   | `/new` | Reset Claude session for the current thread |
   | `/memory` | Show all learned facts about you |
   ```

7. **Add a "Group / Thread Setup" section** — insert after "Bot Commands", before `## FAQ`:

   ```markdown
   ## Group / Thread Setup

   The relay supports Telegram supergroups with Topics for parallel conversations:

   1. Create a supergroup in Telegram
   2. Enable Topics in group settings
   3. Add your bot to the group
   4. Disable "Group Privacy" in @BotFather (so the bot reads all messages)
   5. Each forum topic becomes an independent conversation with its own Claude session

   DM mode continues to work as before (single conversation).
   ```

### Verification:
- README shows `--output-format json` (not `text`)
- README documents `/soul`, `/new`, `/memory` commands
- README explains group/thread setup
- README architecture lists v2 schema file and supabase migrations
- README environment no longer references `GEMINI_API_KEY`

---

## Prompt 8: Verify media handlers in thread context

**File:** `src/relay.ts` (read-only audit)
**What:** Audit all four message handlers (text, voice, photo, document) to confirm they correctly pass `ctx.threadInfo` through the full flow: `buildPrompt()` → `callClaude()` → `processIntents()` → `insertThreadMessage()` → `maybeUpdateThreadSummary()`. This is a code review task, not a code change task.

### Audit checklist:

For each handler (text ~line 703, voice ~line 738, photo ~line 789, document ~line 830):

1. [ ] `buildPrompt(message, ctx.threadInfo)` — threadInfo passed to prompt builder
2. [ ] `callClaude(enrichedPrompt, ctx.threadInfo)` — threadInfo passed for `--resume`
3. [ ] `processIntents(rawResponse, ctx.threadInfo?.dbId)` — threadDbId passed for source tracking
4. [ ] `insertThreadMessage(ctx.threadInfo.dbId, "user", ...)` — user message logged to thread
5. [ ] `insertThreadMessage(ctx.threadInfo.dbId, "assistant", ...)` — assistant response logged to thread
6. [ ] `maybeUpdateThreadSummary(ctx.threadInfo)` — summary generation triggered
7. [ ] `logEventV2("...", ..., {}, ctx.threadInfo.dbId)` — event logged with thread ID
8. [ ] Guard: all thread operations wrapped in `if (ctx.threadInfo)` — DMs without Supabase don't crash

### Expected result:
All 4 handlers follow the same pattern. If any handler is missing a step, fix it in this prompt. Based on the Phase 4 implementation, all handlers should already be correct — this prompt confirms it.

### If issues found:
Apply the minimal fix (add the missing call or guard) directly. No architectural changes.

---

## Execution Order

1. **Prompt 1** → Add `/new` command (standalone, no dependencies)
2. **Prompt 2** → Add `/memory` command (standalone, no dependencies)
3. **Prompt 3** → Group handling middleware (modifies middleware)
4. **Prompt 4** → Harden `callClaude()` (modifies callClaude, independent of Prompt 3)
5. **Prompt 5** → Clean up v1 artifacts in relay.ts + examples/memory.ts
6. **Prompt 6** → Update CLAUDE.md (documentation — references commands from Prompts 1-2)
7. **Prompt 7** → Update README.md (documentation — references everything above)
8. **Prompt 8** → Verify media handlers (audit — done last to confirm everything works)

Parallelizable groups:
- **Wave 1**: Prompts 1, 2 (independent commands)
- **Wave 2**: Prompts 3, 4 (independent relay.ts changes — different functions)
- **Wave 3**: Prompt 5 (cleanup depends on knowing what changed above)
- **Wave 4**: Prompts 6, 7 (independent documentation)
- **Wave 5**: Prompt 8 (final audit)

## Files Modified

| File | Changes |
|------|---------|
| `src/relay.ts` | `clearThreadSession()`, `/new` handler, `/memory` handler, middleware rewrite for groups, `callClaude()` timeout + size guard, header comment fix |
| `CLAUDE.md` | Full rewrite to reflect v2 architecture |
| `README.md` | Architecture update, new commands, group setup, env vars fix |
| `examples/memory.ts` | Full rewrite: remove v1 types/functions, add v2 patterns |

## Roadmap Task Coverage

| # | Roadmap Task | Prompt | Status |
|---|---|---|---|
| 1 | Add `/new` command | Prompt 1 | Covered |
| 2 | Add `/memory` command | Prompt 2 | Covered |
| 3 | Handle group without Topics | Prompt 3 | Covered |
| 4 | Handle long Claude responses | Prompt 4 | Covered |
| 5 | Update CLAUDE.md | Prompt 6 | Covered |
| 6 | Update README/examples | Prompts 5, 7 | Covered |
| 7 | Test media handlers in thread context | Prompt 8 | Covered (audit) |
| 8 | Clean up dead code from old session mgmt | Prompt 5 | Covered |

## Risk Assessment

- **Low risk**: `/new` and `/memory` commands are purely additive, no existing behavior changes
- **Low risk**: Group without Topics handling is a new code path. DM and Topics routing verified unchanged via explicit `chatType` branching
- **Low risk**: Claude CLI timeout (5 min) is generous — normal responses complete in seconds. Only triggers on genuine hangs
- **Low risk**: Output size guard (1MB) only triggers on extreme edge cases
- **Low risk**: examples/memory.ts rewrite is a reference file, not part of the running relay
- **No risk**: Documentation changes don't affect runtime behavior
- **Rollback**: Remove new command handlers and middleware changes. Revert docs from git.
