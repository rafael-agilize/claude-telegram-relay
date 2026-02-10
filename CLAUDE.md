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
