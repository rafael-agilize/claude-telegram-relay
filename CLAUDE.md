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
bun run setup          # Interactive guided setup
bun run setup:verify   # Verify all services are configured
bun run test:telegram  # Test Telegram bot connection
bun run test:supabase  # Test Supabase connection
bun run setup:launchd  # Configure macOS LaunchAgent daemon
bun run setup:services # Configure external services (Groq, ElevenLabs)
```

**Bot commands (in Telegram):**
- `/soul <text>` — Set the bot's personality (loaded into every prompt)
- `/new` — Reset the Claude session for the current thread (fresh conversation)
- `/memory` — Show all learned facts about the user
- `/cron list` — Show all scheduled cron jobs with status
- `/cron add "<schedule>" <prompt>` — Create a new cron job (schedule types: cron "0 7 * * *", interval "every 2h", one-shot "in 20m")
- `/cron remove <number>` — Remove a cron job by its list number
- `/cron enable <number>` / `/cron disable <number>` — Toggle a cron job on/off

**Heartbeat:**
- `HEARTBEAT.md` — Checklist file in project root; Claude reads it on each heartbeat cycle and reports noteworthy items. Can also contain a `## Cron Jobs` section to define cron jobs declaratively (synced to database on each heartbeat)
- `HEARTBEAT_OK` — When Claude responds with this token, the heartbeat message is suppressed (nothing to report)
- Active hours: heartbeat only runs during configured window (default 08:00-22:00, timezone-aware)
- Dedicated thread: heartbeat messages go to a "Heartbeat" forum topic in the group (auto-created)

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
- **Heartbeat & cron events** — Logged to `logs_v2` with event types: `heartbeat_tick`, `heartbeat_ok`, `heartbeat_delivered`, `heartbeat_dedup`, `heartbeat_skip`, `heartbeat_error`, `cron_created`, `cron_deleted`, `cron_executed`, `cron_delivered`, `cron_error`, `bot_stopping`
- **Thread routing middleware** — Extracts `message_thread_id`, creates/finds thread in Supabase, attaches `threadInfo` to context
- **callClaude()** — Spawns `claude -p "<prompt>" --resume <sessionId> --output-format json --dangerously-skip-permissions`. Parses JSON for response text and session ID. Auto-retries without `--resume` if session is expired/corrupt. 5-minute timeout.
- **Heartbeat timer** — `heartbeatTick()` fires at configurable interval (default 60min), checks active hours window (timezone-aware), reads `HEARTBEAT.md` checklist, calls Claude, handles suppression (HEARTBEAT_OK + dedup), delivers to dedicated "Heartbeat" topic thread (falls back to DM). Starts on boot via `onStart`, stops on SIGINT/SIGTERM.
- **Cron scheduler** — `cronTick()` fires every 60s, polls `cron_jobs` table for enabled jobs, checks `next_run_at` to determine due jobs. Supports three schedule types: `cron` (5-field via croner library), `interval` (e.g. "every 2h"), `once` (e.g. "in 20m"). Each execution spawns a Claude call with job prompt and thread context, delivers result to target thread or DM. One-shot jobs auto-disable after execution. Starts on boot via `onStart`, stops on SIGINT/SIGTERM.
- **Cron scheduler engine** — `cronTick()`, `executeCronJob()`, `sendCronResultToTelegram()`, `computeNextRun()`, `isJobDue()`, `getThreadInfoForCronJob()`, `startCronScheduler()`, `stopCronScheduler()`
- **Cron management** — `/cron` command handler (add/list/remove/enable/disable), `detectScheduleType()`, `createCronJob()`, `getAllCronJobs()`, `deleteCronJob()`
- **HEARTBEAT.md cron sync** — `parseCronJobsFromChecklist()`, `syncCronJobsFromFile()` — file-based cron definitions synced on each heartbeat tick
- **Thread summary generation** — `maybeUpdateThreadSummary()` triggers every 5 exchanges, makes a standalone Claude call to summarize the conversation
- **Voice transcription** — `transcribeAudio()` converts .oga→.wav via ffmpeg, then sends to Groq Whisper API (auto-detects language)
- **Text-to-speech** — `textToSpeech()` calls ElevenLabs v3 API, outputs opus format. Max 4500 chars per request.
- **Voice reply logic**:
  - Voice message in → always reply with voice + text
  - Text message in + `[VOICE_REPLY]` tag → voice + text
  - Text message in, no tag → text only

**Security guards** (in middleware and helpers):
- Auth gate: only `TELEGRAM_USER_ID` can interact; unauthorized users are silently rejected
- Rate limiting: 10 messages per minute per user
- Filename sanitization: prevents path traversal in uploaded documents
- Output size cap: 1MB max before truncation of Claude CLI output
- Fact length cap: LEARN facts capped at 200 chars, FORGET search capped at 200 chars

**Message handlers**: Text, voice, photos, documents. Media is downloaded to `~/.claude-relay/uploads/`, file path passed to Claude, cleaned up after processing.

**Setup scripts** (`setup/` directory) — Interactive configuration helpers, not part of the running relay:
- `install.ts`: Guided first-time setup (checks deps, creates `.env`, runs tests)
- `verify.ts`: Validates all required env vars and service connections
- `test-telegram.ts`, `test-supabase.ts`: Individual service connection tests
- `configure-launchd.ts`: Generates and loads the macOS LaunchAgent plist
- `configure-services.ts`: Walks through Groq/ElevenLabs API key setup

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
- `cron_jobs` — Scheduled jobs (name, schedule, prompt, target thread, source: user/agent/file)
- `heartbeat_config` — Single-row heartbeat settings (interval, active hours, timezone, enabled)

Migrations:
- `supabase/migrations/20260210202924_schema_v2_threads_memory_soul.sql` (v2: threads, memory, soul)
- `supabase/migrations/20260212_heartbeat_cron_schema.sql` (v2.1: heartbeat config, cron jobs)
- `supabase/migrations/20260212_2_add_file_source.sql` (v2.2: add 'file' source for cron jobs)

Reference SQL: `examples/supabase-schema-v2.sql`

## Environment Variables

Required in `.env`:
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_USER_ID` — numeric ID from @userinfobot (security gate)

Paths:
- `CLAUDE_PATH` — defaults to `claude` in PATH
- `PROJECT_DIR` — working directory for Claude CLI spawns
- `RELAY_DIR` — defaults to `~/.claude-relay`

Groq (voice transcription):
- `GROQ_API_KEY` — API key from console.groq.com
- `GROQ_WHISPER_MODEL` — defaults to `whisper-large-v3-turbo`
- `FFMPEG_PATH` — defaults to `/opt/homebrew/bin/ffmpeg`

Telegram group (heartbeat thread routing):
- `TELEGRAM_GROUP_ID` — numeric ID of the supergroup where heartbeat topic will be created (optional, falls back to DM)

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
- **Groq Whisper API** (external) — Cloud voice transcription with auto language detection
- **ffmpeg** (system) — Audio format conversion (.oga → .wav)
- **ElevenLabs API** (external) — Text-to-speech via eleven_v3 model
- **croner** ^9+ — Cron expression parser for 5-field cron schedules with timezone support
