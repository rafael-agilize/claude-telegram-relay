# PLAN.md — Phase 7: Heartbeat Core

**Goal:** Periodic agent loop running with basic suppression logic.

**Requirements:** HB-01, HB-02, HB-03, HB-06
**Depends on:** Phase 6 (schema + lifecycle integration — complete)

**Key insight:** Phase 6 already wired the heartbeat timer skeleton (`heartbeatTick()`, `startHeartbeat()`, `stopHeartbeat()`) and the Supabase helpers (`getHeartbeatConfig()`). Phase 7 fills in the actual logic: read HEARTBEAT.md, call Claude, handle HEARTBEAT_OK suppression, deduplicate identical messages, and deliver to Telegram. Each heartbeat is a standalone Claude call (no `--resume`) — Phase 8 will add the dedicated thread with session persistence.

---

## Prompt 1: Heartbeat helper functions

**File:** `src/relay.ts`
**What:** Add helper functions for the heartbeat flow: reading HEARTBEAT.md, building the heartbeat prompt, checking for duplicate messages, and sending to Telegram. Place these after the `stopHeartbeat()` function (around line 583). Also add a `heartbeatRunning` guard flag to prevent overlapping heartbeat calls.

### Changes:

Add after `stopHeartbeat()` and before `async function processIntents(...)`:

```typescript
// Guard: prevent overlapping heartbeat calls
let heartbeatRunning = false;

async function readHeartbeatChecklist(): Promise<string> {
  if (!PROJECT_DIR) return "";
  try {
    const heartbeatPath = join(PROJECT_DIR, "HEARTBEAT.md");
    return await readFile(heartbeatPath, "utf-8");
  } catch {
    return "";
  }
}

async function buildHeartbeatPrompt(checklist: string): Promise<string> {
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

  const soul = await getActiveSoul();
  const globalMemory = await getGlobalMemory();

  let prompt = `${soul}\n\nCurrent time: ${timeStr}`;

  if (globalMemory.length > 0) {
    prompt += "\n\nTHINGS I KNOW ABOUT THE USER:\n";
    prompt += globalMemory.map((m) => `- ${m}`).join("\n");
  }

  if (checklist) {
    prompt += `\n\nHEARTBEAT CHECKLIST:\n${checklist}`;
  }

  prompt += `

HEARTBEAT INSTRUCTIONS:
You are performing a periodic check-in. Review the checklist above and check on the items listed.

If everything is fine and there's nothing noteworthy to report, respond with ONLY:
HEARTBEAT_OK

If there IS something worth reporting (something changed, something needs attention, a reminder is due, etc.), write a concise message to the user about what you found. Keep it brief and actionable.

You may use these tags in your response:
[LEARN: concise fact about the user] — save a fact (under 15 words)
[FORGET: search text matching the fact to remove] — remove a previously learned fact

Do NOT use [VOICE_REPLY] in heartbeat responses.`;

  return prompt.trim();
}

async function isHeartbeatDuplicate(message: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("logs_v2")
      .select("metadata")
      .eq("event", "heartbeat_delivered")
      .gte("created_at", twentyFourHoursAgo)
      .order("created_at", { ascending: false })
      .limit(50);

    if (!data || data.length === 0) return false;

    const trimmedMessage = message.trim();
    return data.some(
      (row) => (row.metadata as Record<string, unknown>)?.message_text === trimmedMessage
    );
  } catch (e) {
    console.error("isHeartbeatDuplicate error:", e);
    return false;
  }
}

async function sendHeartbeatToTelegram(message: string): Promise<void> {
  const chatId = parseInt(ALLOWED_USER_ID);
  if (!chatId || isNaN(chatId)) {
    console.error("Heartbeat: cannot send — TELEGRAM_USER_ID not set or invalid");
    return;
  }

  const MAX_LENGTH = 4000;
  const html = markdownToTelegramHtml(message);

  const sendChunk = async (chunk: string) => {
    try {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
    } catch (err: any) {
      console.warn("Heartbeat HTML parse failed, falling back to plain text:", err.message);
      await bot.api.sendMessage(chatId, message.length <= MAX_LENGTH ? message : chunk);
    }
  };

  if (html.length <= MAX_LENGTH) {
    await sendChunk(html);
    return;
  }

  // Chunk long messages
  let remaining = html;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      await sendChunk(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;
    await sendChunk(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }
}
```

### Verification:
- `heartbeatRunning` boolean flag exists at module scope
- `readHeartbeatChecklist()` reads `HEARTBEAT.md` from `PROJECT_DIR`, returns empty string if file doesn't exist or `PROJECT_DIR` is unset
- `buildHeartbeatPrompt()` includes soul, global memory, checklist, and HEARTBEAT_OK instructions
- `isHeartbeatDuplicate()` queries `logs_v2` for `heartbeat_delivered` events in last 24h with matching `message_text` in metadata
- `sendHeartbeatToTelegram()` sends to user's DM using `bot.api.sendMessage()` with HTML formatting and chunking
- No new imports needed (uses existing `readFile`, `join`, `bot`, `supabase`, `markdownToTelegramHtml`)

---

## Prompt 2: Full heartbeatTick() implementation

**File:** `src/relay.ts`
**What:** Replace the Phase 6 skeleton `heartbeatTick()` with the full implementation that reads HEARTBEAT.md, calls Claude, handles HEARTBEAT_OK suppression, processes intents, deduplicates identical messages, and delivers to Telegram.

### Changes:

Find the existing `heartbeatTick()` function:

```typescript
async function heartbeatTick(): Promise<void> {
  try {
    const config = await getHeartbeatConfig();
    if (!config || !config.enabled) {
      console.log("Heartbeat: disabled or no config");
      return;
    }

    console.log("Heartbeat: tick");
    await logEventV2("heartbeat_tick", "Heartbeat timer fired", {
      interval_minutes: config.interval_minutes,
      enabled: config.enabled,
    });

    // Phase 7 will add: read HEARTBEAT.md, call Claude, handle HEARTBEAT_OK, send to Telegram
  } catch (e) {
    console.error("Heartbeat tick error:", e);
    await logEventV2("heartbeat_error", String(e).substring(0, 200));
  }
}
```

Replace with:

```typescript
async function heartbeatTick(): Promise<void> {
  if (heartbeatRunning) {
    console.log("Heartbeat: skipping (previous tick still running)");
    return;
  }

  heartbeatRunning = true;
  try {
    const config = await getHeartbeatConfig();
    if (!config || !config.enabled) {
      console.log("Heartbeat: disabled or no config");
      return;
    }

    console.log("Heartbeat: tick");
    await logEventV2("heartbeat_tick", "Heartbeat timer fired", {
      interval_minutes: config.interval_minutes,
    });

    // Step 1: Read HEARTBEAT.md checklist
    const checklist = await readHeartbeatChecklist();
    if (!checklist) {
      console.log("Heartbeat: no HEARTBEAT.md found, skipping");
      await logEventV2("heartbeat_skip", "No HEARTBEAT.md file found");
      return;
    }

    // Step 2: Build prompt and call Claude (standalone, no --resume)
    const prompt = await buildHeartbeatPrompt(checklist);
    const { text: rawResponse } = await callClaude(prompt);

    if (!rawResponse || rawResponse.startsWith("Error:")) {
      console.error("Heartbeat: Claude call failed:", rawResponse);
      await logEventV2("heartbeat_error", rawResponse?.substring(0, 200) || "Empty response");
      return;
    }

    // Step 3: Check for HEARTBEAT_OK — nothing to report
    if (rawResponse.trim() === "HEARTBEAT_OK" || rawResponse.includes("HEARTBEAT_OK")) {
      console.log("Heartbeat: HEARTBEAT_OK — nothing to report");
      await logEventV2("heartbeat_ok", "Claude reported nothing noteworthy");
      return;
    }

    // Step 4: Process intents ([LEARN:], [FORGET:])
    const cleanResponse = await processIntents(rawResponse);

    // Strip [VOICE_REPLY] tag if Claude included it despite instructions
    const finalMessage = cleanResponse.replace(/\[VOICE_REPLY\]/gi, "").trim();

    if (!finalMessage) {
      console.log("Heartbeat: empty after processing intents");
      return;
    }

    // Step 5: Check deduplication — suppress identical messages within 24h
    const isDuplicate = await isHeartbeatDuplicate(finalMessage);
    if (isDuplicate) {
      console.log("Heartbeat: duplicate message suppressed (seen in last 24h)");
      await logEventV2("heartbeat_dedup", "Duplicate message suppressed", {
        message_preview: finalMessage.substring(0, 100),
      });
      return;
    }

    // Step 6: Deliver to Telegram
    await sendHeartbeatToTelegram(finalMessage);
    console.log(`Heartbeat: delivered (${finalMessage.length} chars)`);
    await logEventV2("heartbeat_delivered", "Heartbeat message sent to user", {
      message_text: finalMessage.trim(),
      message_length: finalMessage.length,
    });
  } catch (e) {
    console.error("Heartbeat tick error:", e);
    await logEventV2("heartbeat_error", String(e).substring(0, 200));
  } finally {
    heartbeatRunning = false;
  }
}
```

### Verification:
- `heartbeatRunning` guard prevents overlapping heartbeat calls
- `finally` block always resets `heartbeatRunning` to `false`
- Reads HEARTBEAT.md; skips if file doesn't exist (with log)
- Calls Claude in standalone mode (no threadInfo, no --resume)
- Detects HEARTBEAT_OK (exact match OR contained in response) and suppresses delivery
- Processes intents ([LEARN:], [FORGET:]) so heartbeat can learn facts
- Strips [VOICE_REPLY] tag (heartbeat is text-only)
- Checks dedup before delivery — suppresses identical messages sent in last 24h
- Sends to Telegram via `sendHeartbeatToTelegram()`
- Logs each outcome distinctly: `heartbeat_tick`, `heartbeat_ok`, `heartbeat_dedup`, `heartbeat_delivered`, `heartbeat_error`, `heartbeat_skip`
- `heartbeat_delivered` events store `message_text` in metadata for dedup queries

---

## Prompt 3: Create default HEARTBEAT.md

**File:** `HEARTBEAT.md` (project root)
**What:** Create a default heartbeat checklist file that Claude reads on each heartbeat cycle. This file defines what the agent checks periodically.

### Changes:

Create new file `HEARTBEAT.md`:

```markdown
# Heartbeat Checklist

Check these items on each heartbeat cycle. Report anything noteworthy.
If everything is normal, respond with HEARTBEAT_OK.

## What to Check

- Check if there are any pending reminders or follow-ups I should know about
- Check the current time and whether any time-sensitive items need attention
- Look for any patterns in our recent conversations that suggest something I should be reminded about

## When to Report

Report when:
- A reminder or deadline is approaching
- Something changed that the user should know about
- You notice something that needs the user's attention

Stay silent (HEARTBEAT_OK) when:
- Everything is routine and nothing needs attention
- No deadlines or reminders are pending
- There's nothing actionable to communicate
```

### Verification:
- File exists at project root as `HEARTBEAT.md`
- Contains clear instructions for Claude about when to report vs suppress
- Includes example check items that work out of the box
- Is generic enough to be useful as a starting point (user will customize)

---

## Prompt 4: Update CLAUDE.md documentation

**File:** `CLAUDE.md`
**What:** Document the heartbeat core behavior: HEARTBEAT.md file, HEARTBEAT_OK suppression, dedup, and new event types.

### Changes:

1. **Add HEARTBEAT.md to the Architecture section** — find the `**Heartbeat timer**` bullet and replace it:

   Find:
   ```
   - **Heartbeat timer** — `heartbeatTick()` fires at configurable interval (default 60min), reads config from Supabase, logs events. Starts on boot via `onStart`, stops on SIGINT/SIGTERM.
   ```

   Replace with:
   ```
   - **Heartbeat timer** — `heartbeatTick()` fires at configurable interval (default 60min), reads `HEARTBEAT.md` checklist, calls Claude, handles suppression (HEARTBEAT_OK + dedup), delivers to Telegram DM. Starts on boot via `onStart`, stops on SIGINT/SIGTERM.
   ```

2. **Add HEARTBEAT.md to the bot commands section** — after the `/memory` command line, add:

   Find:
   ```
   - `/memory` — Show all learned facts about the user
   ```

   After this line, add:
   ```

   **Heartbeat:**
   - `HEARTBEAT.md` — Checklist file in project root; Claude reads it on each heartbeat cycle and reports noteworthy items
   - `HEARTBEAT_OK` — When Claude responds with this token, the heartbeat message is suppressed (nothing to report)
   ```

3. **Update heartbeat event types** — find the heartbeat events line and update:

   Find:
   ```
   - **Heartbeat & cron events** — Logged to `logs_v2` with event types: `heartbeat_tick`, `heartbeat_error`, `cron_executed`, `cron_error`, `bot_stopping`
   ```

   Replace with:
   ```
   - **Heartbeat & cron events** — Logged to `logs_v2` with event types: `heartbeat_tick`, `heartbeat_ok`, `heartbeat_delivered`, `heartbeat_dedup`, `heartbeat_skip`, `heartbeat_error`, `cron_executed`, `cron_error`, `bot_stopping`
   ```

### Verification:
- CLAUDE.md describes HEARTBEAT.md file and its role
- HEARTBEAT_OK suppression behavior documented
- Dedup behavior mentioned in heartbeat timer description
- Event types list includes all new Phase 7 event types
- No incorrect references to Phase 6 skeleton behavior remain

---

## Execution Order

1. **Prompt 1** → Helper functions (readHeartbeatChecklist, buildHeartbeatPrompt, isHeartbeatDuplicate, sendHeartbeatToTelegram)
2. **Prompt 2** → Replace heartbeatTick() skeleton (depends on Prompt 1 — uses all helpers)
3. **Prompt 3** → Create HEARTBEAT.md file (independent, parallelize with Prompt 1)
4. **Prompt 4** → Update CLAUDE.md documentation (independent, parallelize with Prompt 2)

Parallelizable groups:
- **Wave 1**: Prompts 1, 3 (TypeScript helpers + HEARTBEAT.md file — independent)
- **Wave 2**: Prompts 2, 4 (heartbeatTick depends on Prompt 1; docs independent)

## Files Modified

| File | Changes |
|------|---------|
| `src/relay.ts` | Add heartbeat helpers (readHeartbeatChecklist, buildHeartbeatPrompt, isHeartbeatDuplicate, sendHeartbeatToTelegram), replace heartbeatTick() skeleton with full implementation |
| `HEARTBEAT.md` | New file: default heartbeat checklist for Claude to read on each cycle |
| `CLAUDE.md` | Updated heartbeat docs: HEARTBEAT.md role, HEARTBEAT_OK suppression, dedup, event types |

## Roadmap Requirement Coverage

| Requirement | Prompt | How |
|-------------|--------|-----|
| HB-01: Periodic heartbeat loop at configurable interval | Prompt 2 | heartbeatTick() runs on interval from Phase 6 timer, now calls Claude |
| HB-02: Reads HEARTBEAT.md as checklist | Prompts 1, 2, 3 | readHeartbeatChecklist() reads file, buildHeartbeatPrompt() includes contents, HEARTBEAT.md created |
| HB-03: HEARTBEAT_OK token suppresses message delivery | Prompt 2 | heartbeatTick() checks for HEARTBEAT_OK in Claude response, skips Telegram delivery |
| HB-06: Identical messages deduplicated within 24h | Prompts 1, 2 | isHeartbeatDuplicate() queries logs_v2, heartbeatTick() suppresses delivery if duplicate found |

## Risk Assessment

- **No risk**: HEARTBEAT.md is a new file, no existing behavior changes
- **Low risk**: New helper functions are additive, placed before processIntents()
- **Low risk**: heartbeatTick() replacement is a targeted swap — no other code references the old skeleton
- **Low risk**: sendHeartbeatToTelegram() uses existing bot.api — same Grammy API used by message handlers
- **Concurrency guard**: `heartbeatRunning` flag prevents stacked calls if Claude takes longer than interval
- **Graceful degradation**: Missing HEARTBEAT.md → heartbeat skips silently; Supabase down → dedup fails open (delivers rather than suppresses)
- **Rollback**: Revert relay.ts from git, delete HEARTBEAT.md, revert CLAUDE.md
