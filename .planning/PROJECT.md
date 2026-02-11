# PROJECT.md

## Project: Claude Telegram Relay

**Description:** A relay that bridges Telegram to the Claude Code CLI with persistent memory, voice I/O, and unrestricted permissions.

**Tech Stack:** Bun runtime, TypeScript, Grammy (Telegram Bot), Supabase (PostgreSQL), Claude CLI, mlx_whisper, ElevenLabs TTS

**Architecture:** Single-file relay (`src/relay.ts` ~730 lines). Message flow: Telegram -> Grammy handler -> buildPrompt() -> callClaude() via Bun.spawn -> processIntents() -> response back to Telegram.

**Current State (v1.0.0):**
- Text, voice, photo, document message handling
- Supabase logging (messages, memory, logs tables)
- Intent system: [REMEMBER], [GOAL], [DONE], [FORGET], [VOICE_REPLY]
- Voice transcription (mlx_whisper) and TTS (ElevenLabs)
- Single-instance lock file
- Session management (broken — session ID capture fails with --output-format text)
- DM-only operation (single authorized user)

**Known Issues:**
- Claude CLI `--resume` never works because session ID is parsed from text output (which doesn't include it)
- Each message is effectively a new Claude session with only 6 recent messages (200 chars each) as context
- No true conversation continuity
- No group/thread support

---

## Milestone 1: Conversational Threading & Memory System

**Goal:** Transform the bot from one-off request/response into a full conversation system with:
1. Telegram group threads as parallel conversation channels
2. True Claude CLI conversation continuity via --resume per thread
3. Three-layer memory: recent messages, thread summary, global memory
4. Bot "soul" (personality) loaded in every interaction
5. Redesigned Supabase schema

**Started:** 2026-02-10
