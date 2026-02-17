---
phase: 24-intent-injection-defense
plan: 02
subsystem: agent-autonomy
tags: [cron, security, approval-flow, inline-keyboard]
dependency_graph:
  requires: [24-01-intent-allowlists]
  provides: [cron-approval-flow, inline-keyboard-infrastructure]
  affects: [cron-jobs, processIntents]
tech_stack:
  added: [InlineKeyboard]
  patterns: [callback-query-handler, approval-workflow]
key_files:
  created: []
  modified: [src/relay.ts]
decisions:
  - Agent-created cron jobs start disabled (enabled=false)
  - User/file-sourced cron jobs remain immediately active (unchanged behavior)
  - Approval messages sent to authorized user's DM (always, regardless of source thread)
  - Approve action enables job and computes next_run_at
  - Reject action deletes job from database
  - Both actions update inline message to show final state
metrics:
  duration_minutes: 19
  completed_date: "2026-02-17"
  tasks_completed: 2
  files_modified: 1
  commits: 2
  loc_added: 135
  loc_modified: 14
---

# Phase 24 Plan 02: Cron Job Approval Flow Summary

**One-liner:** User confirmation flow for agent-created cron jobs via InlineKeyboard approve/reject buttons, preventing autonomous job proliferation.

## Context

After implementing context-aware intent allowlists in 24-01, agent cron jobs could still be created in interactive contexts. This plan adds a human-in-the-loop approval step for agent-created jobs to prevent prompt injection attacks from creating self-replicating scheduled tasks.

## Changes Made

### Task 1: Create disabled cron jobs for agent source and send confirmation message

**Files modified:** `src/relay.ts`

1. **Added InlineKeyboard import** from grammy (line 13)
2. **Updated createCronJob signature** to accept `initialEnabled: boolean = true` parameter
   - Agent-created jobs pass `false` (disabled)
   - User/file-sourced jobs use default `true` (immediately active, unchanged)
3. **Modified job creation logic** to use `initialEnabled` instead of hardcoded `true`
4. **Conditional next_run_at computation** — only computed when job is initially enabled
5. **Added escapeMarkdown helper** for Telegram message formatting
6. **Added sendCronApprovalMessage function** to send approval request to authorized user
   - Constructs InlineKeyboard with Approve/Reject buttons
   - Sends to `ALLOWED_USER_ID` DM (always, regardless of source thread)
   - Includes job details: name, schedule, prompt (truncated to 200 chars)
7. **Updated CRON intent processing block** in processIntents()
   - Agent-created jobs call `createCronJob()` with `false` for `initialEnabled`
   - Logs `pending_approval: true` metadata in cron_created event
   - Calls `sendCronApprovalMessage()` after job creation

**Commit:** `43e2bfb` — feat(24-02): create disabled cron jobs for agent source with approval flow

### Task 2: Add callback query handler for approve/reject buttons

**Files modified:** `src/relay.ts`

1. **Registered callback_query:data handler** before bot.start() (line 3542)
2. **Auth check** — only ALLOWED_USER_ID can interact with approval buttons
3. **Approve action:**
   - Updates job: `enabled: true`
   - Fetches job data and computes `next_run_at`
   - Logs `cron_approved` event with job_id
   - Edits inline message to show "✅ Cron job approved and activated!"
   - Answers callback query with user feedback
4. **Reject action:**
   - Deletes job from cron_jobs table
   - Logs `cron_rejected` event with job_id
   - Edits inline message to show "❌ Cron job rejected and deleted."
   - Answers callback query with user feedback
5. **Error handling** for database failures (approval/rejection operations)

**Commit:** `247a138` — feat(24-02): add callback query handler for cron job approval/rejection

## Deviations from Plan

None — plan executed exactly as written.

## Verification Results

All verification checks passed:

1. ✅ `InlineKeyboard` import and usage present
2. ✅ `callback_query:data` handler registered before bot.start()
3. ✅ `initialEnabled` parameter added to createCronJob
4. ✅ Callback data patterns (`cron_approve`, `cron_reject`) and log events (`cron_approved`, `cron_rejected`) present
5. ✅ `sendCronApprovalMessage` function defined and called from CRON intent block
6. ✅ `/cron add` command unchanged — creates jobs with default `enabled: true`
7. ✅ `syncCronJobsFromFile()` unchanged — creates jobs with default `enabled: true`
8. ✅ TypeScript compilation successful (no syntax errors)

## Security Impact

**Closed attack vector:** Prompt injection can no longer create self-replicating cron jobs. Agent can propose jobs via `[CRON:]` intent, but they remain dormant until user approval.

**Unchanged behavior:**
- User-created jobs (`/cron add`) — immediately active
- File-sourced jobs (HEARTBEAT.md) — immediately active
- Only agent-created jobs require approval

## Observable Behavior

**Agent creates cron job:**
1. Agent includes `[CRON: schedule | prompt]` in response
2. Job inserted as `enabled: false`
3. User receives DM with approval message and inline keyboard
4. Job appears in `/cron list` as "⏸️ Paused"

**User approves:**
1. Presses "✅ Approve" button
2. Job enabled, next_run_at computed
3. Message updates to "✅ Cron job approved and activated!"
4. Job executes on schedule

**User rejects:**
1. Presses "❌ Reject" button
2. Job deleted from database
3. Message updates to "❌ Cron job rejected and deleted."

## Known Limitations

None identified.

## Follow-up Opportunities

- Add job preview (show what the job would do) before approval
- Bulk approval for multiple pending jobs
- Expiration for pending jobs (auto-reject after N days)
- Notification when pending jobs accumulate

## Self-Check

Verifying claimed changes exist:

**Files:**
- ✅ src/relay.ts modified (InlineKeyboard import, createCronJob signature, callback handler)

**Commits:**
- ✅ 43e2bfb: feat(24-02): create disabled cron jobs for agent source with approval flow
- ✅ 247a138: feat(24-02): add callback query handler for cron job approval/rejection

**Key code patterns:**
- ✅ `InlineKeyboard` imported and used
- ✅ `initialEnabled` parameter in createCronJob function signature
- ✅ `callback_query:data` handler registered before bot.start()
- ✅ `cron_approved` and `cron_rejected` log events
- ✅ `sendCronApprovalMessage` function exists

## Self-Check: PASSED

All claimed files, commits, and code patterns verified.

---

**Execution completed:** 2026-02-17
**Duration:** 19 minutes
**Commits:** 2 (43e2bfb, 247a138)
