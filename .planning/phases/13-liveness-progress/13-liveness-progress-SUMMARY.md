# Phase 13: Liveness & Progress — Summary

## What was delivered

Real-time Telegram feedback while Claude works on a request:
- **Typing indicators** — continuous `sendChatAction("typing")` every 4 seconds via `setInterval`
- **Progress messages** — throttled tool-use notifications (max 1 per 15s) showing what Claude is doing
- **Editable status message** — sent once, edited on updates, deleted when response arrives
- **Tool name mapping** — 12 common tools mapped to user-friendly descriptions (Read → "Reading file", Bash → "Running command", etc.)

## Architecture

```
Message Handler → createLivenessReporter(chatId, threadId)
  ├── Typing interval (4s) — sendChatAction("typing")
  └── onStreamEvent callback → passed to callClaude()
        ├── Detects assistant events with tool_use blocks
        ├── Extracts tool names → TOOL_DISPLAY_NAMES mapping
        └── sendOrUpdateProgress() — throttled, deduplicated
              ├── First call: sendMessage("🔄 Reading file...")
              ├── Subsequent: editMessageText("🔄 Reading file, Running command...")
              └── Cleanup: deleteMessage (status msg removed)
```

## Files modified

| File | Changes |
|------|---------|
| src/relay.ts | Added `createLivenessReporter()` factory, `onStreamEvent` callback to `callClaude()`, wired all 4 handlers |
| CLAUDE.md | Documented liveness reporter and onStreamEvent |
| .planning/STATE.md | Updated to reflect Phase 13 complete |

## Requirements covered

| Requirement | Implementation |
|-------------|---------------|
| LIVE-01 | Typing indicator interval (4s) in createLivenessReporter |
| LIVE-02 | cleanup() clears interval and deletes status message |
| PROG-01 | Tool names extracted from assistant events, mapped via TOOL_DISPLAY_NAMES |
| PROG-02 | PROGRESS_THROTTLE_MS (15s) with pendingTools accumulation |

## Key decisions

- Fire-and-forget pattern for progress messages (onStreamEvent is synchronous, sendOrUpdateProgress is async but not awaited)
- `sendingProgress` guard prevents overlapping Telegram API calls
- Heartbeat and cron callers unchanged — they don't pass onStreamEvent (no liveness for background tasks)
- Status message deleted on cleanup so only the final response appears in chat
