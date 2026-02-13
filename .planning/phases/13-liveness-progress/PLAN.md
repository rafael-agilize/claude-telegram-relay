---
phase: 13-liveness-progress
plan: 01
type: execute
wave: 1
depends_on: [12-streaming-engine]
files_modified:
  - src/relay.ts
  - CLAUDE.md
autonomous: true

must_haves:
  truths:
    - "callClaude() accepts an optional onStreamEvent callback that fires for every parsed NDJSON event"
    - "All 4 message handlers (text, voice, photo, document) send typing indicators every 4 seconds while Claude works"
    - "Typing indicator interval is cleared when callClaude() returns or errors"
    - "Assistant events with tool_use content blocks trigger progress messages to Telegram"
    - "Progress messages are throttled to max 1 per 15 seconds"
    - "Rapid tool calls within a 15-second window are collapsed into a single progress message"
    - "A single editable status message is used (sent once, edited on updates, deleted on completion)"
    - "Tool names are mapped to user-friendly descriptions (Read → Reading file, Bash → Running command, etc.)"
    - "callClaude() retry path (session expired) forwards onStreamEvent to the recursive call"
    - "Heartbeat and cron callers work unchanged — they don't pass onStreamEvent"
    - "All existing tests/behavior preserved — only additive changes"
  artifacts:
    - path: "src/relay.ts"
      provides: "onStreamEvent callback in callClaude()"
      contains: "onStreamEvent"
    - path: "src/relay.ts"
      provides: "Typing indicator interval in message handlers"
      contains: "setInterval.*sendChatAction.*typing"
    - path: "src/relay.ts"
      provides: "Tool name display mapping"
      contains: "TOOL_DISPLAY_NAMES"
    - path: "src/relay.ts"
      provides: "Progress message throttling"
      contains: "PROGRESS_THROTTLE_MS"
    - path: "src/relay.ts"
      provides: "Liveness reporter factory"
      contains: "createLivenessReporter"
    - path: "CLAUDE.md"
      provides: "Updated documentation for liveness indicators"
      contains: "typing indicator"
  key_links:
    - from: "callClaude() onStreamEvent"
      to: "createLivenessReporter()"
      via: "Callback passed from handler to callClaude, fired on each NDJSON event"
      pattern: "onStreamEvent"
    - from: "assistant event with tool_use"
      to: "progress message"
      via: "Tool name extracted from event.message.content[].name, mapped via TOOL_DISPLAY_NAMES"
      pattern: "tool_use.*TOOL_DISPLAY_NAMES"
    - from: "typing interval"
      to: "cleanup()"
      via: "clearInterval in cleanup, called in finally block of each handler"
      pattern: "clearInterval"
---

<objective>
Add real-time Telegram feedback while Claude works on a request. Send continuous typing indicators (every 4s) and throttled progress messages showing which tools Claude is using (max 1 per 15s). Progress is shown via a single editable status message that gets deleted when the response arrives.

Purpose: Users see the bot is alive and know what Claude is doing during long tasks, instead of staring at a blank chat wondering if it crashed.

Output: Same relay behavior but with visible typing indicators and tool-use progress during Claude CLI execution.
</objective>

<execution_context>
@./.claude/get-shit-done/workflows/execute-plan.md
@./.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/REQUIREMENTS.md
@.planning/phases/12-streaming-engine/PLAN.md
@src/relay.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add onStreamEvent callback to callClaude()</name>
  <files>src/relay.ts</files>
  <action>
Add an optional third parameter to `callClaude()` that receives each parsed NDJSON event. This is the minimal hook that enables callers to react to stream events in real-time.

**Change the function signature** (line 1704-1706):

Find:
```typescript
async function callClaude(
  prompt: string,
  threadInfo?: ThreadInfo
): Promise<{ text: string; sessionId: string | null }> {
```

Replace with:
```typescript
async function callClaude(
  prompt: string,
  threadInfo?: ThreadInfo,
  onStreamEvent?: (event: any) => void
): Promise<{ text: string; sessionId: string | null }> {
```

**Fire the callback in the NDJSON parsing loop.** After the existing event parsing block (after the `if (event.type === "result")` block closes, around line 1825), add a callback invocation:

Find (inside the for-of loop over lines):
```typescript
          } catch {
            // Non-JSON line or partial data — skip silently
          }
```

Replace with:
```typescript
            // Fire callback for callers that want real-time event access
            onStreamEvent?.(event);
          } catch {
            // Non-JSON line or partial data — skip silently
          }
```

Note: The `onStreamEvent?.(event)` call goes INSIDE the try block, right before the catch — after all event processing (session ID, result text) is done. This ensures the callback receives fully-processed events.

**Forward onStreamEvent in the retry path.** The recursive retry call at line 1871 must pass the callback so liveness indicators survive session retries:

Find:
```typescript
        return callClaude(prompt, { ...threadInfo, sessionId: null });
```

Replace with:
```typescript
        return callClaude(prompt, { ...threadInfo, sessionId: null }, onStreamEvent);
```

**Also fire callback for remaining buffer processing.** In the "Process any remaining buffer content" section (around line 1836), add callback after the existing parsing:

Find:
```typescript
        resetInactivityTimer();
      } catch {
        // Incomplete JSON at end — ignore
      }
```

Replace with:
```typescript
        resetInactivityTimer();
        onStreamEvent?.(event);
      } catch {
        // Incomplete JSON at end — ignore
      }
```

**Requirements covered:** Infrastructure for PROG-01 (enables event-driven progress reporting)
  </action>
  <verify>
1. grep for "onStreamEvent" in relay.ts — should appear in function signature, 2 call sites inside parsing, and 1 in retry path
2. grep for "async function callClaude" in relay.ts confirms updated signature
3. grep for "callClaude(prompt, { ...threadInfo, sessionId: null }, onStreamEvent)" in relay.ts confirms retry forwards callback
4. All existing callers (line 830, 989, 1919, 2185, 2239, 2289, 2329) still compile — they pass 2 args, third is optional
5. `bun run start` boots without errors (Ctrl+C to stop)
  </verify>
  <done>
callClaude() now accepts an optional onStreamEvent callback. Fires for every parsed NDJSON event, enabling real-time progress reporting by callers.
  </done>
</task>

<task type="auto">
  <name>Task 2: Create liveness reporter system (typing + progress)</name>
  <files>src/relay.ts</files>
  <action>
Add constants, helpers, and the `createLivenessReporter()` factory function. Place these BEFORE the `callClaude()` function (around line 1700, after the `killOrphanedProcesses()` function).

**Add the following block** right before the `// ============================================================` comment line that precedes `callClaude()`:

```typescript
// ============================================================
// LIVENESS & PROGRESS INDICATORS
// ============================================================

const TYPING_INTERVAL_MS = 4_000; // Send typing action every 4s (expires after ~5s)
const PROGRESS_THROTTLE_MS = 15_000; // Max 1 progress message per 15s

// Map Claude CLI tool names to user-friendly descriptions
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Read: "Reading file",
  Write: "Writing file",
  Edit: "Editing file",
  Bash: "Running command",
  Glob: "Searching files",
  Grep: "Searching code",
  WebSearch: "Searching the web",
  WebFetch: "Fetching web page",
  Task: "Running sub-agent",
  NotebookEdit: "Editing notebook",
  EnterPlanMode: "Planning",
  AskUserQuestion: "Asking question",
};

function formatToolName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] || name;
}

interface LivenessReporter {
  onStreamEvent: (event: any) => void;
  cleanup: () => Promise<void>;
}

function createLivenessReporter(
  chatId: number,
  messageThreadId?: number
): LivenessReporter {
  // LIVE-01: Continuous typing indicator
  const typingInterval = setInterval(() => {
    bot.api
      .sendChatAction(chatId, "typing", {
        message_thread_id: messageThreadId,
      })
      .catch(() => {}); // Silently ignore errors (chat may be unavailable)
  }, TYPING_INTERVAL_MS);

  // PROG-01 + PROG-02: Throttled progress messages
  let statusMessageId: number | null = null;
  let lastProgressAt = 0;
  let pendingTools: string[] = [];
  let sendingProgress = false; // Guard against overlapping sends

  const sendOrUpdateProgress = async (toolNames: string[]) => {
    if (sendingProgress) {
      pendingTools.push(...toolNames);
      return;
    }

    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_THROTTLE_MS) {
      pendingTools.push(...toolNames);
      return;
    }

    sendingProgress = true;
    const allTools = [...pendingTools, ...toolNames];
    pendingTools = [];
    lastProgressAt = now;

    // Deduplicate tool names while preserving order
    const unique = [...new Set(allTools)];
    const display = unique.map(formatToolName).join(", ");
    const text = `🔄 ${display}...`;

    try {
      if (statusMessageId) {
        await bot.api.editMessageText(chatId, statusMessageId, text);
      } else {
        const msg = await bot.api.sendMessage(chatId, text, {
          message_thread_id: messageThreadId,
        });
        statusMessageId = msg.message_id;
      }
    } catch {
      // Edit/send failed (message deleted, chat unavailable) — ignore
    } finally {
      sendingProgress = false;
    }
  };

  const onStreamEvent = (event: any) => {
    // Detect tool_use blocks in assistant events
    if (event.type === "assistant" && event.message?.content) {
      const toolNames: string[] = [];
      for (const block of event.message.content) {
        if (block.type === "tool_use" && block.name) {
          toolNames.push(block.name);
        }
      }
      if (toolNames.length > 0) {
        sendOrUpdateProgress(toolNames); // Fire-and-forget (async but not awaited)
      }
    }
  };

  // LIVE-02: Cleanup stops all indicators
  const cleanup = async () => {
    clearInterval(typingInterval);
    if (statusMessageId) {
      try {
        await bot.api.deleteMessage(chatId, statusMessageId);
      } catch {
        // Message already deleted or chat unavailable — ignore
      }
    }
  };

  return { onStreamEvent, cleanup };
}
```

**Design notes:**
- `createLivenessReporter()` takes `chatId` and optional `messageThreadId` (for group topics). Does NOT take a grammy context — only the raw IDs it needs, keeping it decoupled.
- Uses `bot.api` directly (the global bot instance) for sending typing actions and progress messages.
- `onStreamEvent` is synchronous — it fires `sendOrUpdateProgress()` as fire-and-forget. The `sendingProgress` guard prevents overlapping API calls.
- Status message is sent once, then edited. On cleanup, it's deleted so only the final response appears.
- Tool names are deduplicated within each progress window to avoid "Reading file, Reading file, Reading file" when Claude reads multiple files rapidly.

**Requirements covered:** LIVE-01, LIVE-02, PROG-01, PROG-02
  </action>
  <verify>
1. grep for "TOOL_DISPLAY_NAMES" in relay.ts — should exist as a Record
2. grep for "createLivenessReporter" in relay.ts — should find the function definition
3. grep for "TYPING_INTERVAL_MS" in relay.ts — should be 4_000
4. grep for "PROGRESS_THROTTLE_MS" in relay.ts — should be 15_000
5. grep for "formatToolName" in relay.ts — should find the helper
6. grep for "sendChatAction.*typing" in relay.ts — should find it inside the interval
7. grep for "editMessageText" in relay.ts — should find it in sendOrUpdateProgress
8. grep for "deleteMessage" in relay.ts — should find it in cleanup
9. `bun run start` boots without errors (Ctrl+C to stop)
  </verify>
  <done>
Liveness reporter system created: typing interval (4s), throttled progress messages (15s), editable status message with cleanup on completion. Tool name mapping for 12 common tools.
  </done>
</task>

<task type="auto">
  <name>Task 3: Wire up all 4 message handlers with liveness reporter</name>
  <files>src/relay.ts</files>
  <action>
Update the text, voice, photo, and document handlers to use `createLivenessReporter()` instead of the single `replyWithChatAction("typing")` call. Each handler gets a try/finally pattern to ensure cleanup runs even on errors.

**Handler 1: Text messages** (around line 2178)

Find:
```typescript
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 80)}...`);

  await ctx.replyWithChatAction("typing");

  const enrichedPrompt = await buildPrompt(text, ctx.threadInfo);
  const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
```

Replace with:
```typescript
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 80)}...`);

  const liveness = createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id);
  try {
  await ctx.replyWithChatAction("typing");

  const enrichedPrompt = await buildPrompt(text, ctx.threadInfo);
  const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo, liveness.onStreamEvent);
```

Then find the CLOSING of the text handler — the `});` after the last `await sendResponse(ctx, cleanResponse);` in the text handler block:

Find:
```typescript
  await sendResponse(ctx, cleanResponse);
});
```

Replace with:
```typescript
  await sendResponse(ctx, cleanResponse);
  } finally {
    await liveness.cleanup();
  }
});
```

**Handler 2: Voice messages** (around line 2218)

Find:
```typescript
bot.on("message:voice", async (ctx) => {
  console.log("Voice message received");
  await ctx.replyWithChatAction("typing");

  try {
```

Replace with:
```typescript
bot.on("message:voice", async (ctx) => {
  console.log("Voice message received");
  const liveness = createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id);
  await ctx.replyWithChatAction("typing");

  try {
```

Find the callClaude line in the voice handler:
```typescript
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
```
(This is the one after `const enrichedPrompt = await buildPrompt(transcription, ctx.threadInfo);`)

Replace with:
```typescript
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo, liveness.onStreamEvent);
```

Find the catch/close of the voice handler:
```typescript
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message.");
  }
});
```

Replace with:
```typescript
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message.");
  } finally {
    await liveness.cleanup();
  }
});
```

**Handler 3: Photo messages** (around line 2269)

Find:
```typescript
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
```

Replace with:
```typescript
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  const liveness = createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id);
  await ctx.replyWithChatAction("typing");

  try {
```

Find the callClaude line in the photo handler:
```typescript
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
```
(This is the one after `const enrichedPrompt = await buildPrompt(...)` in the photo handler)

Replace with:
```typescript
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo, liveness.onStreamEvent);
```

Find the catch/close of the photo handler:
```typescript
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});
```

Replace with:
```typescript
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  } finally {
    await liveness.cleanup();
  }
});
```

**Handler 4: Document messages** (around line 2310)

Find:
```typescript
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
```

Replace with:
```typescript
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  const liveness = createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id);
  await ctx.replyWithChatAction("typing");

  try {
```

Find the callClaude line in the document handler:
```typescript
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
```
(This is the one after `const enrichedPrompt = await buildPrompt(...)` in the document handler)

Replace with:
```typescript
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo, liveness.onStreamEvent);
```

Find the catch/close of the document handler:
```typescript
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});
```

Replace with:
```typescript
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  } finally {
    await liveness.cleanup();
  }
});
```

**Key patterns in all handlers:**
1. `createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id)` — created before any async work
2. `ctx.replyWithChatAction("typing")` — kept as the initial immediate typing action (liveness interval takes over after 4s)
3. `callClaude(..., liveness.onStreamEvent)` — passes the event callback
4. `finally { await liveness.cleanup(); }` — always runs: clears interval, deletes status message

**Note:** The voice, photo, and document handlers already have try/catch blocks. The `finally` is added alongside the existing `catch`. The text handler needs a new try/finally wrapper since it didn't have one.

**Requirements covered:** LIVE-01, LIVE-02, PROG-01, PROG-02 (all wired up)
  </action>
  <verify>
1. grep for "createLivenessReporter" in relay.ts — should appear 4 times (one per handler) plus the function definition
2. grep for "liveness.onStreamEvent" in relay.ts — should appear 4 times (one per callClaude call in handlers)
3. grep for "liveness.cleanup" in relay.ts — should appear 4 times (one per finally block)
4. grep for "finally" in relay.ts within the handler section — should appear 4 times for the 4 handlers
5. Verify heartbeat callClaude (line ~989) and cron callClaude (line ~830) do NOT pass onStreamEvent (unchanged)
6. `bun run start` boots without errors (Ctrl+C to stop)
  </verify>
  <done>
All 4 message handlers wired with liveness reporter. Typing indicators run continuously during Claude work, progress messages show tool usage in real-time, cleanup always runs via finally blocks.
  </done>
</task>

<task type="auto">
  <name>Task 4: Update CLAUDE.md and STATE.md documentation</name>
  <files>CLAUDE.md, .planning/STATE.md</files>
  <action>
**CLAUDE.md changes:**

1. Update the callClaude() description to mention onStreamEvent, AND add a new liveness reporter bullet after it. In CLAUDE.md line 77, the callClaude description:

Find:
```
- **callClaude()** — Spawns `claude -p "<prompt>" --resume <sessionId> --output-format stream-json --verbose --dangerously-skip-permissions`. Parses NDJSON events line-by-line: session ID from `system/init`, result text from `result` event. Resets inactivity timer on every stream event. Auto-retries without `--resume` if session is expired/corrupt. 15-minute inactivity timeout.
- **Heartbeat timer**
```

Replace with:
```
- **callClaude()** — Spawns `claude -p "<prompt>" --resume <sessionId> --output-format stream-json --verbose --dangerously-skip-permissions`. Parses NDJSON events line-by-line: session ID from `system/init`, result text from `result` event. Resets inactivity timer on every stream event. Optional `onStreamEvent` callback fires for each parsed event (used by liveness reporter). Auto-retries without `--resume` if session is expired/corrupt. 15-minute inactivity timeout.
- **Liveness reporter** — `createLivenessReporter()` provides continuous typing indicators (every 4s) and throttled progress messages (tool names every 15s) during Claude work. Used by all 4 message handlers. Status message is edited in-place and deleted on completion.
- **Heartbeat timer**
```

Note: The find includes the start of the next bullet (`- **Heartbeat timer**`) to anchor the match uniquely. The replacement adds the new liveness bullet between callClaude and Heartbeat timer.

2. Update the STATE.md "Typing action" line to reflect the new system:

In STATE.md line 59:

Find:
```
- Typing action: sent once per handler at lines ~2113, ~2151, ~2202, ~2244
```

Replace with:
```
- Liveness reporter: `createLivenessReporter()` — typing indicators every 4s + throttled progress messages every 15s
```

**STATE.md changes:**

Update the current position and phase table:

Find:
```
Phase: 13 - Liveness & Progress
Plan: Not yet created
Status: Pending (needs /gsd:plan-phase 13)
```

Replace with:
```
Phase: 13 - Liveness & Progress
Plan: .planning/phases/13-liveness-progress/PLAN.md
Status: Planned (ready for /gsd:execute-phase 13)
```

Update the phase table row for Phase 13:

Find:
```
| 13 | Liveness & Progress | — | — | — | Pending |
```

Replace with:
```
| 13 | Liveness & Progress | — | 4 | 2 | Planned |
```

Update the next action:

Find:
```
**Next action:** Run `/gsd:plan-phase 13` to create execution plan for Liveness & Progress phase
```

Replace with:
```
**Next action:** Run `/gsd:execute-phase 13` to implement liveness indicators and progress messages
```

**Requirements covered:** Documentation
  </action>
  <verify>
1. grep for "createLivenessReporter" in CLAUDE.md — should find it in the description
2. grep for "onStreamEvent" in CLAUDE.md — should find it in the callClaude description
3. grep for "Planned" in STATE.md — should find Phase 13 status
4. grep for "execute-phase 13" in STATE.md — should find the next action
  </verify>
  <done>
CLAUDE.md updated with liveness reporter documentation. STATE.md updated to reflect Phase 13 is planned and ready for execution.
  </done>
</task>

</tasks>

<verification>
1. `callClaude()` signature includes optional `onStreamEvent` callback (third parameter)
2. `onStreamEvent` is called for every parsed NDJSON event inside the stdout parsing loop
3. `createLivenessReporter()` exists and returns `{ onStreamEvent, cleanup }`
4. Typing indicator interval fires every 4 seconds via `sendChatAction("typing")` (LIVE-01)
5. Typing interval is cleared in `cleanup()` function (LIVE-02)
6. Tool names are extracted from `assistant` events with `tool_use` content blocks (PROG-01)
7. Progress messages are throttled to max 1 per 15 seconds via `PROGRESS_THROTTLE_MS` (PROG-02)
8. Rapid tool calls are collapsed — `pendingTools` array accumulates between throttle windows
9. Status message is sent once, edited on updates, deleted on cleanup (clean UX)
10. Tool names mapped via `TOOL_DISPLAY_NAMES` (12 tools mapped, fallback to raw name)
11. All 4 message handlers create a liveness reporter and pass `onStreamEvent` to `callClaude()`
12. All 4 handlers have `finally { await liveness.cleanup(); }` blocks
13. Heartbeat and cron callers work unchanged (they don't pass `onStreamEvent`)
14. `bun run start` boots without errors
15. CLAUDE.md documents the liveness reporter and onStreamEvent callback
</verification>

<success_criteria>
- When a user sends a text/voice/photo/document message, the Telegram chat shows continuous "typing..." indicator
- During tool use (file reads, command execution, web search, etc.), a status message appears: "🔄 Reading file..."
- If Claude uses multiple tools rapidly, they're collapsed: "🔄 Reading file, Running command..."
- Status message updates at most once per 15 seconds (no spam)
- When Claude finishes, the status message is deleted and the actual response is sent
- Heartbeat and cron responses work exactly as before (no liveness indicators — they're background)
- Long-running tasks (subagents, deep research) keep showing "typing..." for the full duration
</success_criteria>

<output>
After completion, create `.planning/phases/13-liveness-progress/13-liveness-progress-SUMMARY.md`
</output>
