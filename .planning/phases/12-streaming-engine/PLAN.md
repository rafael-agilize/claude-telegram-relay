---
phase: 12-streaming-engine
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/relay.ts
  - CLAUDE.md
autonomous: true

must_haves:
  truths:
    - "callClaude() uses --output-format stream-json --verbose instead of --output-format json"
    - "Stdout is parsed as NDJSON (one JSON object per line) with a line buffer for partial chunks"
    - "Inactivity timer resets on every NDJSON line parsed from stdout (not stderr-only)"
    - "Inactivity timeout is 15 minutes (up from 5 minutes)"
    - "Session ID extracted from system/init event's session_id field"
    - "Final result text extracted from result event's result field"
    - "Orphan process cleanup still triggers on timeout"
    - "Session retry logic (--resume failure → fresh start) still works"
    - "All callers (handlers, heartbeat, cron, summary) work unchanged — same return signature"
  artifacts:
    - path: "src/relay.ts"
      provides: "stream-json output format in callClaude()"
      contains: "stream-json"
    - path: "src/relay.ts"
      provides: "15 minute inactivity timeout"
      contains: "15 \\* 60 \\* 1000"
    - path: "src/relay.ts"
      provides: "NDJSON line-by-line parsing"
      contains: "buffer.split"
    - path: "src/relay.ts"
      provides: "result event parsing"
      contains: "type.*result"
    - path: "CLAUDE.md"
      provides: "Updated documentation for streaming internals"
      contains: "stream-json"
  key_links:
    - from: "callClaude() args"
      to: "Claude CLI"
      via: "--output-format stream-json --verbose flags"
      pattern: "stream-json.*verbose"
    - from: "NDJSON parser"
      to: "resetInactivityTimer()"
      via: "Every parsed line resets the timer"
      pattern: "resetInactivityTimer"
    - from: "result event"
      to: "return value"
      via: "result.result becomes text, result.session_id becomes sessionId"
      pattern: "resultText.*event\\.result"
---

<objective>
Refactor `callClaude()` to use streaming NDJSON output instead of buffered JSON. Switch from `--output-format json` to `--output-format stream-json --verbose`, parse stdout line-by-line, reset the inactivity timer on every event, extract session ID from `system/init` and final text from `result` event. Increase timeout from 5 to 15 minutes.

Purpose: Enables activity-based timeout that won't kill healthy long-running tasks, and prepares the infrastructure for Phase 13 (typing indicators and progress messages).

Output: A working relay that behaves identically to before from the user's perspective, but with streaming internals that properly detect activity.
</objective>

<execution_context>
@./.claude/get-shit-done/workflows/execute-plan.md
@./.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/12-streaming-engine/12-RESEARCH.md
@src/relay.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Increase inactivity timeout to 15 minutes</name>
  <files>src/relay.ts</files>
  <action>
Update the `CLAUDE_INACTIVITY_TIMEOUT_MS` constant at line 70.

Find:
```typescript
const CLAUDE_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min of no output = stuck
```

Replace with:
```typescript
const CLAUDE_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 min of no output = stuck
```

Also update the timeout message in callClaude() that references "5 minutes". Find:
```typescript
      console.error("Claude CLI timed out (no activity for 5 minutes)");
```
Replace with:
```typescript
      console.error("Claude CLI timed out (no activity for 15 minutes)");
```

And the user-facing message. Find:
```typescript
      return { text: "Sorry, Claude appears to be stuck (no activity for 5 minutes). Please try again.", sessionId: null };
```
Replace with:
```typescript
      return { text: "Sorry, Claude appears to be stuck (no activity for 15 minutes). Please try again.", sessionId: null };
```

**Requirements covered:** TIMEOUT-01
  </action>
  <verify>
1. grep for "15 \* 60 \* 1000" in relay.ts confirms the new timeout value
2. grep for "5 minutes" in relay.ts returns NO matches in callClaude area
3. grep for "15 minutes" in relay.ts confirms updated messages
  </verify>
  <done>
Inactivity timeout increased from 5 to 15 minutes. All timeout-related messages updated.
  </done>
</task>

<task type="auto">
  <name>Task 2: Refactor callClaude() to stream-json NDJSON parsing</name>
  <files>src/relay.ts</files>
  <action>
Replace the entire `callClaude()` function body (lines 1704-1824) with the streaming implementation. The function signature and return type stay identical so all callers work unchanged.

**Replace the entire callClaude function** (from `async function callClaude(` through the closing `}` before the `// THREAD SUMMARY` section comment) with:

```typescript
async function callClaude(
  prompt: string,
  threadInfo?: ThreadInfo
): Promise<{ text: string; sessionId: string | null }> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume from thread's stored session if available
  if (threadInfo?.sessionId) {
    args.push("--resume", threadInfo.sessionId);
  }

  args.push("--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions");

  console.log(`Calling Claude: ${prompt.substring(0, 80)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: { ...process.env },
    });

    // Inactivity-based timeout: kill only if Claude goes silent for 15 min.
    // With stream-json, every event resets this timer — much more reliable than stderr-only.
    let timedOut = false;
    let inactivityTimer: Timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid!, "SIGTERM");
      } catch {
        proc.kill();
      }
    }, CLAUDE_INACTIVITY_TIMEOUT_MS);

    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      if (timedOut) return;
      inactivityTimer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-proc.pid!, "SIGTERM");
        } catch {
          proc.kill();
        }
      }, CLAUDE_INACTIVITY_TIMEOUT_MS);
    };

    // Drain stderr for logging (no longer used for activity detection)
    const stderrChunks: string[] = [];
    const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const stderrDecoder = new TextDecoder();
    const stderrDrain = (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          stderrChunks.push(stderrDecoder.decode(value, { stream: true }));
        }
      } catch {
        // Stream closed — process ended
      }
    })();

    // Parse stdout as NDJSON stream (one JSON event per line)
    let resultText = "";
    let newSessionId: string | null = null;
    let buffer = "";
    let totalBytes = 0;
    const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const stdoutDecoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;

        const chunk = stdoutDecoder.decode(value, { stream: true });
        totalBytes += chunk.length;
        buffer += chunk;

        // Size guard: stop accumulating if output is enormous
        if (totalBytes > MAX_OUTPUT_SIZE) {
          console.warn(`Claude stream output very large (${totalBytes} bytes), stopping parse`);
          break;
        }

        // Split into complete lines, keep last partial line in buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          // Every line of output = activity → reset inactivity timer
          resetInactivityTimer();

          try {
            const event = JSON.parse(line);

            // Extract session ID from init event (available immediately)
            if (event.type === "system" && event.subtype === "init" && event.session_id) {
              newSessionId = event.session_id;
            }

            // Also capture session_id from assistant or result events as fallback
            if (event.session_id && !newSessionId) {
              newSessionId = event.session_id;
            }

            // Extract final result text from result event (always last)
            if (event.type === "result") {
              if (typeof event.result === "string") {
                resultText = event.result;
              } else if (event.result?.content?.[0]?.text) {
                resultText = event.result.content[0].text;
              }
              // Result event also has session_id
              if (event.session_id) {
                newSessionId = event.session_id;
              }
            }
          } catch {
            // Non-JSON line or partial data — skip silently
          }
        }
      }
    } catch {
      // Stream closed — process ended
    }

    // Process any remaining buffer content
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === "result") {
          if (typeof event.result === "string") {
            resultText = event.result;
          } else if (event.result?.content?.[0]?.text) {
            resultText = event.result.content[0].text;
          }
          if (event.session_id) newSessionId = event.session_id;
        } else if (event.session_id && !newSessionId) {
          newSessionId = event.session_id;
        }
        resetInactivityTimer();
      } catch {
        // Incomplete JSON at end — ignore
      }
    }

    await stderrDrain;
    clearTimeout(inactivityTimer);
    const stderrText = stderrChunks.join("");
    const exitCode = await proc.exited;

    if (timedOut) {
      console.error("Claude CLI timed out (no activity for 15 minutes)");
      // Clean up any orphaned child processes (skill scripts, auth flows, etc.)
      await killOrphanedProcesses(proc.pid!);
      return { text: "Sorry, Claude appears to be stuck (no activity for 15 minutes). Please try again.", sessionId: null };
    }

    if (exitCode !== 0) {
      // If we used --resume and it failed, retry without it (session may be expired/corrupt)
      if (threadInfo?.sessionId) {
        console.warn(`Session ${threadInfo.sessionId} failed (exit ${exitCode}), starting fresh`);
        return callClaude(prompt, { ...threadInfo, sessionId: null });
      }
      console.error("Claude error:", stderrText);
      return { text: "Sorry, something went wrong processing your request. Please try again.", sessionId: null };
    }

    // Fallback: if no result event was parsed, use raw stderr info
    if (!resultText) {
      console.warn("No result event found in stream-json output");
      resultText = "Sorry, I couldn't parse the response. Please try again.";
    }

    // Store session ID in Supabase for this thread
    if (newSessionId && threadInfo?.dbId) {
      await updateThreadSession(threadInfo.dbId, newSessionId);
    }

    return { text: resultText.trim(), sessionId: newSessionId };
  } catch (error) {
    console.error("Spawn error:", error);
    return { text: `Error: Could not run Claude CLI`, sessionId: null };
  }
}
```

**Key changes from the original:**
1. **Args:** `--output-format json` → `--output-format stream-json --verbose` (STREAM-01)
2. **Stdout parsing:** Instead of `await new Response(proc.stdout).text()` + `JSON.parse()`, we read chunks incrementally, split into lines, parse each as JSON (STREAM-02)
3. **Activity detection:** `resetInactivityTimer()` called on every NDJSON line from stdout, not just stderr chunks (STREAM-03)
4. **Session ID:** Extracted from `system/init` event immediately, with fallback to any event with `session_id` field
5. **Result text:** Extracted from `result` event's `.result` field (same structure as before)
6. **Stderr:** Still drained for logging but no longer used for activity detection
7. **Orphan cleanup:** Same logic, triggered identically on timeout (TIMEOUT-02)
8. **Session retry:** Same recursive call pattern on non-zero exit with --resume
9. **Size guard:** Applied incrementally during stream parsing (totalBytes counter)
10. **Return signature:** Identical `{ text: string; sessionId: string | null }` — all callers work unchanged

**Requirements covered:** STREAM-01, STREAM-02, STREAM-03, TIMEOUT-02
  </action>
  <verify>
1. grep for "stream-json" in relay.ts confirms new output format
2. grep for "--verbose" in relay.ts confirms verbose flag added
3. grep for 'buffer.split("\\n")' in relay.ts confirms NDJSON line splitting
4. grep for "system.*init.*session_id" in relay.ts confirms init event parsing
5. grep for "type.*result" in relay.ts confirms result event parsing
6. grep for "resetInactivityTimer()" in relay.ts — should appear inside the stdout loop
7. grep for "killOrphanedProcesses" in relay.ts confirms orphan cleanup still present
8. grep for "callClaude(prompt, { ...threadInfo, sessionId: null })" in relay.ts confirms session retry
9. `bun run start` does not crash (syntax check — stop immediately with Ctrl+C)
  </verify>
  <done>
callClaude() refactored to stream-json NDJSON parsing. Activity detection now uses stdout events instead of stderr. Session ID from init event, result text from result event. Same return signature — all callers unchanged.
  </done>
</task>

<task type="auto">
  <name>Task 3: Update CLAUDE.md with streaming engine documentation</name>
  <files>CLAUDE.md</files>
  <action>
Update CLAUDE.md to document the new streaming internals.

**Change 1:** Update the callClaude() description in the "Key sections in relay.ts" block.

Find:
```
- **callClaude()** — Spawns `claude -p "<prompt>" --resume <sessionId> --output-format json --dangerously-skip-permissions`. Parses JSON for response text and session ID. Auto-retries without `--resume` if session is expired/corrupt. 5-minute timeout.
```

Replace with:
```
- **callClaude()** — Spawns `claude -p "<prompt>" --resume <sessionId> --output-format stream-json --verbose --dangerously-skip-permissions`. Parses NDJSON events line-by-line: session ID from `system/init`, result text from `result` event. Resets inactivity timer on every stream event. Auto-retries without `--resume` if session is expired/corrupt. 15-minute inactivity timeout.
```

**Change 2:** Update the CLAUDE_INACTIVITY_TIMEOUT_MS description.

Find:
```
- `CLAUDE_INACTIVITY_TIMEOUT_MS`: relay.ts line 70 — currently 5 min
```

Replace with:
```
- `CLAUDE_INACTIVITY_TIMEOUT_MS`: relay.ts line 70 — 15 min (stream-json events reset timer)
```

**Change 3:** Update the resetInactivityTimer description.

Find:
```
- `resetInactivityTimer()`: relay.ts line 1739 — currently resets on stderr only
```

Replace with:
```
- `resetInactivityTimer()`: relay.ts — resets on every stream-json event from stdout
```

Note: Don't update line numbers since they will shift after the refactor. Remove specific line references where they'd be fragile.
  </action>
  <verify>
1. grep for "stream-json" in CLAUDE.md confirms updated documentation
2. grep for "15 min" in CLAUDE.md confirms timeout documentation
3. grep for "NDJSON" in CLAUDE.md confirms format documentation
4. grep for "5 min" in CLAUDE.md returns NO matches related to timeout
  </verify>
  <done>
CLAUDE.md updated to reflect streaming engine: stream-json output format, NDJSON parsing, event-based activity detection, and 15-minute timeout.
  </done>
</task>

</tasks>

<verification>
1. `callClaude()` uses `--output-format stream-json --verbose` instead of `--output-format json` (STREAM-01)
2. Stdout is parsed as NDJSON with line-by-line splitting and partial line buffering (STREAM-02)
3. Inactivity timer resets on every parsed NDJSON line from stdout (STREAM-03)
4. Inactivity timeout is 15 minutes (TIMEOUT-01)
5. Orphan process cleanup (`killOrphanedProcesses`) still triggers on timeout (TIMEOUT-02)
6. Session ID extracted from `system/init` event (or any event with `session_id`)
7. Result text extracted from `result` event (same parsing logic as before)
8. Session retry logic works: --resume failure → recursive call without session
9. All callers work unchanged — same function signature and return type
10. Size guard still applied (incremental byte counting during stream)
11. `bun run start` boots without errors
12. CLAUDE.md documents the streaming internals accurately
</verification>

<success_criteria>
- When Claude responds to a message, the relay uses stream-json parsing internally but delivers the same text response to Telegram as before
- Long-running tasks (multi-minute Claude operations) stay alive because every stream event resets the 15-minute timer
- If Claude truly goes silent for 15 minutes, the process is killed and orphans are cleaned up
- Expired/corrupt sessions are retried automatically (same as before)
- Heartbeat and cron callers get streaming benefits for free (they call the same callClaude())
</success_criteria>

<output>
After completion, create `.planning/phases/12-streaming-engine/12-streaming-engine-SUMMARY.md`
</output>
