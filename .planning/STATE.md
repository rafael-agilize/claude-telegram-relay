# STATE.md

## Current Position

Phase: 20 of 22 (Milestone Moments)
Plan: 2 of 3
Status: Phase 20 in progress
Last activity: 2026-02-16 — Completed 20-02 (Milestone Integration into Daily Evolution)

Progress: [███████████░░░░░░░░░] 59% (29/49 plans complete across all milestones)

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-15)

**Core value:** Full-featured Telegram relay to Claude Code CLI with streaming, memory, proactive agent, semantic search, and real-time feedback
**Current focus:** v1.4 Soul Evolution — self-evolving personality system

## Performance Metrics

**Velocity:**
- Total plans completed: 29 (across v1.0-v1.4)
- Total execution time: 1496s (v1.4 so far)

**By Milestone:**

| Milestone | Phases | Plans | Status |
|-----------|--------|-------|--------|
| v1.0 MVP | 1-5 | 10/10 | Complete 2026-02-10 |
| v1.1 Heartbeat | 6-11 | 12/12 | Complete 2026-02-12 |
| v1.2 Streaming | 12-13 | 4/4 | Complete 2026-02-13 |
| v1.3 Smart Memory | 14-16 | 7/7 | Complete 2026-02-13 |
| v1.4 Soul Evolution | 17-22 | 10/20 | In progress |

**v1.4 Phase Breakdown:**

| Phase | Plans | Status |
|-------|-------|--------|
| 17. Three-Layer Soul Schema | 2/2 | Complete |
| 18. Prompt Integration | 2/2 | Complete |
| 19. Daily Evolution Engine | 2/2 | Complete |
| 20. Milestone Moments | 2/3 | In progress |
| 21. Evolution Controls | 0/4 | Not started |
| 22. Growth Safeguards | 0/3 | Not started |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.

Recent decisions affecting v1.4:
- Compression pyramid (3-layer soul): Balances personality depth with token efficiency
- Daily evolution without approval: Rafa observes via reports, bot has full autonomy
- Milestone moments: Formative events anchor personality, prevent drift
- Auto-increment version via COALESCE(MAX(version), -1) + 1 (Phase 17-02): Safe for empty table, avoids race conditions
- Exclude reflection_notes from history queries (Phase 17-02): Reduces token overhead for evolution context
- formatSoulForPrompt() graceful fallback chain (Phase 18-01): 3-layer soul_versions → flat bot_soul → hardcoded default
- Empty soul layers skipped in prompt output (Phase 18-01): Optimizes token usage when active_values/recent_growth not yet populated
- Word-count * 1.3 token estimation (Phase 18-02): Avoids adding tokenizer dependency, keeps relay lightweight
- 800-token soul budget with graceful truncation (Phase 18-02): Recent Growth → Active Values → Core Identity priority
- Default limit=3 for getSoulHistory (Phase 19-01): Only recent context needed for reflection, reduces token overhead
- Evolution runs at midnight outside active hours (Phase 19-01): User doesn't need to be awake for daily soul evolution
- 30-min evolution timer interval (Phase 19-01): Balances responsiveness with resource efficiency
- Evolution reports reuse heartbeat infrastructure (Phase 19-02): Consistent delivery via sendHeartbeatToTelegram() without duplicating routing logic
- Token budget validation is permissive (Phase 19-02): Logs warning but proceeds, trusting Claude to stay within budget
- Message truncation strategy (Phase 19-02): Last 100 messages, 200 chars each, balances context richness with token efficiency
- EVOLUTION_SKIP as graceful no-op (Phase 19-02): Preserves previous soul version when no meaningful interactions occur
- Event description capped at 300 chars (Phase 20-01): Milestones are richer narratives than REMEMBER facts
- Default weight is 'meaningful' (Phase 20-01): Balances ease of use with emotional nuance
- Default limit 10 milestones for evolution (Phase 20-02): Balances rich historical context with token budget
- Milestone section between Soul History and Today's Interactions (Phase 20-02): Chronological flow from stable past to formative past to immediate present
- Explicit anti-drift guidance in evolution prompt (Phase 20-02): "Do not discard insights from these moments" prevents personality drift from formative experiences

### Pending Todos

None yet.

### Blockers/Concerns

None yet.

## Session Continuity

**Last session:** 2026-02-16 — Completed 20-02-PLAN.md (Milestone Integration into Daily Evolution)
**Next action:** Continue Phase 20 (plan 03)
**Resume file:** None

---

*Updated: 2026-02-16T08:35:24Z*
