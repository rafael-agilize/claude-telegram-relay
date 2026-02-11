# ROADMAP.md — Milestone 1

## Phase 1: Schema Redesign & Grammy Upgrade
**Goal:** New Supabase tables and updated dependencies as the foundation for everything else.

**Tasks:**
1. Write new Supabase migration SQL (`examples/supabase-schema-v2.sql`) with tables: threads, messages, global_memory, bot_soul, logs
2. Upgrade Grammy from ^1.21.1 to ^1.37+ in package.json (for native auto-thread support)
3. Run `bun install` to update lockfile
4. Update Supabase client code in relay.ts: new helper functions for the new tables (insertThread, getThread, insertMessage, getRecentMessages, getGlobalMemory, getSoul, updateThreadSummary, etc.)

**Requirements:** R5, partial R1
**Risk:** Low — additive changes, old tables untouched

---

## Phase 2: Thread-Aware Message Routing
**Goal:** Bot works in both DMs and group forum topics, routing messages to the correct thread context.

**Tasks:**
1. Add thread detection: extract `message_thread_id` from `ctx.message` for group topics
2. Create thread routing middleware: lookup/create thread in Supabase for each incoming message
3. For DMs, use a synthetic thread (chat_id as thread identifier, no message_thread_id)
4. Pass thread context through all message handlers (text, voice, photo, document)
5. Update `sendResponse()` to work in both DM and thread contexts (Grammy ^1.37 handles this natively)
6. Add `/soul` command handler (stores personality text in bot_soul table)

**Requirements:** R1, R4, R6
**Risk:** Medium — changes message handler signatures, needs careful testing in both DM and group modes
**Depends on:** Phase 1

---

## Phase 3: Conversation Continuity
**Goal:** Each thread maintains a persistent Claude CLI session via --resume.

**Tasks:**
1. Switch `callClaude()` from `--output-format text` to `--output-format json`
2. Parse JSON response: extract `result` (the text) and `session_id`
3. Store `session_id` in the thread's Supabase row on first call
4. On subsequent calls, pass `--resume <session_id>` to maintain conversation
5. Handle session expiry/corruption: if --resume fails, start fresh session and update stored ID
6. Remove the broken regex-based session ID parsing
7. Update session.json to store per-thread sessions (or remove it entirely in favor of Supabase)

**Requirements:** R2
**Risk:** Medium — JSON parsing changes output handling, need to handle edge cases (timeout, large responses)
**Depends on:** Phase 2

---

## Phase 4: Three-Layer Memory System
**Goal:** Rich contextual memory with per-thread and cross-thread knowledge.

**Tasks:**
1. Rewrite `buildPrompt()` to assemble the three memory layers:
   - Soul (from bot_soul table)
   - Global memory (from global_memory table, all concise facts)
   - Thread summary (from threads table)
   - Recent messages are handled by --resume, but kept as fallback context
2. Replace `[REMEMBER:]` intent with `[LEARN:]` for global memory (auto-extracted by Claude)
3. Update `processIntents()` to handle `[LEARN:]` → insert into global_memory
4. Update `[FORGET:]` to search and delete from global_memory
5. Remove `[GOAL:]` and `[DONE:]` intents (goals were underused, simplify)
6. Add thread summary generation: after every 5 exchanges in a thread, make a brief Claude call to generate/update the thread summary
7. Add prompt instructions telling Claude to auto-extract important facts about the user using [LEARN:] — keeping snippets very concise
8. Log all messages to the new messages table (per-thread)

**Requirements:** R3, partial R4
**Risk:** Medium — prompt engineering is iterative, memory extraction quality depends on instructions
**Depends on:** Phase 3

---

## Phase 5: Polish & Hardening
**Goal:** Error handling, edge cases, and quality-of-life improvements.

**Tasks:**
1. Add `/new` command to reset a thread's session (starts fresh conversation in same topic)
2. Add `/memory` command to show current global memory items
3. Handle bot added to group without Topics enabled (graceful error message)
4. Handle very long Claude responses with JSON parsing (streaming consideration)
5. Update CLAUDE.md with new architecture documentation
6. Update README/examples with new setup instructions (group creation, BotFather settings)
7. Test all media handlers (voice, photo, document) in thread context
8. Clean up dead code from old session management

**Requirements:** R6, all
**Risk:** Low — polish and documentation
**Depends on:** Phase 4
