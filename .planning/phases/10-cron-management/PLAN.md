---
phase: 10-cron-management
plan: 01
type: execute
wave: 1
depends_on: ["09-cron-engine"]
files_modified:
  - src/relay.ts
  - CLAUDE.md
  - supabase/migrations/20260212_2_add_file_source.sql
autonomous: true

must_haves:
  truths:
    - "User can add cron jobs via /cron add command with quoted schedule and prompt"
    - "User can list all cron jobs via /cron list with numbered output"
    - "User can remove cron jobs via /cron remove <number> using the list position"
    - "HEARTBEAT.md can contain a ## Cron Jobs section that syncs jobs to the database (CMGMT-04 cron side; heartbeat side already covered by Phase 7 — HEARTBEAT.md is read on each heartbeat cycle)"
  artifacts:
    - path: "src/relay.ts"
      provides: "/cron command handler with add/list/remove subcommands"
      contains: 'bot.command("cron"'
    - path: "src/relay.ts"
      provides: "HEARTBEAT.md cron job parsing and sync"
      contains: "parseCronJobsFromChecklist"
    - path: "CLAUDE.md"
      provides: "Updated documentation for cron management commands"
      contains: "/cron add"
    - path: "supabase/migrations/20260212_2_add_file_source.sql"
      provides: "Migration to add 'file' to cron_jobs source CHECK constraint"
      contains: "source IN"
  key_links:
    - from: 'bot.command("cron")'
      to: "supabase.from('cron_jobs').insert()"
      via: "/cron add inserts new job into database"
      pattern: "cron_jobs.*insert"
    - from: 'bot.command("cron")'
      to: "supabase.from('cron_jobs').select()"
      via: "/cron list queries all jobs"
      pattern: "cron_jobs.*select"
    - from: 'bot.command("cron")'
      to: "supabase.from('cron_jobs').delete() or .update({ enabled: false })"
      via: "/cron remove disables job by ID"
      pattern: "cron_jobs.*(delete|enabled.*false)"
    - from: "heartbeatTick()"
      to: "syncCronJobsFromFile()"
      via: "Heartbeat reads HEARTBEAT.md and syncs cron definitions"
      pattern: "syncCronJobsFromFile"
---

<objective>
Add user-facing cron management: Telegram commands (/cron add, /cron list, /cron remove) and file-based cron definitions in HEARTBEAT.md.

Purpose: The cron engine (Phase 9) can execute jobs, but users have no way to create, view, or remove them from Telegram. This phase closes that gap.

Output: Three /cron subcommands registered in relay.ts + HEARTBEAT.md cron sync on heartbeat tick.
</objective>

<execution_context>
@./.claude/get-shit-done/workflows/execute-plan.md
@./.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/09-cron-engine/09-01-PLAN.md
@src/relay.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add /cron command with add/list/remove subcommands</name>
  <files>src/relay.ts</files>
  <action>
Add a new bot command handler for `/cron` in the COMMANDS section of relay.ts (after the `/memory` command, around line 1696).

**Step 0: Update CronJob interface to support 'file' source**

In the `CronJob` interface (around line 485), update the `source` field to include `'file'`:

Find:
```typescript
  source: 'user' | 'agent';
```

Replace with:
```typescript
  source: 'user' | 'agent' | 'file';
```

**Supabase helpers needed first (add in the Supabase v2.1 section, after `disableCronJob()`):**

**Function: `detectScheduleType(schedule: string): 'cron' | 'interval' | 'once' | null`**
Determines the schedule type from a user-provided string:
- If starts with "every" → `'interval'`
- If starts with "in" → `'once'`
- If matches 5-field cron pattern (5 space-separated tokens where each is `*` or a number or a range) → `'cron'`
- Otherwise → `null` (invalid)

```typescript
function detectScheduleType(schedule: string): 'cron' | 'interval' | 'once' | null {
  const trimmed = schedule.trim().toLowerCase();
  if (trimmed.startsWith("every ")) return "interval";
  if (trimmed.startsWith("in ")) return "once";
  // Check for 5-field cron expression
  const fields = trimmed.split(/\s+/);
  if (fields.length === 5 && fields.every(f => /^[\d\*\/\-,]+$/.test(f))) return "cron";
  return null;
}
```

**Function: `createCronJob(name, schedule, scheduleType, prompt, targetThreadId?, source?): Promise<CronJob | null>`**
Inserts a new cron job into Supabase and computes initial next_run_at:

```typescript
async function createCronJob(
  name: string,
  schedule: string,
  scheduleType: 'cron' | 'interval' | 'once',
  prompt: string,
  targetThreadId?: string,
  source: 'user' | 'agent' | 'file' = 'user'
): Promise<CronJob | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("cron_jobs")
      .insert({
        name,
        schedule,
        schedule_type: scheduleType,
        prompt,
        target_thread_id: targetThreadId || null,
        enabled: true,
        source,
      })
      .select()
      .single();

    if (error) {
      console.error("createCronJob error:", error);
      return null;
    }

    // Compute initial next_run_at
    const job = data as CronJob;
    const nextRun = computeNextRun(job);
    if (nextRun) {
      await supabase
        .from("cron_jobs")
        .update({ next_run_at: nextRun })
        .eq("id", job.id);
    }

    return job;
  } catch (e) {
    console.error("createCronJob error:", e);
    return null;
  }
}
```

**Function: `getAllCronJobs(): Promise<CronJob[]>`**
Returns ALL cron jobs (not just enabled) for listing:

```typescript
async function getAllCronJobs(): Promise<CronJob[]> {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("cron_jobs")
      .select("*")
      .order("created_at", { ascending: true });
    return (data || []) as CronJob[];
  } catch (e) {
    console.error("getAllCronJobs error:", e);
    return [];
  }
}
```

**Function: `deleteCronJob(jobId: string): Promise<boolean>`**
Hard-deletes a cron job from the database:

```typescript
async function deleteCronJob(jobId: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase
      .from("cron_jobs")
      .delete()
      .eq("id", jobId);
    return !error;
  } catch (e) {
    console.error("deleteCronJob error:", e);
    return false;
  }
}
```

**Now the /cron command handler:**

```typescript
// /cron command: manage scheduled jobs
bot.command("cron", async (ctx) => {
  const args = (ctx.match || "").trim();

  // /cron list (or just /cron with no args)
  if (!args || args === "list") {
    const jobs = await getAllCronJobs();
    if (jobs.length === 0) {
      await ctx.reply("No cron jobs found.\n\nUsage: /cron add \"<schedule>\" <prompt>");
      return;
    }

    let text = `<b>Cron Jobs (${jobs.length})</b>\n\n`;
    jobs.forEach((job, i) => {
      const status = job.enabled ? "✅" : "⏸";
      const nextRun = job.next_run_at
        ? new Date(job.next_run_at).toLocaleString("en-US", {
            timeZone: "America/Sao_Paulo",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "—";
      text += `${status} <b>${i + 1}.</b> <code>${job.schedule}</code> (${job.schedule_type})\n`;
      text += `   ${job.prompt.substring(0, 80)}${job.prompt.length > 80 ? "..." : ""}\n`;
      text += `   Next: ${nextRun} · Source: ${job.source}\n\n`;
    });

    text += `Remove: /cron remove <number>\nAdd: /cron add "<schedule>" <prompt>`;

    try {
      await ctx.reply(text, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(text.replace(/<[^>]*>/g, ""));
    }
    return;
  }

  // /cron add "<schedule>" <prompt>
  if (args.startsWith("add ")) {
    const addArgs = args.substring(4).trim();

    // Parse: "schedule" prompt
    const match = addArgs.match(/^"([^"]+)"\s+(.+)$/s);
    if (!match) {
      await ctx.reply(
        'Usage: /cron add "<schedule>" <prompt>\n\n' +
        'Examples:\n' +
        '/cron add "0 7 * * *" morning briefing\n' +
        '/cron add "every 2h" check project status\n' +
        '/cron add "in 20m" remind me to call John'
      );
      return;
    }

    const schedule = match[1].trim();
    const prompt = match[2].trim();

    const scheduleType = detectScheduleType(schedule);
    if (!scheduleType) {
      await ctx.reply(
        `Invalid schedule: "${schedule}"\n\n` +
        "Supported formats:\n" +
        "• Cron: 0 7 * * * (5-field)\n" +
        "• Interval: every 2h, every 30m, every 1h30m\n" +
        "• One-shot: in 20m, in 1h, in 2h30m"
      );
      return;
    }

    // Auto-generate name from first 4 words of prompt
    const name = prompt.split(/\s+/).slice(0, 4).join(" ");

    // Target thread: use current thread if in a topic, null for DM
    const targetThreadId = ctx.threadInfo?.dbId || undefined;

    const job = await createCronJob(name, schedule, scheduleType, prompt, targetThreadId);
    if (job) {
      const nextRun = computeNextRun(job);
      const nextRunStr = nextRun
        ? new Date(nextRun).toLocaleString("en-US", {
            timeZone: "America/Sao_Paulo",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "computing...";

      await logEventV2("cron_created", `Cron job created: ${name}`, {
        job_id: job.id,
        schedule,
        schedule_type: scheduleType,
        prompt: prompt.substring(0, 100),
      }, ctx.threadInfo?.dbId);

      await ctx.reply(
        `✅ Cron job created!\n\n` +
        `Schedule: ${schedule} (${scheduleType})\n` +
        `Prompt: ${prompt}\n` +
        `Next run: ${nextRunStr}`
      );
    } else {
      await ctx.reply("Failed to create cron job. Check Supabase connection.");
    }
    return;
  }

  // /cron remove <number>
  if (args.startsWith("remove ") || args.startsWith("rm ") || args.startsWith("delete ")) {
    const numStr = args.split(/\s+/)[1];
    const num = parseInt(numStr);
    if (isNaN(num) || num < 1) {
      await ctx.reply("Usage: /cron remove <number>\n\nUse /cron list to see job numbers.");
      return;
    }

    // Fetch all jobs and find by position
    const jobs = await getAllCronJobs();
    if (num > jobs.length) {
      await ctx.reply(`No job #${num}. You have ${jobs.length} job(s). Use /cron list to see them.`);
      return;
    }

    const job = jobs[num - 1];
    const deleted = await deleteCronJob(job.id);
    if (deleted) {
      await logEventV2("cron_deleted", `Cron job deleted: ${job.name}`, {
        job_id: job.id,
        schedule: job.schedule,
      }, ctx.threadInfo?.dbId);

      await ctx.reply(`🗑 Removed job #${num}: "${job.name}" (${job.schedule})`);
    } else {
      await ctx.reply("Failed to remove cron job. Check Supabase connection.");
    }
    return;
  }

  // /cron enable <number> / /cron disable <number>
  if (args.startsWith("enable ") || args.startsWith("disable ")) {
    const parts = args.split(/\s+/);
    const action = parts[0];
    const num = parseInt(parts[1]);
    if (isNaN(num) || num < 1) {
      await ctx.reply(`Usage: /cron ${action} <number>`);
      return;
    }

    const jobs = await getAllCronJobs();
    if (num > jobs.length) {
      await ctx.reply(`No job #${num}. You have ${jobs.length} job(s).`);
      return;
    }

    const job = jobs[num - 1];
    const newEnabled = action === "enable";

    if (!supabase) {
      await ctx.reply("Supabase not connected.");
      return;
    }

    await supabase
      .from("cron_jobs")
      .update({ enabled: newEnabled, updated_at: new Date().toISOString() })
      .eq("id", job.id);

    const emoji = newEnabled ? "▶️" : "⏸";
    await ctx.reply(`${emoji} Job #${num} "${job.name}" ${newEnabled ? "enabled" : "disabled"}.`);
    return;
  }

  // Unknown subcommand
  await ctx.reply(
    "Usage:\n" +
    '/cron add "<schedule>" <prompt>\n' +
    "/cron list\n" +
    "/cron remove <number>\n" +
    "/cron enable <number>\n" +
    "/cron disable <number>"
  );
});
```

**Key implementation notes:**
- Schedule is quoted to handle spaces in cron expressions: `"0 7 * * *"`
- Job names are auto-generated from the first 4 words of the prompt
- Remove/enable/disable use position numbers from the list (not UUIDs) for usability
- Target thread is set to the current thread context (so cron results go to the thread where the job was created)
- `cron_created` and `cron_deleted` log events added for observability
- Enable/disable is a bonus subcommand beyond the requirements but trivial and useful
  </action>
  <verify>
1. grep for `bot.command("cron"` in relay.ts returns the handler
2. grep for `detectScheduleType` in relay.ts returns the function
3. grep for `createCronJob` in relay.ts returns the function
4. grep for `getAllCronJobs` in relay.ts returns the function
5. grep for `deleteCronJob` in relay.ts returns the function
6. grep for `cron_created` in relay.ts confirms logging on job creation
7. grep for `cron_deleted` in relay.ts confirms logging on job deletion
8. `bun run start` does not crash (syntax check)
  </verify>
  <done>
/cron command handles add, list, remove, enable, disable subcommands. Schedule detection auto-classifies cron/interval/once types. Jobs are stored in Supabase with initial next_run_at computed. List shows numbered output for easy remove/enable/disable by position.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add HEARTBEAT.md cron job parsing and sync</name>
  <files>src/relay.ts</files>
  <action>
Add a function to parse cron job definitions from HEARTBEAT.md and sync them to the database. This runs on each heartbeat tick.

**Step 1: Add parsing and sync functions**

Add these functions in the Heartbeat section of relay.ts, AFTER `readHeartbeatChecklist()` (around line 980):

**Function: `parseCronJobsFromChecklist(checklist: string): Array<{ schedule: string; scheduleType: 'cron' | 'interval' | 'once'; prompt: string }>`**

Parses a `## Cron Jobs` or `## Cron` section from HEARTBEAT.md. Each line in that section that starts with `- ` is a cron definition.

Format: `- "<schedule>" <prompt>` (same format as `/cron add`)

```typescript
function parseCronJobsFromChecklist(
  checklist: string
): Array<{ schedule: string; scheduleType: 'cron' | 'interval' | 'once'; prompt: string }> {
  const results: Array<{ schedule: string; scheduleType: 'cron' | 'interval' | 'once'; prompt: string }> = [];

  // Find the ## Cron Jobs or ## Cron section
  const sectionMatch = checklist.match(/^##\s+Cron(?:\s+Jobs)?\s*\n([\s\S]*?)(?=\n##\s|\n---|$)/mi);
  if (!sectionMatch) return results;

  const section = sectionMatch[1];
  const lines = section.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;

    // Parse: - "schedule" prompt
    const match = trimmed.match(/^-\s+"([^"]+)"\s+(.+)$/);
    if (!match) continue;

    const schedule = match[1].trim();
    const prompt = match[2].trim();

    const scheduleType = detectScheduleType(schedule);
    if (!scheduleType) continue;

    results.push({ schedule, scheduleType, prompt });
  }

  return results;
}
```

**Function: `syncCronJobsFromFile(checklist: string): Promise<void>`**

Syncs cron jobs defined in HEARTBEAT.md to the database. Uses `source = 'file'` to distinguish file-defined jobs from user-created or agent-created ones.

Logic:
1. Parse cron definitions from checklist
2. Get all existing file-sourced jobs from database
3. For each definition: if no matching job exists (by prompt), create it
4. For existing file-sourced jobs not in the file: disable them
5. For existing file-sourced jobs in the file with changed schedule: update them

```typescript
async function syncCronJobsFromFile(checklist: string): Promise<void> {
  if (!supabase) return;

  const definitions = parseCronJobsFromChecklist(checklist);
  if (definitions.length === 0) return;

  try {
    // Get existing file-sourced jobs
    const { data: existingJobs } = await supabase
      .from("cron_jobs")
      .select("*")
      .eq("source", "file");

    const existing = (existingJobs || []) as CronJob[];

    // Track which existing jobs are still in the file
    const matchedIds = new Set<string>();

    for (const def of definitions) {
      // Find existing job by prompt (exact match)
      const match = existing.find(j => j.prompt === def.prompt);

      if (match) {
        matchedIds.add(match.id);

        // Update schedule if changed
        if (match.schedule !== def.schedule || match.schedule_type !== def.scheduleType || !match.enabled) {
          const updatedJob = { ...match, schedule: def.schedule, schedule_type: def.scheduleType };
          const nextRun = computeNextRun(updatedJob as CronJob);
          await supabase
            .from("cron_jobs")
            .update({
              schedule: def.schedule,
              schedule_type: def.scheduleType,
              enabled: true,
              next_run_at: nextRun,
              updated_at: new Date().toISOString(),
            })
            .eq("id", match.id);
          console.log(`[Cron] File sync: updated job "${match.name}" schedule to ${def.schedule}`);
        }
      } else {
        // Create new job
        const name = def.prompt.split(/\s+/).slice(0, 4).join(" ");
        const job = await createCronJob(name, def.schedule, def.scheduleType, def.prompt, undefined, "file");
        if (job) {
          console.log(`[Cron] File sync: created job "${name}" (${def.schedule})`);
        }
      }
    }

    // Disable file-sourced jobs that are no longer in the file
    for (const job of existing) {
      if (!matchedIds.has(job.id) && job.enabled) {
        await disableCronJob(job.id);
        console.log(`[Cron] File sync: disabled removed job "${job.name}"`);
      }
    }
  } catch (e) {
    console.error("[Cron] File sync error:", e);
  }
}
```

**Step 2: Update the `source` CHECK constraint**

The existing schema has `CHECK (source IN ('user', 'agent'))`. Add `'file'` as a valid source via a new migration.

Create migration: `supabase/migrations/20260212_2_add_file_source.sql`

```sql
-- Add 'file' as valid source for cron jobs (HEARTBEAT.md sync)
ALTER TABLE cron_jobs DROP CONSTRAINT IF EXISTS cron_jobs_source_check;
ALTER TABLE cron_jobs ADD CONSTRAINT cron_jobs_source_check
  CHECK (source IN ('user', 'agent', 'file'));
```

**Step 3: Integrate sync into heartbeat tick**

In the `heartbeatTick()` function, AFTER reading the checklist and BEFORE building the heartbeat prompt, add the sync call:

Find (around line 889-894):
```typescript
    // Step 1: Read HEARTBEAT.md checklist
    const checklist = await readHeartbeatChecklist();
    if (!checklist) {
      console.log("Heartbeat: no HEARTBEAT.md found, skipping");
      await logEventV2("heartbeat_skip", "No HEARTBEAT.md file found");
      return;
    }
```

Add AFTER this block (before Step 2):
```typescript
    // Step 1.5: Sync cron jobs defined in HEARTBEAT.md
    await syncCronJobsFromFile(checklist);
```

**Implementation notes:**
- File-sourced jobs use `source = 'file'` to distinguish from user-created and agent-created
- Sync is idempotent: running it multiple times with the same file produces the same DB state
- Jobs matched by exact prompt text — if user changes the prompt, a new job is created
- Jobs removed from the file are disabled (not deleted), preserving execution history
- Sync runs on every heartbeat tick (typically every 60 min), which is fine for file-based config
  </action>
  <verify>
1. grep for `parseCronJobsFromChecklist` in relay.ts returns the function
2. grep for `syncCronJobsFromFile` in relay.ts returns the function
3. grep for `source.*file` in relay.ts confirms file-sourced jobs
4. grep for `Step 1.5` or `syncCronJobsFromFile` in heartbeatTick confirms integration
5. New migration file exists at supabase/migrations/20260212_2_add_file_source.sql
6. `bun run start` does not crash
  </verify>
  <done>
HEARTBEAT.md cron parsing and sync is implemented. Jobs defined in a `## Cron Jobs` section (format: `- "schedule" prompt`) are synced to the database on each heartbeat tick. New jobs are created, changed schedules are updated, removed jobs are disabled. Uses source='file' to distinguish from user/agent jobs.
  </done>
</task>

<task type="auto">
  <name>Task 3: Update CLAUDE.md with cron management documentation</name>
  <files>CLAUDE.md</files>
  <action>
Update CLAUDE.md to document the cron management features added in Tasks 1 and 2.

**Change 1:** In the "Bot commands" section, add cron commands after the `/memory` line:

Find:
```
- `/memory` — Show all learned facts about the user
```

Add after:
```
- `/cron list` — Show all scheduled cron jobs with status
- `/cron add "<schedule>" <prompt>` — Create a new cron job (schedule types: cron "0 7 * * *", interval "every 2h", one-shot "in 20m")
- `/cron remove <number>` — Remove a cron job by its list number
- `/cron enable <number>` / `/cron disable <number>` — Toggle a cron job on/off
```

**Change 2:** In the "Heartbeat" section, update the HEARTBEAT.md description:

Find:
```
- `HEARTBEAT.md` — Checklist file in project root; Claude reads it on each heartbeat cycle and reports noteworthy items
```

Replace with:
```
- `HEARTBEAT.md` — Checklist file in project root; Claude reads it on each heartbeat cycle and reports noteworthy items. Can also contain a `## Cron Jobs` section to define cron jobs declaratively (synced to database on each heartbeat)
```

**Change 3:** In the "Key sections in relay.ts" area, after the cron scheduler engine bullet, add:

```
- **Cron management** — `/cron` command handler (add/list/remove/enable/disable), `detectScheduleType()`, `createCronJob()`, `getAllCronJobs()`, `deleteCronJob()`
- **HEARTBEAT.md cron sync** — `parseCronJobsFromChecklist()`, `syncCronJobsFromFile()` — file-based cron definitions synced on each heartbeat tick
```

**Change 4:** In the "Heartbeat & cron events" bullet, add new event types:

Find:
```
`cron_executed`, `cron_delivered`, `cron_error`, `bot_stopping`
```

Replace with:
```
`cron_created`, `cron_deleted`, `cron_executed`, `cron_delivered`, `cron_error`, `bot_stopping`
```

**Change 5:** In the Supabase Schema section, update the cron_jobs description:

Find:
```
- `cron_jobs` — Scheduled jobs (name, schedule, prompt, target thread, source)
```

Replace with:
```
- `cron_jobs` — Scheduled jobs (name, schedule, prompt, target thread, source: user/agent/file)
```

**Change 6:** Add the new migration to the Migrations list:

After the existing migration lines, add:
```
- `supabase/migrations/20260212_2_add_file_source.sql` (v2.2: add 'file' source for cron jobs)
```
  </action>
  <verify>
1. grep for "/cron add" in CLAUDE.md returns the command documentation
2. grep for "/cron list" in CLAUDE.md returns the command documentation
3. grep for "/cron remove" in CLAUDE.md returns the command documentation
4. grep for "parseCronJobsFromChecklist" in CLAUDE.md returns the key sections bullet
5. grep for "cron_created" in CLAUDE.md confirms updated event types
6. grep for "user/agent/file" in CLAUDE.md confirms updated source description
  </verify>
  <done>
CLAUDE.md documents all cron management commands, HEARTBEAT.md cron sync, new event types, and updated source field values.
  </done>
</task>

</tasks>

<verification>
1. `/cron list` returns all cron jobs with numbered output, schedule, prompt, and next run time
2. `/cron add "0 7 * * *" morning briefing` creates an enabled cron job with schedule_type='cron'
3. `/cron add "every 2h" check project status` creates a job with schedule_type='interval'
4. `/cron add "in 20m" remind me` creates a job with schedule_type='once'
5. `/cron remove 1` deletes the first job and confirms to user
6. `/cron enable 1` and `/cron disable 1` toggle job status
7. HEARTBEAT.md with `## Cron Jobs` section containing `- "0 9 * * *" daily check` creates a job with source='file' on next heartbeat tick
8. Removing a cron line from HEARTBEAT.md disables the corresponding file-sourced job on next heartbeat tick
9. `bun run start` boots without errors
10. CLAUDE.md documents all new commands and features
</verification>

<success_criteria>
- `/cron add "0 7 * * *" "morning briefing"` creates a new enabled job in database
- `/cron list` returns all cron jobs with id, schedule, prompt, enabled status
- `/cron remove 3` deletes job #3 from the list and confirms to user
- HEARTBEAT.md file can include cron job definitions that are parsed and synced to database
- All three schedule types (cron, interval, once) are correctly detected and stored
- File-sourced jobs are distinguished from user/agent jobs via source='file'
</success_criteria>

<output>
After completion, create `.planning/phases/10-cron-management/10-cron-management-SUMMARY.md`
</output>
