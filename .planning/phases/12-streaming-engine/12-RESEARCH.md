# Phase 12: Streaming Engine - Research

**Researched:** 2026-02-13
**Domain:** Claude Code CLI stream-json output format
**Confidence:** MEDIUM-HIGH

## Summary

The Claude Code CLI's `--output-format stream-json` flag outputs NDJSON (newline-delimited JSON) format, allowing real-time processing of Claude's responses as they arrive. Each line is a complete JSON object representing different event types throughout the Claude interaction lifecycle.

**Key findings (CORRECTED via live test 2026-02-13):**
1. `--verbose` flag IS **required** with `-p` — error without it: "When using --print, --output-format=stream-json requires --verbose"
2. Event types: `system` (hook_started, hook_response, init), `assistant` (message turns), `result` (final)
3. Session ID at `event.session_id` on system/init, assistant, and result events
4. Tool names at `event.message.content[].name` where `.type === "tool_use"` (in assistant events)
5. Format is NDJSON - one complete JSON object per line
6. Result text at `event.result` on the result event (string directly, same as --output-format json)

**Primary recommendation:** Use `claude -p --output-format stream-json --verbose --dangerously-skip-permissions` and parse line-by-line.

> **Note:** The web research below contains inaccuracies about `--verbose` and event types. The live test output is authoritative. See verified format in PLAN.md Task 2.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Bun.spawn() | Built-in | Process spawning | Native Bun API, already in use |
| Node readline | Built-in | Line-by-line stream parsing | Standard for NDJSON parsing |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| JSON.parse | Built-in | Parse each line | Every NDJSON line |

**Installation:**
No external dependencies needed - all built-in APIs.

## Architecture Patterns

### Recommended Stream Processing Structure

```typescript
// Spawn Claude with stream-json output
const proc = spawn([
  "claude",
  "-p", prompt,
  "--output-format", "stream-json",
  "--dangerously-skip-permissions"
], {
  cwd: PROJECT_DIR,
  stdout: "pipe",
  stderr: "pipe"
});

// Process stdout line-by-line
const decoder = new TextDecoder();
let buffer = "";

for await (const chunk of proc.stdout) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() || ""; // Keep incomplete line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);
      handleStreamEvent(event);
    } catch (err) {
      console.error("Failed to parse stream event:", err);
    }
  }
}
```

### Pattern 1: Event-Driven Processing
**What:** Handle each NDJSON event as it arrives, dispatching to type-specific handlers
**When to use:** Always - this is the core pattern for stream-json

**Example:**
```typescript
// Source: GitHub issue #733 + official CLI reference
function handleStreamEvent(event: any) {
  // Extract session ID from message events
  if (event.id && event.type === "message") {
    sessionId = event.id;
  }

  // Process message content (text and tool usage)
  if (event.message?.content && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block.type === "text") {
        // Accumulate assistant text
        responseText += block.text;
      } else if (block.type === "tool_use") {
        // Track tool usage for progress updates
        onToolUse(block.name, block.input);
      }
    }
  }

  // Reset inactivity timer on ANY event
  resetInactivityTimer();
}
```

### Pattern 2: Activity-Based Timeout
**What:** Reset timeout timer on every stream event, not just stderr output
**When to use:** Replace current stderr-only monitoring

**Example:**
```typescript
let inactivityTimer: Timer | null = null;

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);

  inactivityTimer = setTimeout(() => {
    console.error("Claude process inactive for 15 minutes, killing...");
    proc.kill("SIGTERM");
    killOrphanedProcesses(proc.pid!);
  }, 15 * 60 * 1000); // 15 minutes
}

// Call this on EVERY stream event
function handleStreamEvent(event: any) {
  resetInactivityTimer();
  // ... rest of event handling
}
```

### Pattern 3: Incremental Result Collection
**What:** Accumulate final result from message events, no special "result" event type
**When to use:** Always - stream-json doesn't have a dedicated result event

**Example:**
```typescript
// Source: GitHub issue #733
let finalResponse = {
  text: "",
  sessionId: null as string | null,
  toolCalls: [] as Array<{ name: string; input: any }>
};

function handleStreamEvent(event: any) {
  if (event.type === "message" && event.role === "assistant") {
    // Extract session ID
    if (event.id) {
      finalResponse.sessionId = event.id;
    }

    // Accumulate content
    if (event.message?.content && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block.type === "text") {
          finalResponse.text += block.text;
        } else if (block.type === "tool_use") {
          finalResponse.toolCalls.push({
            name: block.name,
            input: block.input
          });
        }
      }
    }
  }
}

// After process completes, finalResponse contains the full interaction
```

### Anti-Patterns to Avoid
- **Don't buffer entire stdout before parsing:** Stream events arrive incrementally; parse line-by-line as they come
- **Don't rely on stderr for activity detection:** Stream events on stdout are the authoritative activity signal
- **Don't expect a final "result" event:** There's no special completion event; accumulate results from message events
- **Don't use `--verbose` flag:** Not needed with stream-json and adds unnecessary output

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| NDJSON parsing | Custom line splitter with regex | Node readline or split("\n") with buffer | Edge cases (partial lines, multi-byte chars) are tricky |
| Process timeout | Custom timer without proper cleanup | setTimeout with clearTimeout on events | Easy to leak timers or miss edge cases |
| JSON parsing errors | Silent try/catch that swallows errors | Try/catch with logging | Stream corruption needs visibility for debugging |

**Key insight:** Stream processing has edge cases (incomplete lines, multi-byte UTF-8 boundaries, process crashes mid-line). Proven patterns handle these correctly.

## Common Pitfalls

### Pitfall 1: Assuming --verbose is Required
**What goes wrong:** Adding `--verbose` flag unnecessarily, creating noise in output
**Why it happens:** Older documentation and GitHub issues mentioned `--verbose` was required for streaming; this changed
**How to avoid:** Use `--output-format stream-json` alone; only add `--include-partial-messages` if token-level streaming is needed
**Warning signs:** Seeing duplicate or extraneous log output in stream

### Pitfall 2: Looking for a "result" Event
**What goes wrong:** Waiting for a special completion event that never comes, causing hangs
**Why it happens:** Assumption that stream-json mirrors the `--output-format json` structure
**How to avoid:** Accumulate results from `message` events throughout the stream; process completion means stream ended
**Warning signs:** Code waiting indefinitely after last event

### Pitfall 3: Activity Detection Only on stderr
**What goes wrong:** Timeout kills Claude even though it's actively streaming events
**Why it happens:** Current relay.ts only resets timer on stderr output; stream-json events come on stdout
**How to avoid:** Reset inactivity timer on every stdout stream event, regardless of content
**Warning signs:** Premature timeouts despite visible stream events in logs

### Pitfall 4: Incomplete Line Buffering
**What goes wrong:** JSON.parse() fails because line was split across chunks
**Why it happens:** stdout chunks don't align with NDJSON line boundaries
**How to avoid:** Maintain a buffer; when splitting lines, keep the last incomplete line for next chunk
**Warning signs:** Random JSON.parse errors mid-stream, not at beginning or end

### Pitfall 5: Not Handling Process Exit After Last Event
**What goes wrong:** Code waits for more events after process has exited cleanly
**Why it happens:** Stream ended but no explicit EOF marker in content
**How to avoid:** Listen for process exit event and flush buffer, treating it as end-of-stream
**Warning signs:** Hanging after successful Claude completion

## Code Examples

Verified patterns from official sources:

### Complete callClaude() Refactor Pattern
```typescript
// Source: Adapted from relay.ts line 1704 + GitHub issue #733
async function callClaude(
  prompt: string,
  threadInfo: ThreadInfo | null
): Promise<{ text: string; sessionId: string | null }> {
  const args = [CLAUDE_PATH, "-p", prompt];

  if (threadInfo?.sessionId) {
    args.push("--resume", threadInfo.sessionId);
  }

  args.push("--output-format", "stream-json", "--dangerously-skip-permissions");

  const proc = spawn(args, {
    cwd: PROJECT_DIR,
    stdout: "pipe",
    stderr: "pipe"
  });

  let responseText = "";
  let sessionId: string | null = null;
  let inactivityTimer: Timer | null = null;

  const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

  function resetInactivityTimer() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      console.error("Claude inactive for 15 min, killing");
      proc.kill("SIGTERM");
      if (proc.pid) killOrphanedProcesses(proc.pid);
    }, TIMEOUT_MS);
  }

  // Process stream events
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event = JSON.parse(line);
          resetInactivityTimer(); // Activity detected

          // Extract session ID
          if (event.id && event.type === "message") {
            sessionId = event.id;
          }

          // Accumulate text content
          if (event.message?.content && Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
              if (block.type === "text") {
                responseText += block.text;
              }
            }
          }
        } catch (err) {
          console.error("Failed to parse stream event:", line, err);
        }
      }
    }

    // Process final incomplete line if any
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.id) sessionId = event.id;
        // ... accumulate content
      } catch (err) {
        // Incomplete JSON at end, expected
      }
    }
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Claude exited with code ${exitCode}`);
  }

  return { text: responseText, sessionId };
}
```

### Tool Usage Extraction for Progress Updates
```typescript
// Source: GitHub issue #733 + CLI reference
function extractToolUsage(event: any): string[] {
  const tools: string[] = [];

  if (event.message?.content && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block.type === "tool_use" && block.name) {
        tools.push(block.name);
      }
    }
  }

  return tools;
}

// Usage in event handler
function handleStreamEvent(event: any) {
  resetInactivityTimer();

  const tools = extractToolUsage(event);
  if (tools.length > 0) {
    // Send progress update to Telegram (throttled)
    notifyToolUsage(tools);
  }

  // ... rest of processing
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `--output-format json` | `--output-format stream-json` | v0.2.66+ | Enables real-time event processing |
| `--json` flag | `--output-format json` | v0.2.66+ | Deprecated flag removed |
| JSON object output | NDJSON line-by-line | v0.2.120+ | Changed from single JSON to JSONL |
| `--verbose` required for streaming | No flag dependency | Recent (2025+) | Simplified usage |
| stderr-only activity detection | stdout event-based detection | N/A (pattern) | More reliable timeout management |

**Deprecated/outdated:**
- `--json` flag: Use `--output-format json` instead
- Assumption that `--verbose` is required for stream-json: No longer true (if it ever was)
- Looking for `system/init` and `result` events: These event types don't exist in current stream-json format; use `message` events

## Open Questions

1. **Does session ID appear in every message event or only the first?**
   - What we know: Session ID is at `.id` field in message events with `type === "message"`
   - What's unclear: Whether it repeats or appears once per conversation
   - Recommendation: Capture session ID from any message event that has it; use most recent value

2. **What happens if Claude spawns a subagent?**
   - What we know: stream-json emits events for the main conversation
   - What's unclear: Are subagent events nested, separate, or invisible?
   - Recommendation: Test with a multi-agent prompt; may need special handling

3. **How are tool_result events structured?**
   - What we know: GitHub issue shows `{"role": "user", "content": [{"type": "tool_result", ...}]}`
   - What's unclear: Do we need to process these for anything beyond activity detection?
   - Recommendation: Log and observe in testing; likely safe to ignore for our use case

4. **Is there an explicit end-of-stream event?**
   - What we know: Process exit signals completion
   - What's unclear: Any in-stream completion marker?
   - Recommendation: Rely on process exit; don't wait for a special event

## Sources

### Primary (HIGH confidence)
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference) - Official documentation covering `--output-format stream-json` flag and `--include-partial-messages` dependency
- [GitHub Issue #733](https://github.com/anthropics/claude-code/issues/733) - Technical discussion with examples of stream-json output format, event structures, and parsing strategies

### Secondary (MEDIUM confidence)
- [ClaudeLog FAQ: What is --output-format in Claude Code](https://claudelog.com/faqs/what-is-output-format-in-claude-code/) - Community documentation describing stream-json as "real-time streaming JSON for large responses"
- [ytyng.com: Extract Text from Claude Code JSON Stream Output](https://www.ytyng.com/en/blog/claude-stream-json-jq/) - Practical examples of parsing stream-json with jq, shows actual event structure

### Tertiary (LOW confidence - needs validation)
- STATE.md claim that `--verbose` is required - **CONTRADICTED by official docs and GitHub issue**
- STATE.md claim about `system/init` and `result` event types - **NOT found in any official documentation; likely incorrect**

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Built-in Bun/Node APIs, no external deps needed
- Architecture: MEDIUM-HIGH - Patterns verified in GitHub issue and docs, but not personally tested
- Pitfalls: MEDIUM - Inferred from common stream processing gotchas and evidence in sources
- Event structure: MEDIUM - Based on GitHub examples and jq parsing blog, but event types may be incomplete

**Research date:** 2026-02-13
**Valid until:** ~30 days (2026-03-15) - CLI is stable, but stream format details may evolve

**Critical discrepancy found:**
The original STATE.md states `--verbose` is required and describes `system/init` and `result` event types. Official documentation and GitHub issues **contradict both claims**. The correct approach is:
- NO `--verbose` flag needed
- Event types are `message` (with `.type === "message"` and `.role === "assistant"`/`"user"`) containing content blocks
- No special `init` or `result` events; session ID comes from message `.id` field
- Final result is accumulated from all message events; process exit signals completion
