# Milestones

## v1.4 Soul Evolution (Shipped: 2026-02-16)

**Phases:** 17-22 (6 phases, 12 plans)
**Lines changed:** +1,029 / -12
**Timeline:** 2 days (2026-02-15 → 2026-02-16)
**Git range:** `feat(17-01)` → `feat(22-02)`

**Key accomplishments:**
- 3-layer soul architecture (Core Identity + Active Values + Recent Growth) with versioned snapshots and 800-token budget
- Daily evolution engine — cron-triggered midnight reflection analyzes 24h interactions, generates new soul version
- Milestone moments — formative event detection with emotional weight anchors personality across evolution cycles
- Soul versioning & rollback — full history preserved, `/soul history` and `/soul rollback <N>`
- Evolution controls — `/soul pause/resume/status` for full lifecycle management
- Growth safeguards — upward trajectory enforcement with anti-regression length validation

---

## v1.3 Smart Memory (Shipped: 2026-02-13)

**Phases:** 14-16 (3 phases, 7 plans)
**Archive:** [Roadmap](milestones/v1.3-ROADMAP.md) | [Requirements](milestones/v1.3-REQUIREMENTS.md)

**Key accomplishments:**
- Typed memory system (facts, goals, completed goals, preferences)
- Goals lifecycle with [GOAL:] and [DONE:] intents and deadline tracking
- Semantic search via Supabase Edge Functions + OpenAI embeddings

---

## v1.2 Streaming & Long-Running Tasks (Shipped: 2026-02-13)

**Phases:** 12-13 (2 phases, 4 plans)
**Archive:** [Roadmap](milestones/v1.2-ROADMAP.md) | [Requirements](milestones/v1.2-REQUIREMENTS.md)

**Key accomplishments:**
- Stream-json NDJSON parsing with activity-based 15-min timeout
- Real-time typing indicators and tool-use progress messages

---

## v1.1 Heartbeat & Proactive Agent (Shipped: 2026-02-12)

**Phases:** 6-11 (6 phases, 12 plans)
**Archive:** [Roadmap](milestones/v1.1-ROADMAP.md) | [Requirements](milestones/v1.1-REQUIREMENTS.md)

**Key accomplishments:**
- Heartbeat system with HEARTBEAT.md checklist, smart suppression, active hours
- Cron engine with 3 schedule types (cron/interval/once)
- Agent self-scheduling via [CRON:] intent and file-based sync

---

## v1.0 MVP (Shipped: 2026-02-10)

**Phases:** 1-5 (5 phases, 10 plans)

**Key accomplishments:**
- Threaded conversations with per-thread Claude CLI sessions
- Three-layer memory (recent messages, thread summary, global memory)
- Voice I/O (Groq Whisper transcription + ElevenLabs TTS)
- Intent system ([REMEMBER:], [FORGET:], [VOICE_REPLY])

---
