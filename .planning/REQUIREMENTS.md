# REQUIREMENTS.md — Milestone 1: Conversational Threading & Memory System

## R1: Telegram Group Thread Support
- Bot operates in a Telegram supergroup with Topics enabled
- Each forum topic = a separate conversation with its own context
- DM mode continues to work as a single default conversation
- Bot must read all group messages (Group Privacy disabled in BotFather)
- Grammy upgraded to ^1.37+ for native auto-thread reply support
- Thread metadata (thread_id, chat_id, title) tracked in Supabase

## R2: True Conversation Continuity
- Each thread maintains its own Claude CLI session via `--resume`
- Session ID captured from `--output-format json` response
- Session ID stored per thread in Supabase
- On bot restart, sessions resume from stored IDs
- If a session becomes invalid, a new one is created transparently

## R3: Three-Layer Memory System

### R3.1: Recent Messages (per thread)
- Last 5 messages per thread loaded from Supabase into prompt
- Full content (not truncated to 200 chars)
- Serves as immediate context supplement to --resume

### R3.2: Thread Summary (per thread)
- Auto-generated summary of the thread conversation
- Updated periodically (every ~5 exchanges or when context is significant)
- Generated via a brief Claude call: "Summarize this thread concisely"
- Stored in threads table, injected into prompt
- Keeps prompts manageable even for very long threads

### R3.3: Global Memory (cross-thread)
- Facts the bot learns about the user across all conversations
- Auto-extracted by Claude via `[LEARN: concise fact]` intent tag
- Claude decides what's worth remembering — must keep snippets very small
- Removable via `[FORGET: search text]` intent tag
- Accessible from every thread (injected into every prompt)
- Managed entirely by the bot (no manual user commands needed, though [LEARN] can be triggered by user request)

## R4: Bot Soul (Personality)
- User sets personality via `/soul <text>` command in Telegram
- Stored in `bot_soul` Supabase table
- Loaded at the top of every prompt, every message
- Editable anytime (latest version always used)
- Default fallback soul if none is set: "You are a helpful, concise assistant responding via Telegram."

## R5: Supabase Schema Redesign
- Clean slate — new tables optimized for threaded conversations
- Old tables left in place but no longer written to
- New tables:
  - `threads` — conversation threads (telegram IDs, claude session, summary)
  - `messages` — per-thread message history (role, content, thread FK)
  - `global_memory` — cross-thread learned facts
  - `bot_soul` — personality definition
  - `logs` — observability (keep existing, add thread_id)
- Migration SQL script provided

## R6: Backward Compatibility
- DM messages still work (treated as a default "dm" thread)
- Voice transcription and TTS continue to work in both DM and threads
- Photo and document handling works in threads
- Existing .env variables still respected
- No new required environment variables (group setup is optional)

## Non-Requirements (explicitly out of scope)
- Multi-user support (still single authorized user)
- Web dashboard for memory management
- Semantic/vector search on messages
- Automated thread creation by the bot
- Scheduling or cron features
