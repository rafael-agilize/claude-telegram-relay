# PROJECT.md

## Project: Claude Telegram Relay

**Description:** A relay that bridges Telegram to the Claude Code CLI with persistent memory, voice I/O, proactive agent capabilities, self-evolving personality, security-hardened intents, and unrestricted permissions.

**Tech Stack:** Bun runtime, TypeScript, Grammy (Telegram Bot), Supabase (PostgreSQL + Edge Functions), Claude CLI, Groq Whisper, ElevenLabs TTS, croner (cron scheduling), OpenAI Embeddings (via Edge Functions)

**Architecture:** Single-file relay (`src/relay.ts` ~4,050 lines) + 2 Supabase Edge Functions. Message flow: Telegram -> Grammy handler -> buildPrompt() -> callClaude() via Bun.spawn -> processIntents() -> response back to Telegram.

## Core Value

Full-featured Telegram relay to Claude Code CLI with streaming, memory, proactive agent, semantic search, real-time feedback, self-evolving personality, and defense-in-depth security.

## Requirements

### Validated

- ✓ Threaded conversations with per-thread Claude sessions — v1.0
- ✓ Three-layer memory (recent messages, thread summary, global memory) — v1.0
- ✓ Voice I/O (Groq Whisper + ElevenLabs TTS) — v1.0
- ✓ Intent system ([REMEMBER:], [FORGET:], [VOICE_REPLY]) — v1.0
- ✓ buildPrompt() context assembly — v1.0
- ✓ Heartbeat system with HEARTBEAT.md, smart suppression, active hours — v1.1
- ✓ Cron engine with 3 schedule types and agent self-scheduling — v1.1
- ✓ Stream-json NDJSON parsing with activity-based timeout — v1.2
- ✓ Real-time typing indicators and tool-use progress — v1.2
- ✓ Typed memory (facts, goals, preferences) — v1.3
- ✓ Goals lifecycle with [GOAL:]/[DONE:] intents — v1.3
- ✓ Semantic search via Supabase Edge Functions — v1.3
- ✓ 3-layer soul architecture (Core Identity + Active Values + Recent Growth) — v1.4
- ✓ Daily soul evolution engine with midnight reflection — v1.4
- ✓ Milestone moments with emotional weight — v1.4
- ✓ Soul versioning, history, and rollback — v1.4
- ✓ Evolution controls (pause/resume/status) — v1.4
- ✓ Growth safeguards with anti-regression validation — v1.4
- ✓ Edge Function JWT authentication (service_role verification) — v1.5
- ✓ Embed function fetches content from DB by row ID (no client trust) — v1.5
- ✓ Search function input bounds (match_count ≤ 20, match_threshold ≥ 0.5) — v1.5
- ✓ Generic error responses in Edge Functions (no internal detail leaks) — v1.5
- ✓ Context-aware intent allowlists (CRON/FORGET blocked in heartbeat/cron) — v1.5
- ✓ Agent cron job approval flow (InlineKeyboard confirmation) — v1.5
- ✓ FORGET safety guards (10+ char min, 50%+ content overlap) — v1.5
- ✓ Per-response intent caps (5/3/1/3) with content deduplication — v1.5
- ✓ /soul content length cap (2000 chars) — v1.5
- ✓ Memory entry count cap with eviction (100 facts, 50 goals) — v1.5
- ✓ Filename sanitization allowlist ([a-zA-Z0-9._-]) — v1.5
- ✓ Lock file atomic acquisition (no fallback overwrite) — v1.5

### Active

(None — ready for next milestone)

### Out of Scope

- Multi-user support — single authorized user by design
- Web dashboard — overkill for single-user
- Semantic search on thread_messages — memory-only search sufficient
- Multi-channel (WhatsApp, Slack) — Telegram-only by design
- Editing individual soul layers via commands — /soul resets seed if needed
- Multi-persona / multiple souls — single evolving identity
- Soul evolution sharing — Rafa-only observer
- Evolution influenced by user ratings — future consideration
- Soul evolution visualization — future consideration
- RLS policies on Supabase tables — service role key bypasses RLS by design; auth gate is at Edge Function level
- End-to-end encryption of memories — overkill for single-user; auth gate sufficient
- Prompt injection detection model — context-aware allowlisting is pragmatic and effective
- Rate limiting on Edge Functions — Supabase API gateway already rate-limits

## Context

Shipped v1.5 with 4,298 LOC TypeScript in `src/relay.ts` + 2 Edge Functions + 7 migrations.
Tech stack: Bun, Grammy, Supabase, Claude CLI, Groq Whisper, ElevenLabs, croner, OpenAI Embeddings.
6 milestones shipped (v1.0-v1.5), 25 phases, 51 plans executed over 8 days.

Security posture after v1.5:
- Edge Functions authenticated via service_role JWT
- Intent system has 3-layer defense: context allowlists → per-response caps → input validation
- Memory bounded with automatic eviction
- All file operations use allowlist sanitization
- Lock acquisition is truly atomic

## Constraints

- **Runtime**: Bun — all scheduling must work with Bun's timer APIs
- **Architecture**: Single-file relay — all features integrate into relay.ts
- **State**: Supabase — all persistent state stored in cloud DB
- **Cost**: Claude API calls per heartbeat/cron/evolution — default 1h heartbeat, midnight evolution
- **Embeddings**: OpenAI API key in Supabase secrets only — relay never touches it
- **Soul budget**: 800 tokens max for active soul in prompt

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Dedicated heartbeat thread | Keeps proactive messages separate from conversations | ✓ Good — v1.1 |
| 1h default heartbeat interval | Balance responsiveness vs API cost | ✓ Good — v1.1 |
| Agent can self-schedule cron | Makes the assistant truly proactive | ✓ Good — v1.1 |
| croner for cron expressions | 5-field cron + timezone support | ✓ Good — v1.1 |
| Both Telegram + file config for cron | Phone accessibility + power user editing | ✓ Good — v1.1 |
| stream-json over json output | Activity detection, progress feedback | ✓ Good — v1.2 |
| 15-min inactivity timeout | Complex tasks need more time between outputs | ✓ Good — v1.2 |
| Liveness reporter pattern | Factory + callback decouples typing from callClaude | ✓ Good — v1.2 |
| Adopt upstream intent names | [REMEMBER:]/[GOAL:]/[DONE:] keeps parity | ✓ Good — v1.3 |
| OpenAI embeddings via Edge Functions | Keeps API key in Supabase secrets | ✓ Good — v1.3 |
| Supabase RPCs over direct queries | Cleaner type filtering at DB level | ✓ Good — v1.3 |
| Compression pyramid (3-layer soul) | Balances personality depth with token efficiency | ✓ Good — v1.4 |
| Daily evolution without approval | Rafa observes via reports, bot has full autonomy | ✓ Good — v1.4 |
| 800-token soul budget with truncation | Recent Growth → Active Values → Core Identity priority | ✓ Good — v1.4 |
| Rollback creates NEW version | Preserves full history, never deletes | ✓ Good — v1.4 |
| Growth safeguards in evolution prompt | Five principles prevent personality drift | ✓ Good — v1.4 |
| Warning-only regression validation | Logs regression but doesn't block save | ✓ Good — v1.4 |
| Service_role JWT for Edge Function auth | Supabase client automatically sends it | ✓ Good — v1.5 |
| DB-sourced content for embed function | Prevents content injection via client payload | ✓ Good — v1.5 |
| Context-aware intent allowlists | Prevents prompt injection escalation in automated contexts | ✓ Good — v1.5 |
| Agent cron jobs start disabled | Requires user approval, prevents self-replicating jobs | ✓ Good — v1.5 |
| FORGET overlap threshold (50%) | Prevents mass deletion via vague search terms | ✓ Good — v1.5 |
| Per-response intent caps | Prevents memory flooding in single response | ✓ Good — v1.5 |
| Allowlist filename sanitization | Stricter than blacklist, handles null bytes | ✓ Good — v1.5 |
| Atomic-only lock acquisition | Eliminates race condition, clean failure on contention | ✓ Good — v1.5 |

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
**Status:** Complete (3 phases, shipped 2026-02-13)
**Delivered:** Typed memory, goals lifecycle, semantic search via Edge Functions
**Archive:** [Roadmap](milestones/v1.3-ROADMAP.md) | [Requirements](milestones/v1.3-REQUIREMENTS.md)

### Milestone 1.4: Soul Evolution
**Goal:** Transform static bot soul into self-evolving personality with daily reflection, 3-layer structure, milestone moments, and version history.
**Status:** Complete (6 phases, shipped 2026-02-16)
**Delivered:** 3-layer soul architecture, daily evolution engine, milestone moments, soul versioning & rollback, evolution controls, growth safeguards
**Archive:** [Roadmap](milestones/v1.4-ROADMAP.md) | [Requirements](milestones/v1.4-REQUIREMENTS.md)

### Milestone 1.5: Security Hardening
**Goal:** Fix all 13 security vulnerabilities from full audit (4 HIGH, 9 MEDIUM) without breaking existing capabilities.
**Status:** Complete (3 phases, shipped 2026-02-17)
**Delivered:** Edge Function auth, context-aware intent allowlists, agent cron approval, FORGET safety guards, per-response intent caps, input hardening
**Archive:** [Roadmap](milestones/v1.5-ROADMAP.md) | [Requirements](milestones/v1.5-REQUIREMENTS.md) | [Audit](milestones/v1.5-MILESTONE-AUDIT.md)

</details>

---
*Last updated: 2026-02-17 after v1.5 milestone*
