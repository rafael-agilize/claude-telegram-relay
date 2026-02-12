---
phase: 11-agent-scheduling
plan: 01
type: execute
wave: 1
depends_on: ["09-cron-engine", "10-cron-management"]
files_modified:
  - src/relay.ts
  - CLAUDE.md
autonomous: true

must_haves:
  truths:
    - "Claude can create cron jobs via [CRON: <schedule> | <prompt>] intent tag in responses"
    - "Agent-created jobs are stored with source='agent' in the cron_jobs table"
    - "Claude receives instructions about the [CRON:] intent in buildPrompt() and buildHeartbeatPrompt()"
    - "Agent-created jobs execute identically to user-created jobs via the existing cron engine"
  artifacts:
    - path: "src/relay.ts"
      provides: "[CRON:] intent parsing in processIntents()"
      contains: "\\[CRON:"
    - path: "src/relay.ts"
      provides: "CRON intent documentation in buildPrompt()"
      contains: "[CRON:"
    - path: "CLAUDE.md"
      provides: "Updated documentation for agent scheduling intent"
      contains: "[CRON:"
  key_links:
    - from: "processIntents()"
      to: "createCronJob()"
      via: "[CRON:] tag parsed and job created with source='agent'"
      pattern: "cronMatches.*createCronJob"
    - from: "buildPrompt()"
      to: "processIntents()"
      via: "Prompt instructs Claude on CRON intent syntax; processIntents strips tag after creating job"
      pattern: "CRON.*schedule.*prompt"
---

<objective>
Add agent self-scheduling: Claude can create cron jobs by including `[CRON: <schedule> | <prompt>]` intent tags in its responses. Tags are parsed in processIntents(), jobs are stored with source='agent', and Claude is instructed about this capability in the system prompt.

Purpose: This completes the proactive agent loop — Claude can not only respond to scheduled tasks but also create new ones autonomously (reminders, follow-ups, periodic checks).

Output: [CRON:] intent parsing in processIntents() + prompt instructions in buildPrompt() and buildHeartbeatPrompt().
</objective>

<execution_context>
@./.claude/get-shit-done/workflows/execute-plan.md
@./.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/10-cron-management/PLAN.md
@src/relay.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add [CRON:] intent parsing to processIntents()</name>
  <files>src/relay.ts</files>
  <action>
Add `[CRON: <schedule> | <prompt>]` tag parsing to the `processIntents()` function (currently at line 1369).

The new parsing block goes AFTER the existing `[FORGET:]` block and BEFORE the final `return clean.trim()`.

**Add this block after the FORGET matches loop (after line 1395):**

```typescript
  // [CRON: schedule | prompt] — agent self-scheduling
  const cronMatches = response.matchAll(/\[CRON:\s*(.+?)\s*\|\s*(.+?)\]/gi);
  for (const match of cronMatches) {
    const schedule = match[1].trim();
    const prompt = match[2].trim();

    if (schedule.length > 0 && prompt.length > 0 && prompt.length <= 500) {
      const scheduleType = detectScheduleType(schedule);
      if (scheduleType) {
        const name = prompt.split(/\s+/).slice(0, 4).join(" ");
        const job = await createCronJob(name, schedule, scheduleType, prompt, threadDbId || undefined, "agent");
        if (job) {
          console.log(`[Agent] Created cron job: "${name}" (${schedule})`);
          await logEventV2("cron_created", `Agent created cron job: ${name}`, {
            job_id: job.id,
            schedule,
            schedule_type: scheduleType,
            prompt: prompt.substring(0, 100),
            source: "agent",
          }, threadDbId);
        }
      } else {
        console.warn(`[Agent] Invalid schedule in CRON intent: "${schedule}"`);
      }
    } else {
      console.warn(`[Agent] Rejected CRON intent: schedule="${schedule}" prompt length=${prompt.length}`);
    }
    clean = clean.replace(match[0], "");
  }
```

**Key implementation details:**
- Regex: `\[CRON:\s*(.+?)\s*\|\s*(.+?)\]` — captures schedule and prompt separated by `|`
- Uses existing `detectScheduleType()` to validate schedule format (cron/interval/once)
- Uses existing `createCronJob()` with `source = 'agent'`
- Target thread is set to the current thread context (threadDbId) so the cron result goes to the thread where Claude created it
- Prompt length capped at 500 chars (generous but prevents abuse)
- Tag is stripped from the response before delivery (same as LEARN/FORGET)
- Logs `cron_created` event with `source: "agent"` metadata
  </action>
  <verify>
1. grep for `\[CRON:` in the processIntents function in relay.ts
2. grep for `cronMatches` in relay.ts returns the variable
3. grep for `source.*agent` in relay.ts confirms agent source is used
4. grep for `Agent.*Created cron job` in relay.ts confirms the console log
5. `bun run start` does not crash (syntax check)
  </verify>
  <done>
[CRON:] intent parsing added to processIntents(). Agent can create cron jobs via tags in responses. Jobs are stored with source='agent', targeted to the current thread, and the tag is stripped before delivery.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add CRON intent instructions to buildPrompt() and buildHeartbeatPrompt()</name>
  <files>src/relay.ts</files>
  <action>
Update both prompt builders to instruct Claude about the [CRON:] intent capability.

**Change 1: Update buildPrompt() — MEMORY INSTRUCTIONS section**

In `buildPrompt()` (around line 2297), find the MEMORY INSTRUCTIONS block and add the CRON intent after the VOICE_REPLY line.

Find:
```typescript
  prompt += `

MEMORY INSTRUCTIONS:
You can automatically learn and remember facts about the user. When you notice something worth remembering (preferences, name, job, habits, important dates, etc.), include this tag in your response — it will be saved and removed before delivery:

[LEARN: concise fact about the user]

Keep learned facts very concise (under 15 words each). Only learn genuinely useful things.

To remove an outdated or wrong fact:
[FORGET: search text matching the fact to remove]

To trigger a voice reply:
[VOICE_REPLY]

User: ${userMessage}`;
```

Replace with:
```typescript
  prompt += `

MEMORY INSTRUCTIONS:
You can automatically learn and remember facts about the user. When you notice something worth remembering (preferences, name, job, habits, important dates, etc.), include this tag in your response — it will be saved and removed before delivery:

[LEARN: concise fact about the user]

Keep learned facts very concise (under 15 words each). Only learn genuinely useful things.

To remove an outdated or wrong fact:
[FORGET: search text matching the fact to remove]

To trigger a voice reply:
[VOICE_REPLY]

SCHEDULING:
You can create scheduled tasks that will run automatically. Include this tag in your response:

[CRON: <schedule> | <prompt>]

Schedule formats:
- Cron: "0 9 * * *" (5-field, e.g., daily at 9am)
- Interval: "every 2h" or "every 30m" (recurring)
- One-shot: "in 20m" or "in 1h" (runs once then auto-disables)

Examples:
[CRON: 0 9 * * 1 | check project deadlines and report status]
[CRON: every 4h | check if user has any pending reminders]
[CRON: in 30m | remind user about the meeting]

Use this when the user asks you to remind them of something, schedule periodic checks, or when you identify something that should be monitored regularly. The tag will be removed before delivery.

User: ${userMessage}`;
```

**Change 2: Update buildHeartbeatPrompt() — heartbeat instructions**

In `buildHeartbeatPrompt()` (around line 1265), find the heartbeat intent instructions and add the CRON intent.

Find:
```typescript
  prompt += `

HEARTBEAT INSTRUCTIONS:
You are performing a periodic check-in. Review the checklist above and check on the items listed.

If everything is fine and there's nothing noteworthy to report, respond with ONLY:
HEARTBEAT_OK

If there IS something worth reporting (something changed, something needs attention, a reminder is due, etc.), write a concise message to the user about what you found. Keep it brief and actionable.

You may use these tags in your response:
[LEARN: concise fact about the user] — save a fact (under 15 words)
[FORGET: search text matching the fact to remove] — remove a previously learned fact

Do NOT use [VOICE_REPLY] in heartbeat responses.`;
```

Replace with:
```typescript
  prompt += `

HEARTBEAT INSTRUCTIONS:
You are performing a periodic check-in. Review the checklist above and check on the items listed.

If everything is fine and there's nothing noteworthy to report, respond with ONLY:
HEARTBEAT_OK

If there IS something worth reporting (something changed, something needs attention, a reminder is due, etc.), write a concise message to the user about what you found. Keep it brief and actionable.

You may use these tags in your response:
[LEARN: concise fact about the user] — save a fact (under 15 words)
[FORGET: search text matching the fact to remove] — remove a previously learned fact
[CRON: <schedule> | <prompt>] — schedule a follow-up task (e.g., [CRON: in 1h | re-check deployment status])

Do NOT use [VOICE_REPLY] in heartbeat responses.`;
```

**Implementation notes:**
- buildPrompt() gets the full SCHEDULING section with examples and use cases — this is the main prompt Claude sees for regular interactions
- buildHeartbeatPrompt() gets a compact one-line mention — heartbeat context is already large, keep it brief
- Both prompt changes document the same `[CRON: schedule | prompt]` syntax
- The CRON tag in heartbeat is useful for follow-ups (e.g., "deployment failed, will check again in 1h")
  </action>
  <verify>
1. grep for "SCHEDULING:" in relay.ts confirms the new section exists in buildPrompt
2. grep for "CRON.*schedule.*prompt" in the buildPrompt function
3. grep for "\[CRON:" in buildHeartbeatPrompt section
4. grep for "schedule a follow-up" in relay.ts confirms heartbeat CRON instruction
5. `bun run start` does not crash
  </verify>
  <done>
Both buildPrompt() and buildHeartbeatPrompt() now instruct Claude about the [CRON:] intent. Regular prompt includes full documentation with schedule formats and examples. Heartbeat prompt includes a compact one-liner for follow-up scheduling.
  </done>
</task>

<task type="auto">
  <name>Task 3: Update CLAUDE.md with agent scheduling documentation</name>
  <files>CLAUDE.md</files>
  <action>
Update CLAUDE.md to document the agent scheduling feature.

**Change 1:** In the "Intent system" bullet under "Key sections in relay.ts", add the CRON intent:

Find:
```
  - `[LEARN: fact]` → inserts into `global_memory` table
  - `[FORGET: search text]` → deletes matching fact from `global_memory`
  - `[VOICE_REPLY]` → triggers ElevenLabs TTS for the response
```

Replace with:
```
  - `[LEARN: fact]` → inserts into `global_memory` table
  - `[FORGET: search text]` → deletes matching fact from `global_memory`
  - `[VOICE_REPLY]` → triggers ElevenLabs TTS for the response
  - `[CRON: schedule | prompt]` → creates a scheduled cron job with source='agent'
```

**Change 2:** In the "Intent system" line under "Architecture", add CRON:

Find:
```
- Intent system: [LEARN:], [FORGET:], [VOICE_REPLY] parsed in processIntents()
```

Replace with:
```
- Intent system: [LEARN:], [FORGET:], [VOICE_REPLY], [CRON:] parsed in processIntents()
```
  </action>
  <verify>
1. grep for "\[CRON:.*schedule.*prompt\]" in CLAUDE.md confirms the intent documentation
2. grep for "source='agent'" in CLAUDE.md confirms the source marker documentation
3. grep for "\[CRON:\]" in the Architecture section of CLAUDE.md
  </verify>
  <done>
CLAUDE.md documents the [CRON:] intent tag in both the intent system overview and the key sections detail.
  </done>
</task>

</tasks>

<verification>
1. When Claude includes `[CRON: 0 9 * * * | check project status]` in a response, a cron job is created in the database with source='agent'
2. Agent-created jobs have `source='agent'` field distinguishing them from user-created (source='user') and file-created (source='file')
3. Agent-created jobs execute via the existing cron engine identically to user-created jobs
4. The [CRON:] tag is stripped from the response before delivery to the user
5. buildPrompt() includes SCHEDULING section with CRON intent syntax, schedule formats, and examples
6. buildHeartbeatPrompt() includes a one-line CRON intent mention for follow-up scheduling
7. Invalid schedules in CRON intent are logged and silently ignored (no crash)
8. Prompt length over 500 chars in CRON intent is rejected (security guard)
9. `bun run start` boots without errors
10. CLAUDE.md documents the [CRON:] intent in both Architecture and Key sections
</verification>

<success_criteria>
- When Claude includes `[CRON: 0 9 * * * | check project status]` in response, job is created in database
- Agent-created jobs have `source='agent'` field to distinguish from user-created
- Agent-created jobs execute identically to user-created jobs
- System prompt includes instructions on CRON intent syntax and use cases
</success_criteria>

<output>
After completion, create `.planning/phases/11-agent-scheduling/11-agent-scheduling-SUMMARY.md`
</output>
