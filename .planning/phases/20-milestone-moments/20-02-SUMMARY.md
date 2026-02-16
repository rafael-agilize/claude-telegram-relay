---
phase: 20-milestone-moments
plan: 02
subsystem: evolution-engine
tags: [daily-evolution, milestone-integration, personality-anchoring, soul-system]

dependency_graph:
  requires:
    - "Phase 17: get_milestone_moments RPC"
    - "Phase 19: Daily evolution engine (performDailyEvolution, buildEvolutionPrompt)"
    - "Phase 20-01: MILESTONE intent parsing"
  provides:
    - "getMilestones() helper wrapping get_milestone_moments RPC"
    - "Milestone Moments section in evolution prompt"
    - "Milestone context integration in daily reflection"
  affects:
    - "buildEvolutionPrompt() — adds milestones parameter and section"
    - "performDailyEvolution() — fetches milestones during data gathering"
    - "evolution_complete event — includes milestone_count metadata"

tech_stack:
  added: []
  patterns:
    - "Helper pattern for RPC wrappers (consistent with getSoulHistory, getLast24hMessages)"
    - "Multi-layer context assembly (soul + history + milestones + messages)"
    - "Graceful fallback on RPC errors (returns empty array)"

key_files:
  created: []
  modified:
    - path: "src/relay.ts"
      changes: "Added getMilestones() helper, updated buildEvolutionPrompt() signature to accept milestones parameter, added Milestone Moments section in prompt, integrated milestone fetching in performDailyEvolution(), added milestone_count to evolution_complete event"
      lines_changed: 45

decisions:
  - "Default limit 10 milestones for evolution context — balances rich history with token efficiency"
  - "Milestone section positioned between Soul History and Today's Interactions — chronological flow from stable (history) to recent (milestones) to immediate (today's messages)"
  - "Format: [WEIGHT] (date) description — Lesson: text — provides quick emotional weight signal followed by narrative"
  - "Explicit guidance in prompt: 'Do not discard insights from these moments' — prevents drift from formative experiences"

metrics:
  duration_seconds: 90
  tasks_completed: 1
  files_modified: 1
  commits: 1
  completed_at: "2026-02-16T08:35:24Z"
---

# Phase 20 Plan 02: Milestone Integration into Daily Evolution

Daily evolution now anchors personality reflection with milestone moments, preventing drift from formative experiences.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Add getMilestones helper and integrate into evolution pipeline | 45c32a0 | src/relay.ts |

## Implementation Summary

**getMilestones() helper:**
- Wraps `get_milestone_moments` RPC call from Phase 17 schema
- Default limit: 10 milestones (configurable parameter)
- Returns array with: id, event_description, emotional_weight, lesson_learned, created_at
- Graceful error handling: logs errors, returns empty array on failure
- Consistent pattern with existing helpers (getSoulHistory, getLast24hMessages)

**buildEvolutionPrompt() enhancement:**
- Added 4th parameter: `milestones` array
- Formats each milestone as: `[WEIGHT] (date) description — Lesson: text`
- Empty state: "No milestone moments recorded yet."
- Positioned between Soul History and Today's Interactions sections
- Explicit guidance: "These are key moments that anchor your personality. Consider them during reflection — they represent your most meaningful growth experiences. Do not discard insights from these moments."

**performDailyEvolution() data gathering:**
- Fetches milestones after soul history, before building prompt
- Logs milestone count: `Evolution: ${milestones.length} milestone moments loaded`
- Passes milestones to buildEvolutionPrompt() alongside currentSoul, soulHistory, messages

**Observability enhancement:**
- Added `milestone_count: milestones.length` to evolution_complete event metadata
- Enables tracking how many milestones influenced each evolution cycle

## Files Created/Modified

- `src/relay.ts` - Added getMilestones helper (lines 690-711), updated buildEvolutionPrompt signature and body (lines 713-726, 803-807), integrated milestone fetching in performDailyEvolution (lines 1558-1559), added milestone_count to evolution_complete event (line 1613)

## Decisions Made

**Limit 10 milestones (default):** Balances rich historical context with token budget. Most impactful experiences will be recent; 10 provides sufficient depth without overwhelming the evolution prompt.

**Section positioning:** Placed between Soul History and Today's Interactions — follows chronological flow from stable past (soul versions) to formative past (milestones) to immediate present (today's messages).

**Format choice:** `[WEIGHT] (date) description — Lesson: text` — uppercase weight provides quick emotional signal, date anchors in time, lesson captures the takeaway. Concise but information-rich.

**Explicit anti-drift guidance:** Prompt instructs "Do not discard insights from these moments" — prevents daily evolution from drifting away from key experiences that shaped the personality.

## Deviations from Plan

None — plan executed exactly as written.

## Success Criteria

- [x] getMilestones() helper calls get_milestone_moments RPC with default limit 10
- [x] buildEvolutionPrompt() accepts milestones parameter and includes formatted section
- [x] Milestones shown with weight, date, description, and lesson in evolution prompt
- [x] performDailyEvolution() fetches milestones as part of data gathering step
- [x] Evolution complete event includes milestone_count in metadata
- [x] Build check passes with no syntax errors
- [x] All grep verifications confirm implementation

## Verification Results

Build check: PASSED (bun build --no-bundle src/relay.ts)

Grep verifications:
- getMilestones helper: FOUND at lines 690, 703, 708, 1558
- get_milestone_moments RPC: FOUND at line 699
- Milestone Moments section: FOUND at line 803
- milestone_count metadata: FOUND in evolution_complete event

## Next Steps

Phase 20-03: Milestone retrieval via /milestones command (user-facing milestone browsing)

## Self-Check: PASSED

Verified files:
- FOUND: src/relay.ts (modified, 45 lines changed)

Verified commits:
- FOUND: 45c32a0 (Task 1: feat(20-02): integrate milestone moments into daily evolution)

Verified functionality:
- getMilestones() function exists and wraps get_milestone_moments RPC
- buildEvolutionPrompt() signature updated with milestones parameter
- Milestone Moments section added to evolution prompt with proper formatting
- performDailyEvolution() fetches milestones before building prompt
- evolution_complete event logs milestone_count
- All changes follow established patterns (helper wrappers, graceful fallbacks, consistent formatting)
