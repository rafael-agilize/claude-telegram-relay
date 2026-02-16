---
phase: 20-milestone-moments
plan: 01
subsystem: memory-intents
tags: [milestone-tagging, intent-parsing, personality-evolution, soul-system]

dependency_graph:
  requires:
    - "Phase 17: save_milestone_moment RPC"
    - "Existing intent system (REMEMBER, GOAL, CRON)"
  provides:
    - "[MILESTONE:] intent parsing with optional WEIGHT and LESSON fields"
    - "saveMilestone() helper for Phase 21/22 manual tagging"
    - "System prompt instructions for auto-detection"
  affects:
    - "processIntents() — adds milestone parsing block"
    - "buildPrompt() — adds MILESTONES instruction section"
    - "buildHeartbeatPrompt() — allows MILESTONE tag"

tech_stack:
  added:
    - "MILESTONE intent regex with capture groups for weight/lesson"
  patterns:
    - "Intent-based mutation (tag → parse → DB → strip)"
    - "Optional fields via non-capturing groups in regex"

key_files:
  created: []
  modified:
    - path: "src/relay.ts"
      changes: "Added saveMilestone() helper, MILESTONE parsing in processIntents(), MILESTONES instructions in buildPrompt(), MILESTONE tag in heartbeat prompt"
      lines_changed: 71

decisions:
  - "Event description capped at 300 chars (vs REMEMBER's 200) — milestones are richer narratives"
  - "Lesson field is uncapped — trust DB TEXT column, don't truncate meaningful lessons"
  - "Default weight is 'meaningful' when omitted — balances ease of use with emotional nuance"
  - "Three weight levels (formative/meaningful/challenging) map to soul_milestones CHECK constraint"
  - "Heartbeat can tag milestones — daily reflections may discover formative moments retroactively"

metrics:
  duration_seconds: 190
  tasks_completed: 2
  files_modified: 1
  commits: 2
  completed_at: "2026-02-16T08:31:41Z"
---

# Phase 20 Plan 01: Milestone Intent Parsing

Claude can now tag formative moments via [MILESTONE:] intent during interactions.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Add [MILESTONE:] intent parsing and saveMilestone helper | 9107301 | src/relay.ts |
| 2 | Add milestone instructions to system prompt | d9bc908 | src/relay.ts |

## Implementation Summary

**saveMilestone() helper (Task 1):**
- Wraps `save_milestone_moment` RPC call from Phase 17
- Parameters: eventDescription, emotionalWeight (default: "meaningful"), lessonLearned, threadDbId
- Graceful error handling with console logging
- Returns boolean success/failure

**processIntents() parsing (Task 1):**
- Regex: `/\[MILESTONE:\s*(.+?)(?:\s*\|\s*WEIGHT:\s*(formative|meaningful|challenging))?(?:\s*\|\s*LESSON:\s*(.+?))?\]/gi`
- Supports two formats:
  - Simple: `[MILESTONE: event description]`
  - Full: `[MILESTONE: event description | WEIGHT: formative | LESSON: what was learned]`
- Validates event description length (max 300 chars)
- Logs `milestone_saved` events to logs_v2 with metadata
- Strips tags from delivered messages
- Updated hasIntents regex to include MILESTONE

**System prompt instructions (Task 2):**
- Added MILESTONES section in buildPrompt() after SCHEDULING block
- Explains auto-detection use case (breakthrough conversations, emotional exchanges, lessons learned, challenging situations)
- Documents optional WEIGHT and LESSON syntax
- Provides three concrete examples covering different weight types
- Guidance: "Use milestones sparingly — only for moments that genuinely shape who you are"
- Links to daily self-reflection: "These are consulted during your daily self-reflection to anchor personality evolution"

**Heartbeat integration (Task 2):**
- Added `[MILESTONE: event]` to heartbeat prompt allowed tags list
- Enables retrospective milestone tagging during daily reflections

## Deviations from Plan

None — plan executed exactly as written.

## Success Criteria

- [x] [MILESTONE:] intent parsed in processIntents() with optional WEIGHT and LESSON fields
- [x] saveMilestone() helper calls save_milestone_moment RPC
- [x] System prompt instructs Claude to tag formative moments (auto-detection + explicit)
- [x] Heartbeat prompt allows MILESTONE tags
- [x] Tags stripped from delivered messages
- [x] Events logged to logs_v2 as milestone_saved

## Next Steps

Phase 20-02: Milestone Retrieval (get recent milestones for daily evolution context)
Phase 20-03: Milestone Reflection (integrate milestones into evolution prompt)

## Self-Check: PASSED

Verified files:
- FOUND: src/relay.ts (modified, 71 lines changed)

Verified commits:
- FOUND: 9107301 (Task 1)
- FOUND: d9bc908 (Task 2)

Verified functionality:
- saveMilestone() function exists at line 429
- MILESTONE regex in hasIntents at line 1985
- MILESTONE parsing block in processIntents() at line 2093
- milestone_saved event logging at line 2105
- MILESTONES instruction section in buildPrompt() at line 3394
- MILESTONE tag in heartbeat prompt at line 1865
- All pieces follow same pattern as existing intents (REMEMBER, GOAL, CRON)
