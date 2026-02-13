# Claude Telegram Relay

Claude Code on your phone. Text, voice, photos, documents, persistent memory, scheduled check-ins.

This relay connects Telegram to the Claude Code CLI. Every message spawns a Claude Code session with full tool access: shell commands, file operations, web search, MCP servers. It remembers you across conversations, picks up facts you mention, and checks in on its own when something needs attention.

**Created by [Goda Go](https://youtube.com/@GodaGo)** | [AI Productivity Hub Community](https://skool.com/ai-productivity-hub)

```
You (Telegram) ──> Grammy Bot ──> Claude Code CLI ──> Tools, Web, Files
                        │                                     │
                   Supabase ◄─────────── Memory ◄─────────────┘
              (threads, facts, soul, logs, cron)
```

---

## Features

**Conversations**
- Threaded sessions — each Telegram forum topic or DM gets its own Claude session with `--resume`
- Three-layer memory: personality (soul), cross-thread facts (global memory), per-thread context (summary + recent messages)
- Auto-generated thread summaries every 5 exchanges
- Runs with `--dangerously-skip-permissions`, so Claude has the same access as your terminal

**Voice**
- Send a voice message, get a transcription + Claude response back
- Claude can reply with voice using ElevenLabs TTS (triggered by `[VOICE_REPLY]` intent or voice-in)
- Transcription via Groq Whisper API with automatic language detection

**Media**
- Send photos for visual analysis (Claude sees the image)
- Send documents (PDF, code files, etc.). They're downloaded, passed to Claude, and cleaned up after

**Proactive Agent**
- Heartbeat system: periodic check-ins driven by a `HEARTBEAT.md` checklist (weather, reminders, deadlines)
- Active hours gating, so it won't message you outside your configured window
- Cron scheduler with three schedule types: `cron` expressions, `interval` ("every 2h"), and one-shot ("in 20m")
- Claude can self-schedule follow-up tasks via `[CRON:]` intent
- File-based cron definitions in HEARTBEAT.md, synced automatically

**Liveness**
- Typing indicators every 4 seconds while Claude works
- Tool-use progress messages ("Searching code...", "Running command...") that update as Claude switches tools
- Progress message is edited in-place and deleted when done

**Intent System**
- `[LEARN: fact]` — Claude saves a cross-thread fact about you
- `[FORGET: text]` — Claude removes a previously learned fact
- `[VOICE_REPLY]` — Claude responds with TTS audio
- `[CRON: schedule | prompt]` — Claude schedules a future task

**Bot Commands**
- `/soul <text>` — set the bot's personality (loaded into every prompt)
- `/new` — reset the Claude session for the current thread
- `/memory` — show all learned facts
- `/cron list|add|remove|enable|disable` — manage scheduled jobs

**Always On**
- macOS LaunchAgent for auto-start on boot and crash recovery
- Linux systemd unit file included
- PID-based lock file prevents duplicate instances

---

## Quick Start

### Prerequisites

- **macOS, Linux, or WSL** (Windows via WSL)
- **[Bun](https://bun.sh)** runtime — `curl -fsSL https://bun.sh/install | bash`
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** CLI — `npm install -g @anthropic-ai/claude-code` (must be authenticated)
- **Telegram account** + a bot from [@BotFather](https://t.me/BotFather)
- **[Supabase](https://supabase.com)** project (free tier works)

### Option A: Let Claude Code Set It Up (Recommended)

Clone the repo and open Claude Code inside it. Claude reads `CLAUDE.md`, asks you for API keys, and handles the rest.

```bash
git clone https://github.com/godagoo/claude-telegram-relay.git
cd claude-telegram-relay
claude
```

Then tell Claude:

> "Set up this project for me. I want to run the Telegram relay."

Claude will:
1. Install dependencies (`bun install`)
2. Create `.env` from the template and ask you for each credential
3. Run the Supabase schema (asks for your Supabase URL and service key)
4. Test the Telegram bot connection
5. Test the Supabase connection
6. Ask you to define a soul (personality) for the bot
7. Start the relay

See the [Claude Code Setup Instructions](#claude-code-setup-instructions) section below for the full script Claude follows.

### Option B: Manual Setup

```bash
git clone https://github.com/godagoo/claude-telegram-relay.git
cd claude-telegram-relay

# 1. Install dependencies
bun install

# 2. Create environment file
cp .env.example .env
# Edit .env with your API keys (see Environment Variables below)

# 3. Set up the database
# Copy the contents of examples/supabase-schema-v2.sql
# Paste and run in your Supabase SQL Editor (supabase.com → SQL Editor)

# 4. Test connections
bun run test:telegram
bun run test:supabase

# 5. Start the relay
bun run start
```

---

## Environment Variables

Create a `.env` file in the project root. Required variables:

```bash
# --- REQUIRED ---
TELEGRAM_BOT_TOKEN=           # From @BotFather on Telegram
TELEGRAM_USER_ID=             # Your numeric ID (get it from @userinfobot on Telegram)
SUPABASE_URL=                 # Your Supabase project URL (https://xxxxx.supabase.co)
SUPABASE_SERVICE_KEY=         # Supabase service_role key (Settings → API → service_role)

# --- OPTIONAL: Voice ---
GROQ_API_KEY=                 # Groq API key for Whisper transcription (console.groq.com)
ELEVENLABS_API_KEY=           # ElevenLabs API key for TTS
ELEVENLABS_VOICE_ID=          # ElevenLabs voice ID

# --- OPTIONAL: Paths ---
CLAUDE_PATH=claude            # Path to Claude CLI (auto-detected if in PATH)
PROJECT_DIR=                  # Working directory for Claude (defaults to relay directory)
FFMPEG_PATH=/opt/homebrew/bin/ffmpeg  # Path to ffmpeg (for voice conversion)

# --- OPTIONAL: Telegram Group ---
TELEGRAM_GROUP_ID=            # Supergroup ID for heartbeat topic (falls back to DM)
```

---

## Database Setup

The relay uses Supabase for all persistent state. Run the schema in your Supabase SQL Editor:

1. Go to your Supabase dashboard → **SQL Editor**
2. Copy the contents of `examples/supabase-schema-v2.sql`
3. Run it — this creates all tables, indexes, RLS policies, and helper functions

**Tables created:**
| Table | Purpose |
|-------|---------|
| `threads` | Conversation channels (one per Telegram topic/DM) |
| `thread_messages` | Per-thread message history |
| `global_memory` | Cross-thread facts learned by Claude |
| `bot_soul` | Bot personality (set via `/soul` command) |
| `logs_v2` | Observability events |
| `cron_jobs` | Scheduled jobs (cron, interval, one-shot) |
| `heartbeat_config` | Heartbeat timer settings (interval, active hours, timezone) |

---

## Running as a Daemon

### macOS (LaunchAgent)

```bash
bun run setup:launchd
# This generates and loads ~/Library/LaunchAgents/com.claude-telegram-relay.plist

# Manual control:
launchctl load ~/Library/LaunchAgents/com.claude-telegram-relay.plist
launchctl unload ~/Library/LaunchAgents/com.claude-telegram-relay.plist
launchctl list | grep claude-telegram

# Logs:
tail -f ~/.claude-relay/relay.log
tail -f ~/.claude-relay/relay-error.log
```

### Linux (systemd)

A template unit file is at `daemon/claude-relay.service`. Copy it to `~/.config/systemd/user/`, edit paths, then:

```bash
systemctl --user enable claude-relay
systemctl --user start claude-relay
journalctl --user -u claude-relay -f
```

---

## Heartbeat & Cron

### Heartbeat

Create a `HEARTBEAT.md` file in the project root with a checklist of things Claude should check on each tick:

```markdown
# Heartbeat Checklist

## What to Check
- Check the weather in your city and report it
- Check if there are pending reminders or follow-ups
- Look for patterns in recent conversations that need attention

## When to Report
Report when something needs attention. Stay silent (HEARTBEAT_OK) when everything is routine.
```

Configure the heartbeat interval and active hours in the `heartbeat_config` table in Supabase.

### Cron Jobs

Manage scheduled tasks via Telegram:

```
/cron add "0 7 * * *" Good morning briefing with weather and tasks
/cron add "every 2h" Check if anything needs my attention
/cron add "in 20m" Remind me to check the deployment
/cron list
/cron remove 1
/cron enable 2
/cron disable 2
```

Claude can also create cron jobs itself by including `[CRON: schedule | prompt]` in a response.

---

## Claude Code Setup Instructions

If you are Claude Code and a user asks you to set up this project, follow this procedure:

### Step-by-step setup procedure

1. **Install dependencies**
   ```bash
   bun install
   ```

2. **Create `.env`** — Copy `.env.example` to `.env`, then ask the user for each value:
   - **Telegram Bot Token**: Tell them to open Telegram, search for `@BotFather`, send `/newbot`, follow the prompts, and paste the token.
   - **Telegram User ID**: Tell them to search for `@userinfobot` on Telegram, start it, and paste their numeric ID.
   - **Supabase URL**: Tell them to go to [supabase.com](https://supabase.com), create a free project, then go to Settings → API and copy the Project URL.
   - **Supabase Service Key**: Same page (Settings → API), copy the `service_role` secret key (NOT the anon key).
   - Write these values to `.env`.

3. **Run the database schema** — Read the file `examples/supabase-schema-v2.sql` and tell the user to:
   - Go to their Supabase dashboard → SQL Editor
   - Paste the entire SQL contents and click "Run"
   - Alternatively, if you have the Supabase CLI available, run migrations directly.

4. **Test connections**
   ```bash
   bun run test:telegram
   bun run test:supabase
   ```
   If either test fails, help the user troubleshoot (wrong token, missing table, wrong key, etc.).

5. **Set the bot's soul** — Ask the user: *"What personality should the bot have? For example: 'You are Carol, a fun and helpful personal assistant who speaks Portuguese and English.'"* Save their answer — they can set it later via `/soul` in Telegram, or you can insert it directly into the `bot_soul` table.

6. **Optional services** — Ask if they want voice features:
   - **Voice transcription**: Groq API key from [console.groq.com](https://console.groq.com) + ffmpeg installed
   - **Voice responses**: ElevenLabs API key and voice ID from [elevenlabs.io](https://elevenlabs.io)

7. **Start the relay**
   ```bash
   bun run start
   ```
   Tell the user to open Telegram and send a message to their bot. It should respond.

8. **Optional: Set up always-on daemon**
   ```bash
   bun run setup:launchd   # macOS
   ```
   This starts the relay on boot and restarts it if it crashes.

---

## Dev Commands

```bash
bun run start              # Start the relay
bun run dev                # Start with hot-reload (--watch)
bun run setup              # Interactive guided setup
bun run setup:verify       # Verify all services are configured
bun run test:telegram      # Test Telegram bot connection
bun run test:supabase      # Test Supabase connection
bun run setup:launchd      # Configure macOS LaunchAgent
bun run setup:services     # Configure external services (Groq, ElevenLabs)
```

---

## Architecture

The whole thing is one file: `src/relay.ts` (~2,700 lines). Message handlers, memory, Claude CLI integration, heartbeat, cron, voice, intents.

```
Incoming message → Thread routing → buildPrompt() → callClaude() → processIntents() → Send response
                                                          │
                                                    Stream-JSON NDJSON
                                                    (typing + tool progress)
```

`callClaude()` spawns `claude -p "<prompt>" --resume <session> --output-format stream-json --verbose --dangerously-skip-permissions`, parses NDJSON events for session management and liveness reporting, and kills the process after 15 minutes of inactivity.

`buildPrompt()` assembles soul + global memory + thread context + user message into a single prompt. `processIntents()` parses `[LEARN:]`, `[FORGET:]`, `[VOICE_REPLY]`, `[CRON:]` tags from Claude's response and executes the side effects before stripping them from the output.

`createLivenessReporter()` sends typing indicators and tool progress messages while Claude works. `heartbeatTick()` and `cronTick()` are timer-driven loops for proactive check-ins and scheduled jobs.

Security: only `TELEGRAM_USER_ID` can interact (everyone else is silently rejected). Rate limited to 10 messages/minute. Filenames are sanitized against path traversal. Claude output is capped at 1MB. LEARN/FORGET facts are capped at 200 chars.

---

## License

MIT

---

Built by [Goda Go](https://youtube.com/@GodaGo) | [Subscribe on YouTube](https://youtube.com/@GodaGo) | [Join the community](https://skool.com/ai-productivity-hub)
