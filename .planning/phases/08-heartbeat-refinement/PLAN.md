# PLAN.md — Phase 8: Heartbeat Refinement

**Goal:** Heartbeat respects user preferences for timing and thread routing.

**Requirements:** HB-04, HB-05, HB-07
**Depends on:** Phase 7 (heartbeat core — complete)

**Key insight:** Phase 7 delivered the full heartbeat loop (read HEARTBEAT.md, call Claude, suppress via HEARTBEAT_OK, dedup, deliver). Phase 8 adds two gates and a routing change: (1) active hours check so the bot doesn't ping at night, (2) dedicated "Heartbeat" forum topic in the Telegram group so proactive messages don't clutter conversation threads, and (3) dynamic config pickup so Supabase changes take effect on the next cycle without restart. The `heartbeat_config` table already has `active_hours_start`, `active_hours_end`, `timezone`, and `enabled` fields from Phase 6 — Phase 8 makes them operational.

---

## Prompt 1: Active hours gating

**File:** `src/relay.ts`
**What:** Add `isWithinActiveHours()` helper function and integrate it into `heartbeatTick()` so heartbeat skips when outside the configured time window. Add a new env var `TELEGRAM_GROUP_ID` for dedicated thread routing (used in Prompt 2).

### Changes:

1. **Add `TELEGRAM_GROUP_ID` to the configuration block** — find the ElevenLabs config lines and add after them:

```typescript
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID || "";
```

2. **Add `isWithinActiveHours()` function** — place it after `readHeartbeatChecklist()` (around line 655), before `buildHeartbeatPrompt()`:

```typescript
function isWithinActiveHours(config: HeartbeatConfig): boolean {
  const tz = config.timezone || "America/Sao_Paulo";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0");
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0");
  const currentMinutes = hour * 60 + minute;

  const [startH, startM] = (config.active_hours_start || "08:00").split(":").map(Number);
  const [endH, endM] = (config.active_hours_end || "22:00").split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Overnight range (e.g., 22:00-06:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}
```

3. **Integrate active hours check into `heartbeatTick()`** — after the `config.enabled` check (around line 556), add:

Find:
```typescript
    console.log("Heartbeat: tick");
    await logEventV2("heartbeat_tick", "Heartbeat timer fired", {
      interval_minutes: config.interval_minutes,
    });
```

Replace with:
```typescript
    // Check active hours before proceeding
    if (!isWithinActiveHours(config)) {
      console.log(`Heartbeat: outside active hours (${config.active_hours_start}-${config.active_hours_end} ${config.timezone})`);
      await logEventV2("heartbeat_skip", "Outside active hours", {
        active_hours_start: config.active_hours_start,
        active_hours_end: config.active_hours_end,
        timezone: config.timezone,
      });
      return;
    }

    console.log("Heartbeat: tick");
    await logEventV2("heartbeat_tick", "Heartbeat timer fired", {
      interval_minutes: config.interval_minutes,
    });
```

### Verification:
- `isWithinActiveHours()` uses `Intl.DateTimeFormat` for timezone-aware time comparison
- Handles both normal ranges (08:00-22:00) and overnight ranges (22:00-06:00)
- Defaults to "America/Sao_Paulo" timezone and 08:00-22:00 window if config values are missing
- `heartbeatTick()` skips with `heartbeat_skip` log event when outside active hours
- Active hours check happens BEFORE the Claude call (no wasted API calls)
- `TELEGRAM_GROUP_ID` env var added for Prompt 2

---

## Prompt 2: Dedicated heartbeat thread

**File:** `src/relay.ts`
**What:** Add `getOrCreateHeartbeatTopic()` function that finds or creates a "Heartbeat" forum topic in the Telegram group. Modify `sendHeartbeatToTelegram()` to route messages to this topic instead of user DM. Falls back to DM if no group is configured or topic creation fails.

### Changes:

1. **Add module-level cache** — after `let heartbeatRunning = false;` (around line 645), add:

```typescript
// Cache for heartbeat topic thread ID (persisted in Supabase threads table)
let heartbeatTopicId: number | null = null;
```

2. **Add `getOrCreateHeartbeatTopic()` function** — place it after `isWithinActiveHours()`, before `buildHeartbeatPrompt()`:

```typescript
async function getOrCreateHeartbeatTopic(): Promise<{ chatId: number; threadId: number } | null> {
  if (!TELEGRAM_GROUP_ID) return null;

  const chatId = parseInt(TELEGRAM_GROUP_ID);
  if (isNaN(chatId)) return null;

  // Return cached value
  if (heartbeatTopicId) return { chatId, threadId: heartbeatTopicId };

  // Check Supabase for existing heartbeat thread
  if (supabase) {
    try {
      const { data } = await supabase
        .from("threads")
        .select("telegram_thread_id")
        .eq("telegram_chat_id", chatId)
        .eq("title", "Heartbeat")
        .not("telegram_thread_id", "is", null)
        .limit(1)
        .single();

      if (data?.telegram_thread_id) {
        heartbeatTopicId = data.telegram_thread_id;
        return { chatId, threadId: heartbeatTopicId };
      }
    } catch {
      // No existing thread found — will create one
    }
  }

  // Create new forum topic
  try {
    const topic = await bot.api.createForumTopic(chatId, "Heartbeat");
    heartbeatTopicId = topic.message_thread_id;

    // Persist in Supabase threads table
    await getOrCreateThread(chatId, heartbeatTopicId, "Heartbeat");

    console.log(`Heartbeat: created forum topic (thread_id: ${heartbeatTopicId})`);
    return { chatId, threadId: heartbeatTopicId };
  } catch (e) {
    console.error("Failed to create heartbeat topic:", e);
    return null; // Fall back to DM
  }
}
```

3. **Replace `sendHeartbeatToTelegram()` function** — find the entire existing function and replace:

Find:
```typescript
async function sendHeartbeatToTelegram(message: string): Promise<void> {
  const chatId = parseInt(ALLOWED_USER_ID);
  if (!chatId || isNaN(chatId)) {
    console.error("Heartbeat: cannot send — TELEGRAM_USER_ID not set or invalid");
    return;
  }
```

Replace with:
```typescript
async function sendHeartbeatToTelegram(message: string): Promise<void> {
  // Try dedicated topic thread first, fall back to DM
  const topic = await getOrCreateHeartbeatTopic();

  const chatId = topic?.chatId || parseInt(ALLOWED_USER_ID);
  const threadId = topic?.threadId;
  if (!chatId || isNaN(chatId)) {
    console.error("Heartbeat: cannot send — no valid chat ID");
    return;
  }
```

4. **Update the `sendChunk` lambda inside `sendHeartbeatToTelegram()`** to pass `message_thread_id`:

Find:
```typescript
  const sendChunk = async (chunk: string) => {
    try {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
    } catch (err: any) {
      console.warn("Heartbeat HTML parse failed, falling back to plain text:", err.message);
      await bot.api.sendMessage(chatId, message.length <= MAX_LENGTH ? message : chunk);
    }
  };
```

Replace with:
```typescript
  const sendChunk = async (chunk: string) => {
    try {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        message_thread_id: threadId,
      });
    } catch (err: any) {
      if (threadId && err.message?.includes("thread not found")) {
        // Topic was deleted — reset cache, re-send same HTML chunk to DM
        heartbeatTopicId = null;
        console.warn("Heartbeat topic was deleted, falling back to DM");
        try {
          await bot.api.sendMessage(parseInt(ALLOWED_USER_ID), chunk, { parse_mode: "HTML" });
        } catch {
          await bot.api.sendMessage(parseInt(ALLOWED_USER_ID), chunk.replace(/<[^>]+>/g, ""));
        }
        return;
      }
      // HTML parse failure — send as plain text (strip tags from HTML chunk)
      console.warn("Heartbeat HTML parse failed, falling back to plain text:", err.message);
      await bot.api.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ""), {
        message_thread_id: threadId,
      });
    }
  };
```

5. **Add startup log for heartbeat routing** — in the bot startup section (around line 1631), find:

```typescript
console.log(`Heartbeat: ${supabase ? "will start after boot" : "disabled (no Supabase)"}`);
```

Replace with:
```typescript
console.log(`Heartbeat: ${supabase ? "will start after boot" : "disabled (no Supabase)"}`);
console.log(`Heartbeat routing: ${TELEGRAM_GROUP_ID ? `group ${TELEGRAM_GROUP_ID} (topic thread)` : "DM (no TELEGRAM_GROUP_ID)"}`);
```

### Verification:
- `getOrCreateHeartbeatTopic()` returns null when `TELEGRAM_GROUP_ID` is not set (DM fallback)
- Checks Supabase threads table first for existing "Heartbeat" thread (avoids recreating on restart)
- Creates forum topic via `bot.api.createForumTopic()` and persists to Supabase
- Module-level cache `heartbeatTopicId` prevents Supabase lookup on every tick
- `sendHeartbeatToTelegram()` routes to topic thread when available, DM otherwise
- If topic was deleted by user, cache resets and HTML chunk is re-sent to DM with `parse_mode: "HTML"`
- If HTML parse also fails at DM, strips tags and sends as plain text (double fallback)
- sendChunk parse-failure branch strips HTML tags via `chunk.replace(/<[^>]+>/g, "")` for clean plain text
- `message_thread_id` is passed as `undefined` (not null) when no topic — Grammy ignores undefined optional params
- Startup log clearly shows heartbeat routing target (group ID or DM) for easy diagnostics
- No new imports needed (uses existing `bot`, `supabase`, `getOrCreateThread`)
- Bot needs admin rights + `can_manage_topics` in the group for topic creation to succeed; fails gracefully to DM if not

---

## Prompt 3: Update CLAUDE.md documentation

**File:** `CLAUDE.md`
**What:** Document new Phase 8 features: active hours, dedicated thread, TELEGRAM_GROUP_ID env var.

### Changes:

1. **Update heartbeat timer description** — find the existing heartbeat timer bullet:

Find:
```
- **Heartbeat timer** — `heartbeatTick()` fires at configurable interval (default 60min), reads `HEARTBEAT.md` checklist, calls Claude, handles suppression (HEARTBEAT_OK + dedup), delivers to Telegram DM. Starts on boot via `onStart`, stops on SIGINT/SIGTERM.
```

Replace with:
```
- **Heartbeat timer** — `heartbeatTick()` fires at configurable interval (default 60min), checks active hours window (timezone-aware), reads `HEARTBEAT.md` checklist, calls Claude, handles suppression (HEARTBEAT_OK + dedup), delivers to dedicated "Heartbeat" topic thread (falls back to DM). Starts on boot via `onStart`, stops on SIGINT/SIGTERM.
```

2. **Add TELEGRAM_GROUP_ID to Environment Variables** — find the Supabase section and add before it:

Find:
```
Supabase:
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (or `SUPABASE_ANON_KEY`)
```

Replace with:
```
Telegram group (heartbeat thread routing):
- `TELEGRAM_GROUP_ID` — numeric ID of the supergroup where heartbeat topic will be created (optional, falls back to DM)

Supabase:
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (or `SUPABASE_ANON_KEY`)
```

3. **Update heartbeat event types** — find the heartbeat events line and add `heartbeat_skip` context:

The existing line already lists `heartbeat_skip`. No change needed — just verify it covers the active hours skip case.

4. **Add active hours to the Heartbeat section** — find the Heartbeat subsection in bot commands:

Find:
```
**Heartbeat:**
- `HEARTBEAT.md` — Checklist file in project root; Claude reads it on each heartbeat cycle and reports noteworthy items
- `HEARTBEAT_OK` — When Claude responds with this token, the heartbeat message is suppressed (nothing to report)
```

Replace with:
```
**Heartbeat:**
- `HEARTBEAT.md` — Checklist file in project root; Claude reads it on each heartbeat cycle and reports noteworthy items
- `HEARTBEAT_OK` — When Claude responds with this token, the heartbeat message is suppressed (nothing to report)
- Active hours: heartbeat only runs during configured window (default 08:00-22:00, timezone-aware)
- Dedicated thread: heartbeat messages go to a "Heartbeat" forum topic in the group (auto-created)
```

### Verification:
- Heartbeat timer description updated with active hours and dedicated thread
- `TELEGRAM_GROUP_ID` env var documented with fallback behavior
- Active hours and dedicated thread mentioned in Heartbeat bot commands section
- No incorrect references to DM-only delivery remain

---

## Execution Order

1. **Prompt 1** → Active hours helper + env var + heartbeatTick integration
2. **Prompt 2** → Dedicated heartbeat thread (getOrCreateHeartbeatTopic + sendHeartbeatToTelegram changes)
3. **Prompt 3** → CLAUDE.md documentation updates

Parallelizable groups:
- **Wave 1**: Prompt 1 (active hours gating — independent)
- **Wave 2**: Prompts 2, 3 (dedicated thread depends on TELEGRAM_GROUP_ID from Prompt 1; docs independent but should reflect final state)

## Files Modified

| File | Changes |
|------|---------|
| `src/relay.ts` | Add `TELEGRAM_GROUP_ID` env var, `isWithinActiveHours()`, `getOrCreateHeartbeatTopic()`, active hours check in heartbeatTick(), dedicated thread routing in sendHeartbeatToTelegram() |
| `CLAUDE.md` | Updated heartbeat docs: active hours, dedicated thread, TELEGRAM_GROUP_ID env var |

## Roadmap Requirement Coverage

| Requirement | Prompt | How |
|-------------|--------|-----|
| HB-04: Active hours window (timezone-aware, default 08:00-22:00) | Prompt 1 | `isWithinActiveHours()` checks config timezone/hours, heartbeatTick() skips when outside window |
| HB-05: Dedicated "Heartbeat" topic thread in Telegram group | Prompt 2 | `getOrCreateHeartbeatTopic()` creates forum topic via Grammy API, `sendHeartbeatToTelegram()` routes there |
| HB-07: Heartbeat config stored in Supabase (picked up on next cycle) | Prompts 1, 2 | Config re-read on each tick (Phase 6 already stores it); active hours + enabled changes take effect immediately on next cycle |

## Risk Assessment

- **No risk**: `isWithinActiveHours()` is a pure function with no side effects
- **Low risk**: Active hours check is additive — added before Claude call, no existing logic changed
- **Low risk**: `getOrCreateHeartbeatTopic()` is new code, isolated from message handlers
- **Medium risk**: `sendHeartbeatToTelegram()` is being modified — but changes are at the top (chat ID selection) and in sendChunk (thread_id param). Chunking logic untouched.
- **Fallback safety**: If `TELEGRAM_GROUP_ID` is not set, behavior is identical to Phase 7 (DM delivery)
- **Fallback safety**: If topic creation fails (bot not admin), falls back to DM
- **Fallback safety**: If topic was deleted, cache resets and message goes to DM
- **Grammy dependency**: `createForumTopic` requires bot to be admin with `can_manage_topics` right in the group
- **Rollback**: Revert relay.ts + CLAUDE.md from git; remove `TELEGRAM_GROUP_ID` from .env
