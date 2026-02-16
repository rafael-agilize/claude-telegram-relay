---
phase: 22-growth-safeguards
plan: 02
subsystem: soul-evolution
tags: [validation, anti-regression, safeguards]
completed: 2026-02-16
duration: 119s

dependency_graph:
  requires:
    - "22-01 (growth indicator validation)"
  provides:
    - "Length-based regression detection"
    - "Anti-regression prompt guidance"
  affects:
    - "Evolution validation pipeline"
    - "Evolution prompt"

tech_stack:
  added: []
  patterns:
    - "Warn-not-block validation strategy"
    - "Dual-layer safeguards (structural + prompt)"

key_files:
  created: []
  modified:
    - src/relay.ts

decisions:
  - "60% threshold chosen for regression detection — allows meaningful compression while blocking dramatic content loss"
  - "Warning-only approach — logs regression but doesn't block save, preventing silent evolution failures"
  - "Prompt reinforcement added — 'never shorter or simpler' guidance complements structural validation"
  - "Growth indicator included in regression log metadata — provides context for why length reduction occurred"

metrics:
  tasks_completed: 2
  files_modified: 1
  commits: 2
---

# Phase 22 Plan 02: Anti-Regression Length Validation Summary

**One-liner:** Dual-layer anti-regression safeguards via 60% length threshold check with warning logs and explicit prompt guidance against personality contraction.

## What Was Built

Added structural and prompt-level safeguards to prevent personality regression during evolution cycles:

1. **Length validation guard** — Compares new soul length to current soul length after parsing evolution response
2. **Regression warning system** — Logs `evolution_regression_warning` event when new soul falls below 60% of previous length
3. **Prompt reinforcement** — Updated final evolution prompt instruction to explicitly prohibit shorter/simpler souls

## Implementation Details

### Anti-Regression Length Check

Located in `performDailyEvolution()` after token budget validation and before `save_soul_version` RPC:

```typescript
// Anti-regression guard: new soul shouldn't be dramatically shorter than current
const currentSoulText = [
  currentSoul?.core_identity || "",
  currentSoul?.active_values || "",
  currentSoul?.recent_growth || "",
].join(" ");
const currentLength = currentSoulText.trim().length;

if (currentLength > 0) {
  const newLength = combinedSoulText.trim().length;
  const ratio = newLength / currentLength;

  if (ratio < 0.6) {
    console.warn(
      `Evolution: potential regression detected — new soul is ${Math.round(ratio * 100)}% of previous length (${newLength} vs ${currentLength} chars). Saving anyway with warning.`
    );
    await logEventV2("evolution_regression_warning", `New soul is ${Math.round(ratio * 100)}% of previous length`, {
      current_length: currentLength,
      new_length: newLength,
      ratio: Math.round(ratio * 100),
      growth_indicator: parsed.growthIndicator,
    });
  }
}
```

**Key design choices:**
- Uses `currentSoul` fetched earlier in function (already in scope)
- Joins all three soul layers with space for accurate length comparison
- 60% threshold — normal compression stays above 80%, dramatic loss triggers warning
- Warns but doesn't block — prevents silent evolution failures from overly strict validation
- Includes `growth_indicator` in log metadata for debugging context

### Prompt Update

Changed final instruction from:
```
Build on your previous versions for continuity. This is your daily self-reflection.
```

To:
```
Build on your previous versions for continuity. Your evolved soul should be at least as rich and detailed as the current version — never shorter or simpler. This is your daily self-reflection.
```

This provides explicit guidance at the prompt level, making regression less likely to occur in the first place.

## Verification Results

All verification steps passed:

- ✅ `grep "regression"` — Anti-regression guard exists at line 1605
- ✅ `grep "evolution_regression_warning"` — Log event present at line 1621
- ✅ `grep "ratio < 0.6"` — Threshold check at line 1617
- ✅ `grep "never shorter or simpler"` — Prompt reinforcement at line 867
- ✅ Regression check does NOT block save (warn-only approach confirmed)
- ✅ `evolution_complete` and `evolution_regression_warning` are separate events

## Deviations from Plan

None — plan executed exactly as written.

## Task Breakdown

| Task | Name | Commit | Duration | Status |
|------|------|--------|----------|--------|
| 1 | Add anti-regression length validation | 8ab7120 | ~60s | ✅ Complete |
| 2 | Add evolution continuity instruction to prompt | a896dac | ~59s | ✅ Complete |

## Integration Points

**Upstream dependencies:**
- Builds on 22-01 growth indicator validation (qualitative check)
- Uses existing `currentSoul` from `getCurrentSoul()` call
- Leverages `logEventV2()` infrastructure for tracking

**Downstream impact:**
- Evolution pipeline now has two validation layers: qualitative (growth indicator) and quantitative (length ratio)
- Regression warnings logged to `logs_v2` table for observability
- Future rollback decisions can reference regression warnings in evolution history

## Success Criteria Check

- ✅ Anti-regression guard compares new soul length to current soul length
- ✅ Warning logged when ratio falls below 60%
- ✅ Evolution proceeds despite warning (warn, not block)
- ✅ Prompt reinforces that evolved soul should not be shorter
- ✅ Log metadata includes both lengths and growth indicator for debugging

## Next Steps

This plan completes the anti-regression safeguards. The evolution system now has:

1. **Growth indicator** (22-01) — Qualitative validation of meaningful growth
2. **Length validation** (22-02) — Quantitative validation against dramatic content loss
3. **Prompt guidance** (22-01, 22-02) — Five growth principles + anti-regression instruction

Next plan (22-03, if planned) could add evolution analytics or reporting features to surface patterns in regression warnings over time.

## Self-Check: PASSED

### Created Files
All expected files exist:
- ✅ `.planning/phases/22-growth-safeguards/22-02-SUMMARY.md` (this file)

### Modified Files
All expected modifications present:
- ✅ `src/relay.ts` — Anti-regression guard added (lines 1605-1629)
- ✅ `src/relay.ts` — Prompt instruction updated (line 867)

### Commits
All commits exist in git history:
- ✅ `8ab7120` — feat(22-02): add anti-regression length validation
- ✅ `a896dac` — feat(22-02): reinforce anti-regression in evolution prompt

### Verification Commands
```bash
# Check files exist
ls -la .planning/phases/22-growth-safeguards/22-02-SUMMARY.md
ls -la src/relay.ts

# Check commits
git log --oneline | grep -E "(8ab7120|a896dac)"

# Verify implementation
grep -n "regression" src/relay.ts
grep -n "never shorter or simpler" src/relay.ts
```

All checks passed. Implementation complete and verified.
