# Claude Telegram Relay

A personal AI assistant on Telegram powered by Claude Code.

You message it. Claude responds. Text, photos, documents, voice. It remembers across sessions, checks in proactively, and runs in the background.

**Created by [Goda Go](https://youtube.com/@GodaGo)** | [AI Productivity Hub Community](https://skool.com/ai-productivity-hub)

```
You ──▶ Telegram ──▶ Relay ──▶ Claude Code CLI ──▶ Response
                                    │
                              Supabase (memory)
```

## What You Get

- **Relay**: Send messages on Telegram, get Claude responses back
- **Memory**: Persistent facts, goals, and conversation history via Supabase
- **Proactive**: Smart check-ins that know when to reach out (and when not to)
- **Briefings**: Daily morning summary with goals and schedule
- **Voice**: Transcribe voice messages via Gemini (optional)
- **Always On**: Runs in the background, starts on boot, restarts on crash
- **Guided Setup**: Claude Code reads CLAUDE.md and walks you through everything

## Quick Start

### Prerequisites

- **[Bun](https://bun.sh)** runtime (`curl -fsSL https://bun.sh/install | bash`)
- **[Claude Code](https://claude.ai/claude-code)** CLI installed and authenticated
- A **Telegram** account

### Option A: Guided Setup (Recommended)

```bash
git clone https://github.com/godagoo/claude-telegram-relay.git
cd claude-telegram-relay
claude
```

Claude Code reads `CLAUDE.md` and walks you through setup conversationally:

1. Create a Telegram bot via BotFather
2. Set up Supabase for persistent memory
3. Personalize your profile
4. Test the bot
5. Configure always-on services
6. Set up proactive check-ins and briefings
7. Add voice transcription (optional)

### Option B: Manual Setup

```bash
git clone https://github.com/godagoo/claude-telegram-relay.git
cd claude-telegram-relay
bun run setup          # Install deps, create .env
# Edit .env with your API keys
bun run test:telegram  # Verify bot token
bun run test:supabase  # Verify database
bun run start          # Start the bot
```

## Commands

```bash
# Run
bun run start              # Start the bot
bun run dev                # Start with auto-reload

# Setup & Testing
bun run setup              # Install dependencies, create .env
bun run test:telegram      # Test Telegram connection
bun run test:supabase      # Test Supabase connection
bun run setup:verify       # Full health check

# Always-On Services
bun run setup:launchd      # Configure launchd (macOS)
bun run setup:services     # Configure PM2 (Windows/Linux)

# Use --service flag for specific services:
# bun run setup:launchd -- --service relay
# bun run setup:launchd -- --service all    (relay + checkin + briefing)
```

## Project Structure

```
CLAUDE.md                    # Guided setup (Claude Code reads this)
src/
  relay.ts                   # Core relay daemon
examples/
  smart-checkin.ts           # Proactive check-ins
  morning-briefing.ts        # Daily briefing
  memory.ts                  # Memory persistence patterns
config/
  profile.example.md         # Personalization template
db/
  schema.sql                 # Supabase database schema
setup/
  install.ts                 # Prerequisites checker
  test-telegram.ts           # Telegram connectivity test
  test-supabase.ts           # Supabase connectivity test
  configure-launchd.ts       # macOS service setup
  configure-services.ts      # Windows/Linux service setup
  verify.ts                  # Full health check
daemon/
  launchagent.plist          # macOS daemon template
  claude-relay.service       # Linux systemd template
  README-WINDOWS.md          # Windows options
```

## How It Works

The relay does three things:
1. **Listen** for Telegram messages (via grammY)
2. **Spawn** Claude Code CLI with context (your profile, memory, time)
3. **Send** the response back on Telegram

Claude Code gives you full power: tools, MCP servers, web search, file access. Not just a model — an AI with hands.

Your bot remembers between sessions via Supabase: conversation history, facts you share, goals you track. The smart check-in script gathers this context and lets Claude decide whether to reach out.

## Environment Variables

See `.env.example` for all options. The essentials:

```bash
# Required
TELEGRAM_BOT_TOKEN=     # From @BotFather
TELEGRAM_USER_ID=       # From @userinfobot
SUPABASE_URL=           # From Supabase dashboard
SUPABASE_ANON_KEY=      # From Supabase dashboard

# Recommended
USER_NAME=              # Your first name
USER_TIMEZONE=          # e.g., America/New_York

# Optional
GEMINI_API_KEY=         # Voice transcription (free tier)
```

## The Full Version

This free relay covers the essentials. The full version in the [AI Productivity Hub](https://skool.com/ai-productivity-hub) community unlocks:

- **6 Specialized AI Agents** — Research, Content, Finance, Strategy, Critic + General orchestrator via Telegram forum topics
- **VPS Deployment** — Always-on cloud server with hybrid mode ($2-5/month)
- **Real Integrations** — Gmail, Calendar, Notion connected via MCP
- **Human-in-the-Loop** — Claude asks before taking actions via inline buttons
- **Voice & Phone Calls** — Bot speaks back via ElevenLabs, calls when urgent
- **Fallback AI Models** — Auto-switch to OpenRouter or Ollama when Claude is down
- **Production Infrastructure** — Auto-deploy, watchdog, uninstall scripts

We also help you personalize it for your business, or package it as a product for your clients.

**Subscribe on YouTube:** [youtube.com/@GodaGo](https://youtube.com/@GodaGo)
**Join the community:** [skool.com/ai-productivity-hub](https://skool.com/ai-productivity-hub)

## License

MIT — Take it, customize it, make it yours.

---

Built by [Goda Go](https://youtube.com/@GodaGo)
