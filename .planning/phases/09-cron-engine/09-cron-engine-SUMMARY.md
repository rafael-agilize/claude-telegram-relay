# Phase 9: Cron Engine — Summary

## What Was Built

Tick-based cron scheduler that polls enabled jobs from Supabase, determines which are due, executes them via Claude CLI, and delivers results to Telegram.

## Functions Added (8)

1. **computeNextRun()** — Computes next execution time for all 3 schedule types
2. **isJobDue()** — Checks if a job should execute now based on next_run_at
3. **getThreadInfoForCronJob()** — Resolves target_thread_id to ThreadInfo for Claude context
4. **sendCronResultToTelegram()** — Delivers cron output to target thread or DM with [Cron: name] prefix
5. **executeCronJob()** — Full execution: prompt build, Claude call, intent processing, delivery, next_run update
6. **cronTick()** — Main loop (60s interval): polls jobs, checks due, executes sequentially
7. **startCronScheduler()** — Starts the tick interval (called on boot)
8. **stopCronScheduler()** — Clears the interval (called on SIGINT/SIGTERM)

## Schedule Types

| Type | Format | Example | Parsing |
|------|--------|---------|---------|
| cron | 5-field expression | `0 7 * * *` | croner library |
| interval | `every Xh Ym` | `every 2h`, `every 30m` | Regex |
| once | `in Xh Ym` | `in 20m`, `in 1h30m` | Regex |

## Files Changed

- **src/relay.ts** — +310 lines (cron engine section + lifecycle integration)
- **package.json** — Added croner ^10.0.1
- **CLAUDE.md** — Documented cron scheduler, croner dep, event types

## Key Patterns

- **cronRunning guard** — Prevents overlapping ticks (same as heartbeatRunning)
- **Sequential execution** — Jobs run one at a time within a tick to avoid concurrent Claude calls
- **One-shot auto-disable** — `schedule_type: "once"` jobs disabled after execution
- **Intent processing** — [LEARN:] and [FORGET:] work in cron context
- **DM fallback** — No target thread → deliver to user's DM

## Verification

- Build succeeds (`bun build --target bun`)
- All 8 functions present in relay.ts
- Lifecycle: startCronScheduler in onStart, stopCronScheduler in SIGINT + SIGTERM
- CLAUDE.md documents cron engine, croner dependency, cron_delivered event type
