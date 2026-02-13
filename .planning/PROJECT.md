# PROJECT.md

## Project: Claude Telegram Relay

**Description:** A relay that bridges Telegram to the Claude Code CLI with persistent memory, voice I/O, proactive agent capabilities, and unrestricted permissions.

**Tech Stack:** Bun runtime, TypeScript, Grammy (Telegram Bot), Supabase (PostgreSQL), Claude CLI, Groq Whisper, ElevenLabs TTS, croner (cron scheduling)

**Architecture:** Single-file relay (`src/relay.ts` ~2,700 lines). Message flow: Telegram -> Grammy handler -> buildPrompt() -> callClaude() via Bun.spawn -> processIntents() -> response back to Telegram.

## Current State

**Latest version:** v1.2 (shipped 2026-02-13)
**Active milestone:** v1.3 — Smart Memory (Phases 14-16)

**Shipped capabilities:**
- Telegram group threads as parallel conversation channels
- True Claude CLI conversation continuity via --resume per thread
- Three-layer memory: recent messages, thread summary, global memory
- Bot "soul" (personality) loaded in every interaction
- Supabase v2 schema (threads, global_memory, bot_soul, logs_v2, cron_jobs, heartbeat_config)
- Voice transcription (Groq Whisper) and TTS (ElevenLabs)
- DM + supergroup Topics support
- Intent system: [REMEMBER:], [FORGET:], [GOAL:], [DONE:], [VOICE_REPLY], [CRON:]
- Heartbeat system: periodic agent loop with HEARTBEAT.md checklist, smart suppression, active hours, dedicated thread
- Cron system: 3 schedule types (cron/interval/once), Telegram commands, file sync, agent self-scheduling
- Stream-json NDJSON parsing with activity-based 15-min inactivity timeout
- Real-time typing indicators (4s interval) and tool-use progress messages (15s throttle)

## Out of Scope

- Multi-user support (still single authorized user) -- complexity, not needed
- Web dashboard -- overkill for single-user
- Semantic/vector search on thread_messages -- memory-only semantic search sufficient for now
- Multi-channel support (WhatsApp, Slack, etc.) -- Telegram-only by design

## Context

- Inspired by OpenClaw (github.com/openclaw/openclaw) heartbeat and cron systems
- OpenClaw uses a gateway architecture with 13+ channels; we stay lightweight single-file
- Key adaptations: HEARTBEAT.md checklist, HEARTBEAT_OK suppression, active hours, croner library
- Our relay spawns Claude CLI processes; OpenClaw uses embedded Pi agent RPC

## Constraints

- **Runtime**: Bun -- all scheduling must work with Bun's timer APIs
- **Architecture**: Single-file relay -- all features integrate into relay.ts
- **State**: Supabase -- all persistent state stored in cloud DB
- **Cost**: Claude API calls per heartbeat/cron -- default 1h heartbeat interval to manage cost

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Dedicated heartbeat thread | Keeps proactive messages separate from conversations | Shipped v1.1 |
| 1h default heartbeat interval | Balance responsiveness vs API cost | Shipped v1.1 |
| Agent can self-schedule cron | Makes the assistant truly proactive (reminders, follow-ups) | Shipped v1.1 |
| croner for cron expressions | Same library OpenClaw uses, 5-field cron + timezone support | Shipped v1.1 |
| Both Telegram commands + file config for cron | Accessibility from phone + power user file editing | Shipped v1.1 |
| stream-json over json output | Enables activity detection, progress feedback, and eliminates blind 5-min timeout | Shipped v1.2 |
| 15-min inactivity timeout | Complex tasks (subagents, research) need more than 5 min between outputs | Shipped v1.2 |
| Liveness reporter pattern | Factory + callback decouples typing/progress from callClaude internals | Shipped v1.2 |
| Adopt upstream intent names | [REMEMBER:]/[GOAL:]/[DONE:] from upstream; keeps parity with fork source | v1.3 |
| OpenAI embeddings via Edge Functions | Keeps OpenAI key in Supabase secrets, relay never needs it | v1.3 |
| Memory-only semantic search | Thread messages already have recency context; memory search adds most value | v1.3 |

---

<details>
<summary>Milestone History</summary>

### Milestone 1.0: Conversational Threading & Memory System
**Goal:** Transform the bot from one-off request/response into a full conversation system.
**Status:** Complete (5 phases, shipped 2026-02-10)
**Delivered:** Threaded conversations, three-layer memory, voice I/O

### Milestone 1.1: Heartbeat & Proactive Agent
**Goal:** Make the bot proactive with periodic check-ins and scheduled tasks.
**Status:** Complete (6 phases, shipped 2026-02-12)
**Delivered:** Heartbeat system, cron engine, cron management, agent self-scheduling
**Archive:** [Roadmap](milestones/v1.1-ROADMAP.md) | [Requirements](milestones/v1.1-REQUIREMENTS.md)

### Milestone 1.2: Streaming & Long-Running Task Resilience
**Goal:** Make the relay robust for complex, long-running Claude CLI tasks.
**Status:** Complete (2 phases, shipped 2026-02-13)
**Delivered:** Stream-json NDJSON parsing, activity-based timeout, typing indicators, tool-use progress
**Archive:** [Roadmap](milestones/v1.2-ROADMAP.md) | [Requirements](milestones/v1.2-REQUIREMENTS.md)

### Milestone 1.3: Smart Memory
**Goal:** Evolve flat memory into typed system with goals tracking and semantic search.
**Status:** In progress (3 phases: 14-16)
**Origin:** Upstream commit [fced316](https://github.com/rafael-agilize/claude-telegram-relay/commit/fced3162c65657635e97164f7ba4f519e145283a)

</details>

---
*Last updated: 2026-02-13 — Milestone v1.3 started*
