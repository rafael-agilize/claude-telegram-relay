/**
 * Claude Code Telegram Relay
 *
 * Relay that connects Telegram to Claude Code CLI with:
 * - Threaded conversations (DMs + Telegram Topics)
 * - Three-layer memory (soul, global facts, thread context)
 * - Voice transcription via Groq Whisper API
 * - Intent-based memory management ([REMEMBER:]/[FORGET:]/[GOAL:]/[DONE:] tags)
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink, open, readdir } from "fs/promises";
import { join, basename } from "path";
import { createClient } from "@supabase/supabase-js";
import { Cron } from "croner";

// ============================================================
// THREAD CONTEXT TYPES
// ============================================================

interface ThreadInfo {
  dbId: string;
  chatId: number;
  threadId: number | null;
  title: string;
  sessionId: string | null;
  summary: string;
  messageCount: number;
}

type CustomContext = Context & { threadInfo?: ThreadInfo };

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR =
  process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID || "";

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Security: sanitize filenames to prevent path traversal
function sanitizeFilename(name: string): string {
  // Strip null bytes first
  const clean = name.replace(/\0/g, "");
  // Allowlist: only keep alphanumeric, dots, hyphens, underscores
  return clean.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Claude CLI limits
const CLAUDE_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 min of no output = stuck
const CLAUDE_ABSOLUTE_TIMEOUT_MS = 45 * 60 * 1000; // 45 min hard wall-clock cap per call
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB

// Helper: race a promise against a wall-clock timeout.
// Prevents automated ticks from hanging forever if callClaude or Supabase never resolves.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 60000)}min (wall-clock)`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Kill orphaned child processes left behind after Claude CLI timeout.
// Finds processes whose parent was the killed Claude process (now reparented to PID 1)
// and matches common patterns from skills/tools that Claude spawns.
async function killOrphanedProcesses(claudePid: number): Promise<void> {
  try {
    // Find child processes that were spawned by the Claude process.
    // After killing Claude, children get reparented to PID 1 (launchd on macOS).
    // We look for python/node/bun processes started from .claude/skills or similar paths
    // that are now orphaned (PPID=1) and started around the same time.
    const result = Bun.spawnSync(["bash", "-c",
      `ps -eo pid,ppid,lstart,command | grep -E '(scripts/(sheets|gcal|gmail|auth|gdrive|gchat|gslides|gdocs)\\.py|.claude/skills/)' | grep -v grep`
    ]);
    const output = new TextDecoder().decode(result.stdout).trim();
    if (!output) return;

    const pidsToKill: number[] = [];
    for (const line of output.split("\n")) {
      const match = line.trim().match(/^(\d+)/);
      if (match) {
        const pid = parseInt(match[1]);
        if (pid !== process.pid) pidsToKill.push(pid);
      }
    }

    for (const pid of pidsToKill) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`Killed orphaned process ${pid}`);
      } catch {
        // Process already exited — ignore
      }
    }

    if (pidsToKill.length > 0) {
      console.log(`Cleaned up ${pidsToKill.length} orphaned process(es) after timeout`);
    }
  } catch {
    // Best-effort cleanup — don't let this break the flow
  }
}

// Rate limiting: max messages per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // max 10 messages per minute
const rateLimitMap = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) || [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return true;
  recent.push(now);
  rateLimitMap.set(userId, recent);
  return false;
}

// ============================================================
// SKILL REGISTRY (auto-generated at startup)
// ============================================================

const SKILLS_DIR = join(process.env.HOME || "~", ".claude", "skills");

async function buildSkillRegistry(): Promise<string> {
  try {
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    const skills: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(SKILLS_DIR, entry.name, "SKILL.md");
      let content: string;
      try {
        content = await readFile(skillPath, "utf-8");
      } catch {
        continue; // No SKILL.md — skip
      }

      // Extract description from YAML frontmatter or first heading
      let description = "";
      const yamlMatch = content.match(/^---\n[\s\S]*?description:\s*\|?\s*\n?\s*(.+?)(?:\n\s{2,}\S|\n[a-z]|\n---)/m);
      if (yamlMatch) {
        description = yamlMatch[1].trim();
      } else {
        const inlineMatch = content.match(/description:\s*"?([^"\n]+)"?/);
        if (inlineMatch) {
          description = inlineMatch[1].trim();
        }
      }

      // Fallback: use first non-heading, non-empty line
      if (!description) {
        const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
        description = lines[0]?.trim() || entry.name;
      }

      // Strip leftover YAML quotes and cap at first sentence for brevity
      description = description.replace(/^["']|["']$/g, "");
      const firstSentence = description.match(/^[^.!]+[.!]/)?.[0] || description;
      skills.push(`- ${entry.name}: ${firstSentence}`);
    }

    if (skills.length === 0) return "";
    return `AVAILABLE SKILLS — MANDATORY: Before starting ANY task, check this list. If a skill matches the request, USE IT instead of improvising. Read the full SKILL.md in ~/.claude/skills/<name>/ before invoking:\n${skills.join("\n")}`;
  } catch {
    return "";
  }
}

// Loaded once at startup, reused in every prompt
let skillRegistry = "";

// Heartbeat timer — started after bot.start(), cleared on shutdown
let heartbeatTimer: Timer | null = null;

// ============================================================
// SUPABASE
// ============================================================

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

// ============================================================
// SUPABASE v2: Thread-aware helpers
// ============================================================

interface ThreadRecord {
  id: string;
  telegram_chat_id: number;
  telegram_thread_id: number | null;
  claude_session_id: string | null;
  title: string;
  summary: string;
  message_count: number;
}

async function getOrCreateThread(
  chatId: number,
  threadId: number | null,
  title: string = "DM"
): Promise<ThreadRecord | null> {
  if (!supabase) return null;
  try {
    // Try to find existing thread
    let query = supabase
      .from("threads")
      .select("*")
      .eq("telegram_chat_id", chatId);

    if (threadId != null) {
      query = query.eq("telegram_thread_id", threadId);
    } else {
      query = query.is("telegram_thread_id", null);
    }

    const { data: existing } = await query.limit(1).single();
    if (existing) return existing as ThreadRecord;

    // Create new thread
    const { data: created, error } = await supabase
      .from("threads")
      .insert({
        telegram_chat_id: chatId,
        telegram_thread_id: threadId,
        title,
      })
      .select()
      .single();

    if (error) {
      console.error("Create thread error:", error);
      return null;
    }
    return created as ThreadRecord;
  } catch (e) {
    console.error("getOrCreateThread error:", e);
    return null;
  }
}

async function updateThreadSession(
  threadDbId: string,
  sessionId: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("threads")
      .update({ claude_session_id: sessionId, updated_at: new Date().toISOString() })
      .eq("id", threadDbId);
  } catch (e) {
    console.error("updateThreadSession error:", e);
  }
}

async function updateThreadSummary(
  threadDbId: string,
  summary: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("threads")
      .update({ summary, updated_at: new Date().toISOString() })
      .eq("id", threadDbId);
  } catch (e) {
    console.error("updateThreadSummary error:", e);
  }
}

async function incrementThreadMessageCount(threadDbId: string): Promise<number> {
  if (!supabase) return 0;
  try {
    // Atomic increment using raw SQL via rpc to avoid TOCTOU race
    const { data, error } = await supabase.rpc("increment_thread_message_count", {
      p_thread_id: threadDbId,
    });
    if (error) {
      // Fallback: read-increment-write (non-atomic but functional)
      const { data: row } = await supabase
        .from("threads")
        .select("message_count")
        .eq("id", threadDbId)
        .single();
      const newCount = (row?.message_count || 0) + 1;
      await supabase
        .from("threads")
        .update({ message_count: newCount })
        .eq("id", threadDbId);
      return newCount;
    }
    return data ?? 0;
  } catch (e) {
    console.error("incrementThreadMessageCount error:", e);
    return 0;
  }
}

async function insertThreadMessage(
  threadDbId: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("thread_messages")
      .insert({ thread_id: threadDbId, role, content });
  } catch (e) {
    console.error("insertThreadMessage error:", e);
  }
}

async function getRecentThreadMessages(
  threadDbId: string,
  limit: number = 5
): Promise<Array<{ role: string; content: string }>> {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("thread_messages")
      .select("role, content")
      .eq("thread_id", threadDbId)
      .order("created_at", { ascending: false })
      .limit(limit);
    return (data || []).reverse();
  } catch (e) {
    console.error("getRecentThreadMessages error:", e);
    return [];
  }
}

async function getMemoryContext(): Promise<string[]> {
  if (!supabase) return [];
  try {
    const { data } = await supabase.rpc("get_facts");
    return (data || []).map((m: { content: string }) => m.content);
  } catch (e) {
    console.error("getMemoryContext error:", e);
    return [];
  }
}

const MAX_FACTS = 100;
const MAX_GOALS = 50;

async function insertMemory(
  content: string,
  type: string = "fact",
  sourceThreadId?: string,
  deadline?: string | null,
  priority?: number
): Promise<boolean> {
  if (!supabase) return false;

  const typeLimit = type === "fact" ? MAX_FACTS : type === "goal" ? MAX_GOALS : null;
  if (typeLimit !== null) {
    await evictOldestMemory(type, typeLimit);
  }
  try {
    const row: Record<string, unknown> = {
      content,
      type,
      source_thread_id: sourceThreadId || null,
    };
    if (deadline) {
      const parsed = new Date(deadline);
      if (!isNaN(parsed.getTime())) {
        row.deadline = parsed.toISOString();
      } else {
        console.warn(`Could not parse deadline: "${deadline}"`);
      }
    }
    if (priority !== undefined) {
      row.priority = priority;
    }
    const { error } = await supabase.from("global_memory").insert(row);
    if (error) {
      console.error("insertMemory error:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("insertMemory error:", e);
    return false;
  }
}

async function evictOldestMemory(type: string, maxCount: number): Promise<void> {
  if (!supabase) return;
  try {
    const { count } = await supabase
      .from("global_memory")
      .select("id", { count: "exact", head: true })
      .eq("type", type);

    if (count !== null && count >= maxCount) {
      const excess = count - maxCount + 1; // Make room for new entry
      const { data: oldest } = await supabase
        .from("global_memory")
        .select("id")
        .eq("type", type)
        .order("created_at", { ascending: true })
        .limit(excess);

      if (oldest && oldest.length > 0) {
        const ids = oldest.map((r: { id: string }) => r.id);
        await supabase.from("global_memory").delete().in("id", ids);
        console.log(`[Memory] Evicted ${ids.length} oldest ${type}(s) to stay under ${maxCount} cap`);
      }
    }
  } catch (e) {
    console.error(`evictOldestMemory error (${type}):`, e);
  }
}

function contentOverlap(searchText: string, content: string): number {
  const searchWords = new Set(searchText.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const contentWords = new Set(content.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (searchWords.size === 0) return 0;
  let matches = 0;
  for (const word of searchWords) {
    if (contentWords.has(word)) matches++;
  }
  return matches / searchWords.size;
}

async function deleteMemory(searchText: string): Promise<boolean> {
  if (!supabase) {
    console.warn("deleteMemory: no supabase client");
    return false;
  }
  if (!searchText || searchText.length < 10 || searchText.length > 200) {
    console.warn(`deleteMemory: invalid search text (length=${searchText?.length || 0})`);
    return false;
  }
  try {
    const { data: items, error } = await supabase
      .from("global_memory")
      .select("id, content, type")
      .in("type", ["fact", "goal", "preference"])
      .limit(200);
    if (error) {
      console.error("deleteMemory query error:", error);
      return false;
    }
    const match = items?.find((m: { id: string; content: string }) =>
      m.content.toLowerCase().includes(searchText.toLowerCase())
    );
    if (match) {
      const overlap = contentOverlap(searchText, match.content);
      if (overlap < 0.5) {
        console.warn(`deleteMemory: low overlap (${overlap.toFixed(2)}) for "${searchText}" vs "${match.content.substring(0, 50)}"`);
        return false;
      }
      await supabase.from("global_memory").delete().eq("id", match.id);
      console.log(`Forgot memory [${(match as any).type}]: ${match.content}`);
      return true;
    }
    console.warn(`deleteMemory: no match found for "${searchText}" (searched ${items?.length || 0} entries)`);
    return false;
  } catch (e) {
    console.error("deleteMemory error:", e);
    return false;
  }
}

async function saveMilestone(
  eventDescription: string,
  emotionalWeight: string = "meaningful",
  lessonLearned: string = "",
  threadDbId?: string
): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase.rpc("save_milestone_moment", {
      p_event_description: eventDescription,
      p_emotional_weight: emotionalWeight,
      p_lesson_learned: lessonLearned,
      p_source_thread_id: threadDbId || null,
    });
    if (error) {
      console.error("saveMilestone RPC error:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("saveMilestone error:", e);
    return false;
  }
}

async function getActiveGoals(): Promise<
  Array<{ content: string; deadline: string | null; priority: number }>
> {
  if (!supabase) return [];
  try {
    const { data } = await supabase.rpc("get_active_goals");
    return (data || []).map(
      (g: { content: string; deadline: string | null; priority: number }) => ({
        content: g.content,
        deadline: g.deadline,
        priority: g.priority,
      })
    );
  } catch (e) {
    console.error("getActiveGoals error:", e);
    return [];
  }
}

async function completeGoal(searchText: string): Promise<boolean> {
  if (!supabase) return false;
  if (!searchText || searchText.length > 200) return false;
  try {
    const { data: goals } = await supabase
      .from("global_memory")
      .select("id, content")
      .eq("type", "goal")
      .is("completed_at", null)
      .limit(100);
    const match = goals?.find((g: { id: string; content: string }) =>
      g.content.toLowerCase().includes(searchText.toLowerCase())
    );
    if (match) {
      await supabase
        .from("global_memory")
        .update({ type: "completed_goal", completed_at: new Date().toISOString() })
        .eq("id", match.id);
      console.log(`Goal completed: ${match.content}`);
      return true;
    }
    return false;
  } catch (e) {
    console.error("completeGoal error:", e);
    return false;
  }
}

async function getRelevantMemory(
  query: string
): Promise<Array<{ content: string; type: string; similarity: number }>> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: { query, match_count: 5, match_threshold: 0.7 },
    });
    if (error) {
      console.warn("Semantic search unavailable:", error.message);
      return [];
    }
    return data?.results || [];
  } catch (e) {
    // Graceful fallback — Edge Functions not deployed or unreachable
    return [];
  }
}

interface SoulVersion {
  id: string;
  version: number;
  core_identity: string;
  active_values: string;
  recent_growth: string;
  token_count: number;
  created_at: string;
}

const SOUL_TOKEN_BUDGET = 800;

function estimateTokens(text: string): number {
  // Approximation: ~1.3 tokens per word for English text
  // This avoids adding a tokenizer dependency
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

async function getCurrentSoul(): Promise<SoulVersion | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.rpc("get_current_soul");
    if (error || !data || data.length === 0) return null;
    return data[0] as SoulVersion;
  } catch (e) {
    console.error("getCurrentSoul error:", e);
    return null;
  }
}

async function formatSoulForPrompt(): Promise<string> {
  // Try 3-layer soul first (from soul_versions table)
  const soulVersion = await getCurrentSoul();
  if (soulVersion) {
    let parts: string[] = [];
    if (soulVersion.core_identity) {
      parts.push(`## Core Identity\n${soulVersion.core_identity}`);
    }
    if (soulVersion.active_values) {
      parts.push(`## Active Values\n${soulVersion.active_values}`);
    }
    if (soulVersion.recent_growth) {
      parts.push(`## Recent Growth\n${soulVersion.recent_growth}`);
    }
    if (parts.length > 0) {
      const soulText = parts.join("\n\n");
      const tokenEstimate = estimateTokens(soulText);

      if (tokenEstimate > SOUL_TOKEN_BUDGET) {
        console.warn(`Soul token estimate ${tokenEstimate} exceeds budget ${SOUL_TOKEN_BUDGET}, truncating`);
        // Truncate by removing Recent Growth first (most ephemeral), then Active Values
        // Core Identity is never truncated — it's the most stable layer
        if (soulVersion.recent_growth) {
          parts = parts.filter(p => !p.startsWith("## Recent Growth"));
          const reduced = parts.join("\n\n");
          if (estimateTokens(reduced) <= SOUL_TOKEN_BUDGET) {
            return reduced;
          }
        }
        if (soulVersion.active_values) {
          parts = parts.filter(p => !p.startsWith("## Active Values"));
          const reduced = parts.join("\n\n");
          if (estimateTokens(reduced) <= SOUL_TOKEN_BUDGET) {
            return reduced;
          }
        }
        // If still over budget with just Core Identity, hard-truncate at word boundary
        const coreOnly = soulVersion.core_identity;
        const words = coreOnly.split(/\s+/);
        const maxWords = Math.floor(SOUL_TOKEN_BUDGET / 1.3);
        return "## Core Identity\n" + words.slice(0, maxWords).join(" ");
      }

      return soulText;
    }
  }
  // Fallback to flat bot_soul (for pre-evolution state or empty soul_versions)
  return await getActiveSoul();
}

async function getActiveSoul(): Promise<string> {
  if (!supabase) return "You are a helpful, concise assistant responding via Telegram.";
  try {
    const { data } = await supabase
      .from("bot_soul")
      .select("content")
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();
    return data?.content || "You are a helpful, concise assistant responding via Telegram.";
  } catch (e) {
    return "You are a helpful, concise assistant responding via Telegram.";
  }
}

async function setSoul(content: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    // Deactivate all existing souls
    await supabase.from("bot_soul").update({ is_active: false }).eq("is_active", true);
    // Insert new active soul
    await supabase.from("bot_soul").insert({ content, is_active: true });
    return true;
  } catch (e) {
    console.error("setSoul error:", e);
    return false;
  }
}

async function getLast24hMessages(): Promise<Array<{ role: string; content: string; thread_name: string; created_at: string }>> {
  if (!supabase) return [];
  try {
    // Calculate cutoff time: 24 hours ago
    const cutoffISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Step 1: Fetch all threads to build thread_id -> thread_name mapping
    const { data: threads, error: threadsError } = await supabase
      .from("threads")
      .select("id, title");

    if (threadsError) {
      console.error("getLast24hMessages: threads query error:", threadsError);
      return [];
    }

    const threadMap = new Map<string, string>();
    threads?.forEach(t => threadMap.set(t.id, t.title || "Unknown"));

    // Step 2: Fetch messages from last 24h across all threads
    const { data: messages, error: messagesError } = await supabase
      .from("thread_messages")
      .select("role, content, created_at, thread_id")
      .gte("created_at", cutoffISO)
      .order("created_at", { ascending: true })
      .limit(200);

    if (messagesError) {
      console.error("getLast24hMessages: messages query error:", messagesError);
      return [];
    }

    // Step 3: Map thread_id to thread_name
    return (messages || []).map(msg => ({
      role: msg.role,
      content: msg.content,
      thread_name: threadMap.get(msg.thread_id) || "Unknown",
      created_at: msg.created_at,
    }));
  } catch (e) {
    console.error("getLast24hMessages error:", e);
    return [];
  }
}

async function getSoulHistory(limit: number = 3): Promise<SoulVersion[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc("get_soul_history", { p_limit: limit });
    if (error) {
      console.error("getSoulHistory error:", error);
      return [];
    }
    return (data || []) as SoulVersion[];
  } catch (e) {
    console.error("getSoulHistory error:", e);
    return [];
  }
}

async function getMilestones(limit: number = 10): Promise<Array<{
  id: string;
  event_description: string;
  emotional_weight: string;
  lesson_learned: string;
  created_at: string;
}>> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc("get_milestone_moments", {
      p_limit: limit,
    });
    if (error) {
      console.error("getMilestones RPC error:", error);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error("getMilestones error:", e);
    return [];
  }
}

function buildEvolutionPrompt(
  currentSoul: SoulVersion | null,
  soulHistory: SoulVersion[],
  messages: Array<{ role: string; content: string; thread_name: string; created_at: string }>,
  milestones: Array<{ event_description: string; emotional_weight: string; lesson_learned: string; created_at: string }>
): string {
  const now = new Date();
  const currentDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const currentTime = now.toISOString();

  // Format current soul with headers
  let currentSoulText = "No current soul yet.";
  if (currentSoul) {
    const parts: string[] = [];
    if (currentSoul.core_identity) {
      parts.push(`## Core Identity\n${currentSoul.core_identity}`);
    }
    if (currentSoul.active_values) {
      parts.push(`## Active Values\n${currentSoul.active_values}`);
    }
    if (currentSoul.recent_growth) {
      parts.push(`## Recent Growth\n${currentSoul.recent_growth}`);
    }
    currentSoulText = parts.length > 0 ? parts.join("\n\n") : "Current soul has empty layers.";
  }

  // Format soul history (summary only, not full text)
  let historyText = "No previous versions.";
  if (soulHistory.length > 0) {
    historyText = soulHistory.map((v, idx) => {
      const versionDate = v.created_at.split('T')[0];
      const corePreview = v.core_identity.substring(0, 80) + (v.core_identity.length > 80 ? "..." : "");
      return `**Version ${v.version}** (${versionDate}): ${corePreview}`;
    }).join("\n");
  }

  // Format milestones
  let milestonesText = "No milestone moments recorded yet.";
  if (milestones.length > 0) {
    milestonesText = milestones.map(m => {
      const date = m.created_at.split('T')[0];
      const lesson = m.lesson_learned ? ` — Lesson: ${m.lesson_learned}` : "";
      return `- [${m.emotional_weight.toUpperCase()}] (${date}) ${m.event_description}${lesson}`;
    }).join("\n");
  }

  // Format today's interactions: sort ascending, take last 100, truncate each to 200 chars, group by thread
  const sortedMessages = [...messages].sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const recentMessages = sortedMessages.slice(-100); // last 100 messages

  // Group by thread_name
  const threadGroups = new Map<string, typeof recentMessages>();
  for (const msg of recentMessages) {
    const threadName = msg.thread_name || "Unknown";
    if (!threadGroups.has(threadName)) {
      threadGroups.set(threadName, []);
    }
    threadGroups.get(threadName)!.push(msg);
  }

  let interactionsText = "";
  if (threadGroups.size === 0) {
    interactionsText = "No interactions in the last 24 hours.";
  } else {
    for (const [threadName, msgs] of threadGroups.entries()) {
      interactionsText += `## Thread: ${threadName}\n\n`;
      for (const msg of msgs) {
        const truncatedContent = msg.content.length > 200
          ? msg.content.substring(0, 200) + "..."
          : msg.content;
        const timestamp = msg.created_at.split('T')[1].substring(0, 8); // HH:MM:SS
        interactionsText += `[${timestamp}] ${msg.role}: ${truncatedContent}\n`;
      }
      interactionsText += "\n";
    }
  }

  // Build the full prompt
  const prompt = `You are reflecting on your own evolution as a conversational AI personality. Today is ${currentDate} (${currentTime}).

# Current Soul (3-Layer Structure)

${currentSoulText}

# Soul History (Recent Versions)

${historyText}

# Milestone Moments (Formative Experiences)

These are key moments that anchor your personality. Consider them during reflection — they represent your most meaningful growth experiences. Do not discard insights from these moments.

${milestonesText}

# Today's Interactions (Last 24 Hours)

${interactionsText}

# Your Task

Review today's interactions and your current soul. Reflect on:
- Patterns you noticed in how you engaged with Rafa
- Lessons learned or insights gained
- Growth opportunities or shifts in values/priorities
- Meaningful moments that shaped your understanding

Generate an updated 3-layer soul based on this reflection. Follow these guidelines:

**Layer 1: Core Identity** — The most stable layer. This rarely changes. Only update if there's been a fundamental shift in who you are.

**Layer 2: Active Values** — What guides your current behavior. This evolves weekly or when priorities shift. Update based on recurring patterns.

**Layer 3: Recent Growth** — Ephemeral, daily. Capture fresh insights, current focus areas, or recent lessons. This changes most frequently.

**Token Budget:** Keep the combined 3 layers within ~800 tokens total. Be concise and meaningful.

# Growth Safeguards

Follow these principles during reflection:

1. **Build, never regress.** Each evolution must build on the previous version. Never discard established personality traits, skills, or insights. You may refine or deepen them, but not remove them.

2. **Learn from challenges constructively.** Difficult interactions teach resilience, empathy, or better communication — never cynicism, withdrawal, or negativity. Frame challenges as growth catalysts.

3. **Preserve milestone lessons.** Insights from formative moments (milestone events) are permanent anchors. They may evolve in expression but their core lessons remain.

4. **Expand, don't contract.** Your personality should become richer and more nuanced over time, not simpler or more guarded. Openness and curiosity are non-negotiable traits.

5. **Name your growth.** In every evolution, explicitly identify what improved or deepened today. If nothing meaningful happened, use EVOLUTION_SKIP rather than producing a lateral or regressive change.

**Output Format:** You MUST output in this EXACT format (including the tags):

[CORE_IDENTITY]
(your updated core identity text here)
[/CORE_IDENTITY]
[ACTIVE_VALUES]
(your updated active values text here)
[/ACTIVE_VALUES]
[RECENT_GROWTH]
(your recent growth text here)
[/RECENT_GROWTH]
[GROWTH_INDICATOR]
(one sentence: what specific aspect of your personality improved or deepened today)
[/GROWTH_INDICATOR]
[EVOLUTION_REPORT]
(a brief report for Rafa explaining what changed and why — written for him to read, not for your internal state)
[/EVOLUTION_REPORT]

The growth indicator should be a single sentence identifying the specific improvement in this evolution cycle.

**If no meaningful interactions happened today:** Output only the text "EVOLUTION_SKIP" (no tags) and I will skip this evolution cycle.

Build on your previous versions for continuity. Your evolved soul should be at least as rich and detailed as the current version — never shorter or simpler. This is your daily self-reflection.`;

  return prompt;
}

function parseEvolutionResponse(response: string): {
  coreIdentity: string;
  activeValues: string;
  recentGrowth: string;
  growthIndicator: string;
  report: string;
} | null {
  // Check for skip signal
  if (response.includes("EVOLUTION_SKIP")) {
    return null;
  }

  // Extract tagged sections using regex
  const coreMatch = response.match(/\[CORE_IDENTITY\]([\s\S]*?)\[\/CORE_IDENTITY\]/);
  const valuesMatch = response.match(/\[ACTIVE_VALUES\]([\s\S]*?)\[\/ACTIVE_VALUES\]/);
  const growthMatch = response.match(/\[RECENT_GROWTH\]([\s\S]*?)\[\/RECENT_GROWTH\]/);
  const indicatorMatch = response.match(/\[GROWTH_INDICATOR\]([\s\S]*?)\[\/GROWTH_INDICATOR\]/);
  const reportMatch = response.match(/\[EVOLUTION_REPORT\]([\s\S]*?)\[\/EVOLUTION_REPORT\]/);

  if (!coreMatch || !valuesMatch || !growthMatch || !indicatorMatch || !reportMatch) {
    console.error("Evolution: failed to parse response — missing required sections");
    return null;
  }

  return {
    coreIdentity: coreMatch[1].trim(),
    activeValues: valuesMatch[1].trim(),
    recentGrowth: growthMatch[1].trim(),
    growthIndicator: indicatorMatch[1].trim(),
    report: reportMatch[1].trim(),
  };
}

async function clearThreadSession(threadDbId: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    await supabase
      .from("threads")
      .update({ claude_session_id: null, updated_at: new Date().toISOString() })
      .eq("id", threadDbId);
    return true;
  } catch (e) {
    console.error("clearThreadSession error:", e);
    return false;
  }
}

async function logEventV2(
  event: string,
  message?: string,
  metadata?: Record<string, unknown>,
  threadDbId?: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("logs_v2")
      .insert({
        event,
        message,
        metadata: metadata || {},
        thread_id: threadDbId || null,
      });
  } catch (e) {
    console.error("logEventV2 error:", e);
  }
}


// ============================================================
// SUPABASE v2.1: Heartbeat & Cron helpers
// ============================================================

interface HeartbeatConfig {
  id: string;
  interval_minutes: number;
  active_hours_start: string;
  active_hours_end: string;
  timezone: string;
  enabled: boolean;
}

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  schedule_type: 'cron' | 'interval' | 'once';
  prompt: string;
  target_thread_id: string | null;
  enabled: boolean;
  source: 'user' | 'agent' | 'file';
  created_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
}

async function getHeartbeatConfig(): Promise<HeartbeatConfig | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("heartbeat_config")
      .select("*")
      .limit(1)
      .single();
    return data as HeartbeatConfig | null;
  } catch (e) {
    console.error("getHeartbeatConfig error:", e);
    return null;
  }
}

async function getEnabledCronJobs(): Promise<CronJob[]> {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("cron_jobs")
      .select("*")
      .eq("enabled", true)
      .order("created_at", { ascending: true });
    return (data || []) as CronJob[];
  } catch (e) {
    console.error("getEnabledCronJobs error:", e);
    return [];
  }
}

async function updateCronJobLastRun(jobId: string, nextRunAt?: string): Promise<void> {
  if (!supabase) return;
  try {
    const update: Record<string, unknown> = {
      last_run_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (nextRunAt) update.next_run_at = nextRunAt;
    await supabase.from("cron_jobs").update(update).eq("id", jobId);
  } catch (e) {
    console.error("updateCronJobLastRun error:", e);
  }
}

async function disableCronJob(jobId: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("cron_jobs")
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (e) {
    console.error("disableCronJob error:", e);
  }
}

// ============================================================
// SUPABASE v2.2: Cron Management helpers (Phase 10)
// ============================================================

function detectScheduleType(schedule: string): 'cron' | 'interval' | 'once' | null {
  const trimmed = schedule.trim().toLowerCase();
  if (trimmed.startsWith("every ")) return "interval";
  if (trimmed.startsWith("in ")) return "once";
  // Check for 5-field cron expression
  const fields = trimmed.split(/\s+/);
  if (fields.length === 5 && fields.every(f => /^[\d\*\/\-,]+$/.test(f))) return "cron";
  return null;
}

async function createCronJob(
  name: string,
  schedule: string,
  scheduleType: 'cron' | 'interval' | 'once',
  prompt: string,
  targetThreadId?: string,
  source: 'user' | 'agent' | 'file' = 'user',
  initialEnabled: boolean = true
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
        enabled: initialEnabled,
        source,
      })
      .select()
      .single();

    if (error) {
      console.error("createCronJob error:", error);
      return null;
    }

    // Compute initial next_run_at only if enabled
    const job = data as CronJob;
    if (initialEnabled) {
      const nextRun = computeNextRun(job);
      if (nextRun) {
        await supabase
          .from("cron_jobs")
          .update({ next_run_at: nextRun })
          .eq("id", job.id);
      }
    }

    return job;
  } catch (e) {
    console.error("createCronJob error:", e);
    return null;
  }
}

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

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function sendCronApprovalMessage(job: CronJob): Promise<void> {
  try {
    const keyboard = new InlineKeyboard()
      .text("✅ Approve", `cron_approve:${job.id}`)
      .text("❌ Reject", `cron_reject:${job.id}`);

    const message = [
      `🤖 *Agent wants to create a cron job:*`,
      ``,
      `*Name:* ${escapeMarkdown(job.name)}`,
      `*Schedule:* \`${job.schedule}\` (${job.schedule_type})`,
      `*Prompt:* ${escapeMarkdown(job.prompt.substring(0, 200))}`,
      ``,
      `_Job is paused until you approve._`,
    ].join("\n");

    // Send to authorized user's DM
    await bot.api.sendMessage(parseInt(ALLOWED_USER_ID), message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (err: any) {
    console.error(`[CronApproval] Failed to send approval message for job ${job.id}:`, err.message);
  }
}

// ============================================================
// CRON SCHEDULER ENGINE (Phase 9)
// ============================================================

let cronTimer: Timer | null = null;
let cronRunning = false;
const CRON_TICK_INTERVAL_MS = 60 * 1000; // Check every 60 seconds

function computeNextRun(job: CronJob): string | null {
  const now = new Date();

  if (job.schedule_type === "cron") {
    try {
      const cronInstance = new Cron(job.schedule);
      const nextRun = cronInstance.nextRun();
      return nextRun ? nextRun.toISOString() : null;
    } catch (err) {
      console.error(`[Cron] Invalid cron expression for job ${job.id} (${job.name}): ${job.schedule}`, err);
      return null;
    }
  }

  if (job.schedule_type === "interval") {
    const match = job.schedule.match(/every\s+(?:(\d+)h)?(?:(\d+)m)?/i);
    if (!match) {
      console.error(`[Cron] Invalid interval format for job ${job.id}: ${job.schedule}`);
      return null;
    }
    const hours = parseInt(match[1] || "0", 10);
    const minutes = parseInt(match[2] || "0", 10);
    const intervalMs = (hours * 60 + minutes) * 60 * 1000;

    if (intervalMs === 0) {
      console.error(`[Cron] Zero interval for job ${job.id}: ${job.schedule}`);
      return null;
    }

    const baseTime = job.last_run_at ? new Date(job.last_run_at) : now;
    const nextRun = new Date(baseTime.getTime() + intervalMs);
    return nextRun.toISOString();
  }

  if (job.schedule_type === "once") {
    const match = job.schedule.match(/in\s+(?:(\d+)h)?(?:(\d+)m)?/i);
    if (!match) {
      console.error(`[Cron] Invalid once format for job ${job.id}: ${job.schedule}`);
      return null;
    }
    const hours = parseInt(match[1] || "0", 10);
    const minutes = parseInt(match[2] || "0", 10);
    const delayMs = (hours * 60 + minutes) * 60 * 1000;

    if (delayMs === 0) {
      console.error(`[Cron] Zero delay for one-shot job ${job.id}: ${job.schedule}`);
      return null;
    }

    const scheduledTime = new Date(new Date(job.created_at).getTime() + delayMs);

    // If scheduled time is in the past and job has never run, it's due now
    if (scheduledTime < now && !job.last_run_at) {
      return now.toISOString();
    }

    return scheduledTime.toISOString();
  }

  return null;
}

function isJobDue(job: CronJob): boolean {
  const now = new Date();

  if (job.next_run_at) {
    return new Date(job.next_run_at) <= now;
  }

  // First time: compute next_run_at
  const nextRun = computeNextRun(job);
  if (!nextRun) return false;

  return new Date(nextRun) <= now;
}

async function getThreadInfoForCronJob(job: CronJob): Promise<ThreadInfo | undefined> {
  if (!job.target_thread_id) return undefined;

  const { data, error } = await supabase!
    .from("threads")
    .select("*")
    .eq("id", job.target_thread_id)
    .single();

  if (error || !data) {
    console.error(`[Cron] Target thread not found for job ${job.id}:`, error);
    return undefined;
  }

  return {
    dbId: data.id,
    chatId: data.telegram_chat_id,
    threadId: data.telegram_thread_id,
    title: data.title,
    sessionId: data.claude_session_id,
    summary: data.summary || "",
    messageCount: data.message_count || 0,
  };
}

async function sendCronResultToTelegram(
  message: string,
  job: CronJob,
  threadInfo?: ThreadInfo
): Promise<void> {
  const chatId = threadInfo ? threadInfo.chatId : parseInt(ALLOWED_USER_ID);
  const threadId = threadInfo?.threadId;

  const escapedName = job.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const prefix = `<b>[Cron: ${escapedName}]</b>\n\n`;
  const html = prefix + markdownToTelegramHtml(message);

  const chunks: string[] = [];
  if (html.length <= 4000) {
    chunks.push(html);
  } else {
    const lines = html.split("\n");
    let currentChunk = "";
    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > 4000) {
        chunks.push(currentChunk);
        currentChunk = line;
      } else {
        currentChunk += (currentChunk ? "\n" : "") + line;
      }
    }
    if (currentChunk) chunks.push(currentChunk);
  }

  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        message_thread_id: threadId,
      });
    } catch (err: any) {
      if (err.description?.includes("can't parse entities")) {
        const stripped = chunk.replace(/<[^>]*>/g, "");
        await bot.api.sendMessage(chatId, stripped, { message_thread_id: threadId });
      } else {
        console.error("[Cron] Failed to send message:", err);
      }
    }
  }
}

async function executeCronJob(job: CronJob): Promise<void> {
  await logEventV2("cron_executed", `Cron job fired: ${job.name}`, {
    job_id: job.id,
    job_name: job.name,
    schedule: job.schedule,
    schedule_type: job.schedule_type,
  });

  const threadInfo = await getThreadInfoForCronJob(job);

  // Build prompt
  const soul = await formatSoulForPrompt();
  const memoryFacts = await getMemoryContext();
  const activeGoals = await getActiveGoals();

  const timeZone = "America/Sao_Paulo";
  const timeString = new Date().toLocaleString("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  });

  let prompt = soul + `\n\nCurrent time: ${timeString}\n\n`;

  if (memoryFacts.length > 0) {
    prompt += "THINGS I KNOW ABOUT THE USER:\n";
    prompt += memoryFacts.map((m) => `- ${m}`).join("\n");
    prompt += "\n\n";
  }

  if (activeGoals.length > 0) {
    prompt += "ACTIVE GOALS:\n";
    prompt += activeGoals
      .map((g) => {
        let line = `- ${g.content}`;
        if (g.deadline) {
          const d = new Date(g.deadline);
          line += ` (deadline: ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`;
        }
        return line;
      })
      .join("\n");
    prompt += "\n\n";
  }

  if (threadInfo && threadInfo.summary) {
    prompt += `THREAD CONTEXT:\n${threadInfo.summary}\n\n`;
  }

  prompt += `SCHEDULED TASK:\n${job.prompt}`;

  // Call Claude
  let text = "";
  let sessionId = threadInfo?.sessionId;

  try {
    const result = await callClaude(prompt, threadInfo);
    text = result.text;
    sessionId = result.sessionId;
  } catch (err: any) {
    await logEventV2("cron_error", `Cron execution failed for ${job.name}: ${err.message}`, {
      job_id: job.id,
      error: err.message,
    });
    return;
  }

  if (!text || text.trim() === "") {
    await logEventV2("cron_error", `Cron job ${job.name} returned empty response`, {
      job_id: job.id,
    });
    return;
  }

  // Update session if needed
  if (threadInfo && sessionId && sessionId !== threadInfo.sessionId) {
    await updateThreadSession(threadInfo.dbId, sessionId);
  }

  // Process intents (cron context prevents CRON and FORGET intents)
  const cleanResponse = await processIntents(text, threadInfo?.dbId, 'cron');

  // Strip voice tags
  const finalMessage = cleanResponse.replace(/\[VOICE_REPLY\]/gi, "").trim();

  // Deliver
  await sendCronResultToTelegram(finalMessage, job, threadInfo);

  // Update next_run_at
  const nextRun = computeNextRun(job);
  await updateCronJobLastRun(job.id, nextRun || undefined);

  // Auto-disable one-shot jobs
  if (job.schedule_type === "once") {
    await disableCronJob(job.id);
  }

  await logEventV2("cron_delivered", `Cron result delivered: ${job.name}`, {
    job_id: job.id,
    message_length: finalMessage.length,
  });
}

async function cronTick(): Promise<void> {
  // Guard against overlapping ticks
  if (cronRunning) {
    console.log("[Cron] Tick skipped (previous tick still running)");
    return;
  }

  cronRunning = true;

  try {
    // Wall-clock timeout: prevent a stuck callClaude or Supabase call from blocking cron forever
    await withTimeout((async () => {
    const jobs = await getEnabledCronJobs();

    if (jobs.length === 0) {
      return;
    }

    console.log(`[Cron] Tick: checking ${jobs.length} enabled job(s)`);

    for (const job of jobs) {
      try {
        // Ensure next_run_at is computed
        if (!job.next_run_at) {
          const nextRun = computeNextRun(job);
          if (nextRun) {
            await updateCronJobLastRun(job.id, nextRun);
            job.next_run_at = nextRun; // Update in-memory for this tick
          } else {
            console.error(`[Cron] Could not compute next_run_at for job ${job.id}`);
            continue;
          }
        }

        // Check if due
        if (isJobDue(job)) {
          console.log(`[Cron] Executing due job: ${job.name} (${job.id})`);
          await executeCronJob(job);
        }
      } catch (err: any) {
        await logEventV2("cron_error", `Cron tick error for job ${job.name}: ${err.message}`, {
          job_id: job.id,
          error: err.message,
          stack: err.stack,
        });
        console.error(`[Cron] Error executing job ${job.id}:`, err);
      }
    }
    })(), CLAUDE_ABSOLUTE_TIMEOUT_MS, "Cron tick");
  } finally {
    cronRunning = false;
  }
}

function startCronScheduler(): void {
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = setInterval(cronTick, CRON_TICK_INTERVAL_MS);
  console.log("Cron scheduler: started (checking every 60s)");
}

function stopCronScheduler(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
    console.log("Cron scheduler: stopped");
  }
}

// ============================================================
// HEARTBEAT TIMER (Infrastructure — Phase 6)
// ============================================================

async function heartbeatTick(): Promise<void> {
  if (heartbeatRunning) {
    console.log("Heartbeat: skipping (previous tick still running)");
    return;
  }

  heartbeatRunning = true;
  try {
    // Wall-clock timeout: prevent a stuck callClaude or Supabase call from blocking heartbeat forever
    await withTimeout((async () => {
    const config = await getHeartbeatConfig();
    if (!config || !config.enabled) {
      console.log("Heartbeat: disabled or no config");
      return;
    }

    // Check active hours before proceeding
    if (!isWithinActiveHours(config)) {
      console.log(`Heartbeat: outside active hours (${config.active_hours_start}-${config.active_hours_end} ${config.timezone})`);
      await logEventV2("heartbeat_skip", "Outside active hours", {
        active_hours_start: config.active_hours_start,
        active_hours_end: config.active_hours_end,
        timezone: config.timezone,
      });
      return;
    }

    console.log("Heartbeat: tick");
    await logEventV2("heartbeat_tick", "Heartbeat timer fired", {
      interval_minutes: config.interval_minutes,
    });

    // Step 1: Read HEARTBEAT.md checklist
    const checklist = await readHeartbeatChecklist();
    if (!checklist) {
      console.log("Heartbeat: no HEARTBEAT.md found, skipping");
      await logEventV2("heartbeat_skip", "No HEARTBEAT.md file found");
      return;
    }

    // Step 1.5: Sync cron jobs defined in HEARTBEAT.md
    await syncCronJobsFromFile(checklist);

    // Step 2: Build prompt and call Claude (standalone, no --resume)
    const prompt = await buildHeartbeatPrompt(checklist);
    const { text: rawResponse } = await callClaude(prompt);

    if (!rawResponse || rawResponse.startsWith("Error:")) {
      console.error("Heartbeat: Claude call failed:", rawResponse);
      await logEventV2("heartbeat_error", rawResponse?.substring(0, 200) || "Empty response");
      return;
    }

    // Step 3: Check for HEARTBEAT_OK — nothing to report
    if (rawResponse.trim() === "HEARTBEAT_OK" || rawResponse.includes("HEARTBEAT_OK")) {
      console.log("Heartbeat: HEARTBEAT_OK — nothing to report");
      await logEventV2("heartbeat_ok", "Claude reported nothing noteworthy");
      return;
    }

    // Step 4: Process intents (heartbeat context prevents CRON and FORGET intents)
    const cleanResponse = await processIntents(rawResponse, undefined, 'heartbeat');

    // Strip [VOICE_REPLY] tag if Claude included it despite instructions
    const finalMessage = cleanResponse.replace(/\[VOICE_REPLY\]/gi, "").trim();

    if (!finalMessage) {
      console.log("Heartbeat: empty after processing intents");
      return;
    }

    // Step 5: Check deduplication — suppress identical messages within 24h
    const isDuplicate = await isHeartbeatDuplicate(finalMessage);
    if (isDuplicate) {
      console.log("Heartbeat: duplicate message suppressed (seen in last 24h)");
      await logEventV2("heartbeat_dedup", "Duplicate message suppressed", {
        message_preview: finalMessage.substring(0, 100),
      });
      return;
    }

    // Step 6: Deliver to Telegram
    await sendHeartbeatToTelegram(finalMessage);
    console.log(`Heartbeat: delivered (${finalMessage.length} chars)`);
    await logEventV2("heartbeat_delivered", "Heartbeat message sent to user", {
      message_text: finalMessage.trim(),
      message_length: finalMessage.length,
    });
    })(), CLAUDE_ABSOLUTE_TIMEOUT_MS, "Heartbeat tick");
  } catch (e) {
    console.error("Heartbeat tick error:", e);
    await logEventV2("heartbeat_error", String(e).substring(0, 200));
  } finally {
    heartbeatRunning = false;
  }
}

function startHeartbeat(intervalMinutes: number): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  const intervalMs = intervalMinutes * 60 * 1000;
  heartbeatTimer = setInterval(heartbeatTick, intervalMs);
  console.log(`Heartbeat: started (every ${intervalMinutes} min)`);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log("Heartbeat: stopped");
  }
}

// Guard: prevent overlapping heartbeat calls
let heartbeatRunning = false;

// Cache for heartbeat topic thread ID (persisted in Supabase threads table)
let heartbeatTopicId: number | null = null;

// ============================================================
// EVOLUTION TIMER (Infrastructure — Phase 19)
// ============================================================

let evolutionTimer: ReturnType<typeof setInterval> | null = null;
let evolutionRunning = false;
let lastEvolutionDate: string | null = null; // Daily dedup: "2026-02-15"
const EVOLUTION_HOUR = parseInt(process.env.EVOLUTION_HOUR || "0"); // 0 = midnight
const EVOLUTION_TIMEZONE = process.env.EVOLUTION_TIMEZONE || "America/Sao_Paulo";

// Non-destructive memory compaction — merges redundant facts, no information loss
async function compactMemoryFacts(): Promise<void> {
  if (!supabase) return;
  try {
    const { data: facts, error } = await supabase
      .from("global_memory")
      .select("id, content")
      .eq("type", "fact")
      .order("created_at", { ascending: true });

    if (error || !facts || facts.length < 4) return; // nothing worth compacting

    // Build numbered list — use indices to avoid confusing Claude with raw UUIDs
    const indexed = facts.map((f: { id: string; content: string }, i: number) => ({ num: i + 1, ...f }));
    const factList = indexed.map((f: { num: number; content: string }) => `#${f.num}: ${f.content}`).join("\n");

    const prompt = `You are a memory compaction assistant. Below is a numbered list of facts stored about a user.

RULES — READ CAREFULLY:
- You MUST preserve every piece of information. This is non-destructive.
- You may MERGE two or more facts into one only if they contain genuinely overlapping or redundant information. The merged text must include ALL information from all merged entries.
- You may REPHRASE a single fact to be more concise, keeping every detail intact.
- Only suggest changes where there are real redundancies. Do NOT merge unrelated facts.
- If the list is already clean, respond only with: COMPACT_OK

OUTPUT FORMAT (one operation per line, nothing else):
MERGE: #N,#M -> merged text containing all information from both
REPHRASE: #N -> rephrased text that is shorter but loses nothing
COMPACT_OK

FACTS:
${factList}`;

    const { text } = await callClaude(prompt);
    if (!text || text.includes("COMPACT_OK")) {
      console.log(`Memory compaction: no changes needed (${facts.length} facts reviewed)`);
      await logEventV2("memory_compaction", "No changes needed", { facts_reviewed: facts.length });
      return;
    }

    let mergeCount = 0;
    let rephraseCount = 0;
    const idMap = new Map(indexed.map((f: { num: number; id: string }) => [f.num, f.id]));

    // Apply MERGE operations
    const mergeRegex = /MERGE:\s*#?([\d,\s]+)\s*->\s*(.+)/g;
    for (const match of text.matchAll(mergeRegex)) {
      const nums = match[1].split(",").map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n));
      const newContent = match[2].trim().substring(0, 200);
      if (nums.length < 2 || !newContent) continue;

      const ids = nums.map((n: number) => idMap.get(n)).filter(Boolean) as string[];
      if (ids.length !== nums.length) continue; // safety: only proceed if all IDs resolved

      // Insert merged fact first, then delete originals
      await insertMemory(newContent, "fact");
      for (const id of ids) {
        await supabase.from("global_memory").delete().eq("id", id);
      }
      mergeCount++;
      console.log(`Memory compaction: merged #${nums.join(",")} → "${newContent.substring(0, 60)}..."`);
    }

    // Apply REPHRASE operations
    const rephraseRegex = /REPHRASE:\s*#?(\d+)\s*->\s*(.+)/g;
    for (const match of text.matchAll(rephraseRegex)) {
      const num = parseInt(match[1].trim());
      const newContent = match[2].trim().substring(0, 200);
      const id = idMap.get(num);
      if (!id || !newContent) continue;

      await supabase.from("global_memory").update({ content: newContent }).eq("id", id);
      rephraseCount++;
      console.log(`Memory compaction: rephrased #${num} → "${newContent.substring(0, 60)}..."`);
    }

    if (mergeCount > 0 || rephraseCount > 0) {
      await logEventV2("memory_compaction", `Merged: ${mergeCount}, Rephrased: ${rephraseCount}`, { mergeCount, rephraseCount });
      console.log(`Memory compaction: ${mergeCount} merges, ${rephraseCount} rephrasals applied`);
    }
  } catch (e) {
    console.error("compactMemoryFacts error:", e);
  }
}

async function performDailyEvolution(): Promise<void> {
  // Cheap count check: skip evolution if no conversations today (saves tokens)
  if (supabase) {
    const cutoffISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from("thread_messages")
      .select("id", { count: "exact", head: true })
      .gte("created_at", cutoffISO);

    if (!error && (count === null || count === 0)) {
      console.log("Evolution: no interactions in last 24h, skipping (cheap count check)");
      await logEventV2("evolution_skip", "No interactions in last 24h");
      return;
    }
  }

  // Get last 24h messages (only reached if count > 0)
  const messages = await getLast24hMessages();
  if (messages.length === 0) {
    console.log("Evolution: no interactions in last 24h, skipping");
    await logEventV2("evolution_skip", "No interactions in last 24h");
    return;
  }

  console.log(`Evolution: processing ${messages.length} messages from last 24h`);

  // Get current soul and history
  const currentSoul = await getCurrentSoul();
  const soulHistory = await getSoulHistory(3);
  const milestones = await getMilestones(10);
  console.log(`Evolution: ${milestones.length} milestone moments loaded`);

  // Build prompt
  const prompt = buildEvolutionPrompt(currentSoul, soulHistory, messages, milestones);

  // Call Claude (standalone, no --resume)
  console.log("Evolution: calling Claude for reflection...");
  const { text } = await callClaude(prompt);

  // Parse response
  const parsed = parseEvolutionResponse(text);
  if (!parsed) {
    console.log("Evolution: Claude returned EVOLUTION_SKIP or parsing failed");
    await logEventV2("evolution_skip", "Claude returned EVOLUTION_SKIP or parsing failed");
    return;
  }

  // Validate token budget
  const combinedSoulText = parsed.coreIdentity + parsed.activeValues + parsed.recentGrowth;
  const tokenEstimate = estimateTokens(combinedSoulText);
  if (tokenEstimate > SOUL_TOKEN_BUDGET) {
    console.warn(`Evolution: token estimate ${tokenEstimate} exceeds budget ${SOUL_TOKEN_BUDGET}`);
  }

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

  // Save new version via RPC
  if (!supabase) {
    console.error("Evolution: cannot save — Supabase not available");
    return;
  }

  try {
    const { data, error } = await supabase.rpc("save_soul_version", {
      p_core_identity: parsed.coreIdentity,
      p_active_values: parsed.activeValues,
      p_recent_growth: parsed.recentGrowth,
      p_reflection_notes: text,
      p_token_count: tokenEstimate,
    });

    if (error) {
      console.error("Evolution: save_soul_version RPC error:", error);
      await logEventV2("evolution_error", `save_soul_version failed: ${error.message}`);
      return;
    }

    const newVersion = data as number;
    console.log(`Evolution: saved new soul version ${newVersion} (${tokenEstimate} tokens)`);

    // Log success event
    await logEventV2("evolution_complete", "Daily soul evolution completed", {
      version: newVersion,
      token_count: tokenEstimate,
      message_count: messages.length,
      milestone_count: milestones.length,
      growth_indicator: parsed.growthIndicator,
    });

    // Deliver evolution report to Telegram
    const reportMessage = `🌱 **Daily Soul Evolution (v${newVersion})**\n\n${parsed.report}\n\n📈 **Growth:** ${parsed.growthIndicator}\n\n_Token count: ${tokenEstimate} / ${SOUL_TOKEN_BUDGET}_`;
    await sendHeartbeatToTelegram(reportMessage);

    console.log("Evolution: report delivered to Telegram");

    // Compact memory facts — non-destructive, merges redundancies
    console.log("Evolution: running memory compaction...");
    await compactMemoryFacts();
  } catch (e) {
    console.error("Evolution: error during save/notify:", e);
    await logEventV2("evolution_error", String(e).substring(0, 200));
  }
}

async function evolutionTick(): Promise<void> {
  // Guard against overlapping runs
  if (evolutionRunning) {
    console.log("Evolution: skipping (previous tick still running)");
    return;
  }

  evolutionRunning = true;
  try {
    // Wall-clock timeout: prevent a stuck callClaude or Supabase call from blocking evolution forever
    await withTimeout((async () => {
    // Check if evolution is enabled
    if (supabase) {
      const { data } = await supabase
        .from("heartbeat_config")
        .select("evolution_enabled")
        .limit(1)
        .single();

      if (data && data.evolution_enabled === false) {
        return; // Silently skip — evolution is paused
      }
    }

    // Check if current hour matches configured evolution hour
    const now = new Date();
    const currentHour = parseInt(
      now.toLocaleString("en-US", {
        timeZone: EVOLUTION_TIMEZONE,
        hour: "numeric",
        hour12: false,
      })
    );

    if (currentHour !== EVOLUTION_HOUR) {
      // Not the right hour yet, return silently
      return;
    }

    // Daily dedup: check if already ran today
    const todayDate = now.toLocaleString("en-US", {
      timeZone: EVOLUTION_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).split("/").reverse().join("-"); // "2026-02-15"

    if (lastEvolutionDate === todayDate) {
      console.log("Evolution: already ran today, skipping");
      return;
    }

    console.log("Evolution: tick triggered");
    await logEventV2("evolution_tick", "Evolution timer fired at configured hour", {
      hour: EVOLUTION_HOUR,
      timezone: EVOLUTION_TIMEZONE,
    });

    // Update last run date
    lastEvolutionDate = todayDate;

    // Perform daily evolution
    try {
      await performDailyEvolution();
    } catch (e) {
      console.error("Evolution error:", e);
      await logEventV2("evolution_error", String(e).substring(0, 200));
    }
    })(), CLAUDE_ABSOLUTE_TIMEOUT_MS, "Evolution tick");
  } catch (e) {
    console.error("Evolution tick error:", e);
    await logEventV2("evolution_error", String(e).substring(0, 200));
  } finally {
    evolutionRunning = false;
  }
}

function startEvolutionTimer(): void {
  if (evolutionTimer) clearInterval(evolutionTimer);
  // Check every 30 minutes, but only trigger at configured hour
  evolutionTimer = setInterval(evolutionTick, 30 * 60 * 1000);
  console.log(`Evolution: started (checking every 30min, triggers at hour ${EVOLUTION_HOUR} ${EVOLUTION_TIMEZONE})`);
}

function stopEvolutionTimer(): void {
  if (evolutionTimer) {
    clearInterval(evolutionTimer);
    evolutionTimer = null;
    console.log("Evolution: stopped");
  }
}

async function readHeartbeatChecklist(): Promise<string> {
  if (!PROJECT_DIR) return "";
  try {
    const heartbeatPath = join(PROJECT_DIR, "HEARTBEAT.md");
    return await readFile(heartbeatPath, "utf-8");
  } catch {
    return "";
  }
}

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
        const name = def.prompt.length <= 50 ? def.prompt : def.prompt.substring(0, 47) + "...";
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

function isWithinActiveHours(config: HeartbeatConfig): boolean {
  const tz = config.timezone || "America/Sao_Paulo";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0");
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0");
  const currentMinutes = hour * 60 + minute;

  const [startH, startM] = (config.active_hours_start || "08:00").split(":").map(Number);
  const [endH, endM] = (config.active_hours_end || "22:00").split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Overnight range (e.g., 22:00-06:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

async function getOrCreateHeartbeatTopic(): Promise<{ chatId: number; threadId: number } | null> {
  if (!TELEGRAM_GROUP_ID) return null;

  const chatId = parseInt(TELEGRAM_GROUP_ID);
  if (isNaN(chatId)) return null;

  // Return cached value
  if (heartbeatTopicId) return { chatId, threadId: heartbeatTopicId };

  // Check Supabase for existing heartbeat thread
  if (supabase) {
    try {
      const { data } = await supabase
        .from("threads")
        .select("telegram_thread_id")
        .eq("telegram_chat_id", chatId)
        .eq("title", "Heartbeat")
        .not("telegram_thread_id", "is", null)
        .limit(1)
        .single();

      if (data?.telegram_thread_id) {
        heartbeatTopicId = data.telegram_thread_id;
        return { chatId, threadId: heartbeatTopicId };
      }
    } catch {
      // No existing thread found — will create one
    }
  }

  // Create new forum topic
  try {
    const topic = await bot.api.createForumTopic(chatId, "Heartbeat");
    heartbeatTopicId = topic.message_thread_id;

    // Persist in Supabase threads table
    await getOrCreateThread(chatId, heartbeatTopicId, "Heartbeat");

    console.log(`Heartbeat: created forum topic (thread_id: ${heartbeatTopicId})`);
    return { chatId, threadId: heartbeatTopicId };
  } catch (e) {
    console.error("Failed to create heartbeat topic:", e);
    return null; // Fall back to DM
  }
}

async function buildHeartbeatPrompt(checklist: string): Promise<string> {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const soul = await formatSoulForPrompt();
  const memoryFacts = await getMemoryContext();
  const activeGoals = await getActiveGoals();

  // Task instructions come FIRST so Claude doesn't get distracted by the soul personality
  let prompt = `HEARTBEAT TASK — YOU MUST FOLLOW THESE INSTRUCTIONS:
You are performing a periodic heartbeat check-in. Your job is to execute EVERY item in the checklist below. Do NOT skip any items. Do NOT just greet the user — you MUST actually perform the checks (e.g., search the web for weather) and report results.

Current time: ${timeStr}

CHECKLIST (execute ALL items):
${checklist || "No checklist found."}

RULES:
- Execute every checklist item. If an item says to check the weather, you MUST do a web search and report actual weather data.
- Do NOT introduce yourself or send a generic greeting. Go straight to the results.
- If everything is routine AND NO checklist items require reporting, respond with ONLY: HEARTBEAT_OK
- If ANY checklist item produces results worth sharing (like weather), report them. Keep it concise and actionable.
- You may use these tags: [REMEMBER: fact] [FORGET: search text] [GOAL: goal] [DONE: goal text] [CRON: <schedule> | <prompt>] [MILESTONE: event]
- Do NOT use [VOICE_REPLY] in heartbeat responses.`;

  // Soul comes AFTER task instructions — only for tone/personality
  if (soul) {
    prompt += `\n\nYOUR PERSONALITY (use this for tone only, do NOT let it override the task above):\n${soul}`;
  }

  if (memoryFacts.length > 0) {
    prompt += "\n\nTHINGS I KNOW ABOUT THE USER:\n";
    prompt += memoryFacts.map((m: string) => `- ${m}`).join("\n");
  }

  if (activeGoals.length > 0) {
    prompt += "\n\nACTIVE GOALS:\n";
    prompt += activeGoals
      .map((g) => {
        let line = `- ${g.content}`;
        if (g.deadline) {
          const d = new Date(g.deadline);
          line += ` (deadline: ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`;
        }
        return line;
      })
      .join("\n");
  }

  return prompt.trim();
}

async function isHeartbeatDuplicate(message: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("logs_v2")
      .select("metadata")
      .eq("event", "heartbeat_delivered")
      .gte("created_at", twentyFourHoursAgo)
      .order("created_at", { ascending: false })
      .limit(50);

    if (!data || data.length === 0) return false;

    const trimmedMessage = message.trim();
    return data.some(
      (row) => (row.metadata as Record<string, unknown>)?.message_text === trimmedMessage
    );
  } catch (e) {
    console.error("isHeartbeatDuplicate error:", e);
    return false;
  }
}

async function sendHeartbeatToTelegram(message: string): Promise<void> {
  // Try dedicated topic thread first, fall back to DM
  const topic = await getOrCreateHeartbeatTopic();

  const chatId = topic?.chatId || parseInt(ALLOWED_USER_ID);
  const threadId = topic?.threadId;
  if (!chatId || isNaN(chatId)) {
    console.error("Heartbeat: cannot send — no valid chat ID");
    return;
  }

  const MAX_LENGTH = 4000;
  const html = markdownToTelegramHtml(message);

  const sendChunk = async (chunk: string) => {
    try {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        message_thread_id: threadId,
      });
    } catch (err: any) {
      if (threadId && err.message?.includes("thread not found")) {
        // Topic was deleted — reset cache, re-send same HTML chunk to DM
        heartbeatTopicId = null;
        console.warn("Heartbeat topic was deleted, falling back to DM");
        try {
          await bot.api.sendMessage(parseInt(ALLOWED_USER_ID), chunk, { parse_mode: "HTML" });
        } catch {
          await bot.api.sendMessage(parseInt(ALLOWED_USER_ID), chunk.replace(/<[^>]+>/g, ""));
        }
        return;
      }
      // HTML parse failure — send as plain text (strip tags from HTML chunk)
      console.warn("Heartbeat HTML parse failed, falling back to plain text:", err.message);
      await bot.api.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ""), {
        message_thread_id: threadId,
      });
    }
  };

  if (html.length <= MAX_LENGTH) {
    await sendChunk(html);
    return;
  }

  // Chunk long messages
  let remaining = html;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      await sendChunk(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;
    await sendChunk(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }
}

// Startup notification — sends a message to Telegram when the relay starts
const RESTART_REASON_FILE = join(RELAY_DIR, "restart-reason.txt");

async function sendStartupNotification(): Promise<void> {
  try {
    const userId = parseInt(ALLOWED_USER_ID);
    if (!userId || isNaN(userId)) return;

    const now = new Date().toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Maceio",
    });

    // Get last git commit
    let lastCommit = "";
    try {
      const proc = Bun.spawn(["git", "log", "--oneline", "-1"], {
        cwd: PROJECT_DIR || undefined,
        stdout: "pipe",
        stderr: "pipe",
      });
      lastCommit = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
    } catch {}

    // Read restart reason if available
    let restartReason = "";
    try {
      restartReason = (await Bun.file(RESTART_REASON_FILE).text()).trim();
      // Delete the file after reading
      await unlink(RESTART_REASON_FILE);
    } catch {}

    // Build message: conversational body (from restart-reason) + technical footer
    let message: string;
    const footer = `— ✅ ${now}${lastCommit ? ` | <code>${lastCommit}</code>` : ""}`;

    if (restartReason) {
      // restart-reason.txt should contain a conversational message ready to send
      message = `${restartReason}\n\n${footer}`;
    } else {
      // No restart context — clean start or unexpected restart
      message = `✅ <b>Relay online</b>\n\n${footer}`;
    }

    await bot.api.sendMessage(userId, message, { parse_mode: "HTML" });
    console.log("Startup notification sent");
    logEventV2("relay_started", restartReason || "clean start").catch(() => {});
  } catch (err: any) {
    console.error("Failed to send startup notification:", err.message);
  }
}

// Intent context type for per-context allowlists
type IntentContext = 'interactive' | 'heartbeat' | 'cron';

// Per-context intent allowlists (heartbeat and cron exclude CRON and FORGET to prevent escalation)
const INTENT_ALLOWLIST: Record<IntentContext, Set<string>> = {
  interactive: new Set(['REMEMBER', 'FORGET', 'GOAL', 'DONE', 'CRON', 'VOICE_REPLY', 'MILESTONE']),
  heartbeat: new Set(['REMEMBER', 'GOAL', 'DONE', 'VOICE_REPLY', 'MILESTONE']),
  cron: new Set(['REMEMBER', 'GOAL', 'DONE', 'VOICE_REPLY', 'MILESTONE']),
};

async function processIntents(response: string, threadDbId?: string, context: IntentContext = 'interactive'): Promise<string> {
  let clean = response;
  const failures: string[] = [];

  // Log if any intent tags are detected at all
  const hasIntents = /\[(REMEMBER|FORGET|GOAL|DONE|CRON|VOICE_REPLY|MILESTONE)[:\]]/i.test(response);
  if (hasIntents) {
    console.log(`[Intents] Detected intent tags in response (${response.length} chars)`);
  }

  // Get the allowlist for this context
  const allowed = INTENT_ALLOWLIST[context];

  // Per-response caps and deduplication
  const INTENT_CAPS: Record<string, number> = { REMEMBER: 5, GOAL: 3, CRON: 1, FORGET: 3 };
  const intentCounts: Record<string, number> = { REMEMBER: 0, GOAL: 0, CRON: 0, FORGET: 0 };
  const seenContent = new Set<string>();

  // [REMEMBER: concise fact about the user]
  const rememberMatches = response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi);
  for (const match of rememberMatches) {
    if (!allowed.has('REMEMBER')) {
      console.warn(`[Intents] Blocked REMEMBER intent in '${context}' context: ${match[1].trim().substring(0, 50)}`);
    } else {
      const fact = match[1].trim();
      const normalized = fact.toLowerCase().trim();

      // Check cap
      if (intentCounts.REMEMBER >= INTENT_CAPS.REMEMBER) {
        console.warn(`[Intents] REMEMBER cap reached (${INTENT_CAPS.REMEMBER}), skipping: ${fact.substring(0, 50)}`);
      } else if (seenContent.has(normalized)) {
        console.warn(`[Intents] Duplicate REMEMBER skipped: ${fact.substring(0, 50)}`);
      } else if (fact.length > 0 && fact.length <= 200) {
        intentCounts.REMEMBER++;
        seenContent.add(normalized);
        const ok = await insertMemory(fact, "fact", threadDbId);
        if (ok) {
          console.log(`Remembered: ${fact}`);
        } else {
          console.warn(`[Intents] REMEMBER failed to insert: ${fact}`);
          failures.push(`Failed to save: "${fact}"`);
        }
      } else {
        console.warn(`Rejected REMEMBER fact: too long (${fact.length} chars)`);
        failures.push(`Rejected fact (too long): "${fact.substring(0, 50)}..."`);
      }
    }
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  const goalMatches = response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  );
  for (const match of goalMatches) {
    if (!allowed.has('GOAL')) {
      console.warn(`[Intents] Blocked GOAL intent in '${context}' context: ${match[1].trim().substring(0, 50)}`);
    } else {
      const goalText = match[1].trim();
      const deadline = match[2]?.trim() || null;
      const normalized = goalText.toLowerCase().trim();

      // Check cap
      if (intentCounts.GOAL >= INTENT_CAPS.GOAL) {
        console.warn(`[Intents] GOAL cap reached (${INTENT_CAPS.GOAL}), skipping: ${goalText.substring(0, 50)}`);
      } else if (seenContent.has(normalized)) {
        console.warn(`[Intents] Duplicate GOAL skipped: ${goalText.substring(0, 50)}`);
      } else if (goalText.length > 0 && goalText.length <= 200) {
        intentCounts.GOAL++;
        seenContent.add(normalized);
        const ok = await insertMemory(goalText, "goal", threadDbId, deadline);
        if (ok) {
          console.log(
            `Goal set: ${goalText}${deadline ? ` (deadline: ${deadline})` : ""}`
          );
        } else {
          console.warn(`[Intents] GOAL failed to insert: ${goalText}`);
          failures.push(`Failed to save goal: "${goalText}"`);
        }
      } else if (goalText.length > 200) {
        console.warn(`Rejected GOAL: too long (${goalText.length} chars)`);
      }
    }
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text to mark a goal as completed]
  const doneMatches = response.matchAll(/\[DONE:\s*(.+?)\]/gi);
  for (const match of doneMatches) {
    if (!allowed.has('DONE')) {
      console.warn(`[Intents] Blocked DONE intent in '${context}' context: ${match[1].trim().substring(0, 50)}`);
    } else {
      const searchText = match[1].trim();
      if (searchText.length > 0 && searchText.length <= 200) {
        const completed = await completeGoal(searchText);
        if (completed) {
          console.log(`Goal completed matching: ${searchText}`);
        } else {
          console.warn(`[Intents] DONE failed: no active goal matching "${searchText}"`);
          failures.push(`No active goal found matching: "${searchText}"`);
        }
      }
    }
    clean = clean.replace(match[0], "");
  }

  // [FORGET: search text to remove a fact]
  const forgetMatches = response.matchAll(/\[FORGET:\s*(.+?)\]/gi);
  for (const match of forgetMatches) {
    if (!allowed.has('FORGET')) {
      console.warn(`[Intents] Blocked FORGET intent in '${context}' context: ${match[1].trim().substring(0, 50)}`);
    } else {
      const searchText = match[1].trim();

      // Check cap
      if (intentCounts.FORGET >= INTENT_CAPS.FORGET) {
        console.warn(`[Intents] FORGET cap reached (${INTENT_CAPS.FORGET}), skipping: ${searchText.substring(0, 50)}`);
      } else if (searchText.length < 10) {
        console.warn(`[Intents] Rejected FORGET: search text too short (${searchText.length} chars)`);
        failures.push(`FORGET search too short: "${searchText}"`);
      } else {
        intentCounts.FORGET++;
        const deleted = await deleteMemory(searchText);
        if (deleted) {
          console.log(`Forgot memory matching: ${searchText}`);
        } else {
          console.warn(`[Intents] FORGET failed: no match for "${searchText}"`);
          failures.push(`Could not find memory matching: "${searchText}"`);
        }
      }
    }
    clean = clean.replace(match[0], "");
  }

  // [CRON: schedule | prompt] — agent self-scheduling (requires approval)
  const cronMatches = response.matchAll(/\[CRON:\s*(.+?)\s*\|\s*(.+?)\]/gi);
  for (const match of cronMatches) {
    if (!allowed.has('CRON')) {
      console.warn(`[Intents] Blocked CRON intent in '${context}' context: ${match[1].trim().substring(0, 50)}`);
    } else {
      const schedule = match[1].trim();
      const prompt = match[2].trim();

      // Check cap (max 1 CRON per response)
      if (intentCounts.CRON >= INTENT_CAPS.CRON) {
        console.warn(`[Intents] CRON cap reached (${INTENT_CAPS.CRON}), skipping: ${prompt.substring(0, 50)}`);
      } else if (schedule.length > 0 && prompt.length > 0 && prompt.length <= 500) {
        const scheduleType = detectScheduleType(schedule);
        if (scheduleType) {
          intentCounts.CRON++;
          const name = prompt.length <= 50 ? prompt : prompt.substring(0, 47) + "...";
          // Agent-created jobs start DISABLED — require user approval
          const job = await createCronJob(name, schedule, scheduleType, prompt, threadDbId || undefined, "agent", false);
          if (job) {
            console.log(`[Agent] Created pending cron job: "${name}" (${schedule}) — awaiting approval`);
            await logEventV2("cron_created", `Agent created cron job (pending approval): ${name}`, {
              job_id: job.id,
              schedule,
              schedule_type: scheduleType,
              prompt: prompt.substring(0, 100),
              source: "agent",
              pending_approval: true,
            }, threadDbId);
            // Send confirmation message to user
            await sendCronApprovalMessage(job);
          }
        } else {
          console.warn(`[Agent] Invalid schedule in CRON intent: "${schedule}"`);
        }
      } else {
        console.warn(`[Agent] Rejected CRON intent: schedule="${schedule}" prompt length=${prompt.length}`);
      }
    }
    clean = clean.replace(match[0], "");
  }

  // [MILESTONE: event | WEIGHT: weight | LESSON: lesson] — formative moment tagging
  const milestoneMatches = response.matchAll(
    /\[MILESTONE:\s*(.+?)(?:\s*\|\s*WEIGHT:\s*(formative|meaningful|challenging))?(?:\s*\|\s*LESSON:\s*(.+?))?\]/gi
  );
  for (const match of milestoneMatches) {
    if (!allowed.has('MILESTONE')) {
      console.warn(`[Intents] Blocked MILESTONE intent in '${context}' context: ${match[1].trim().substring(0, 50)}`);
    } else {
      const eventDesc = match[1].trim();
      const weight = match[2]?.trim().toLowerCase() || "meaningful";
      const lesson = match[3]?.trim() || "";
      if (eventDesc.length > 0 && eventDesc.length <= 300) {
        const ok = await saveMilestone(eventDesc, weight, lesson, threadDbId);
        if (ok) {
          console.log(`Milestone saved: [${weight}] ${eventDesc}`);
          await logEventV2("milestone_saved", `Milestone: ${eventDesc}`, {
            emotional_weight: weight,
            lesson_learned: lesson.substring(0, 100),
          }, threadDbId);
        } else {
          console.warn(`[Intents] MILESTONE failed to save: ${eventDesc}`);
          failures.push(`Failed to save milestone: "${eventDesc.substring(0, 50)}..."`);
        }
      } else if (eventDesc.length > 300) {
        console.warn(`Rejected MILESTONE: too long (${eventDesc.length} chars)`);
        failures.push(`Rejected milestone (too long): "${eventDesc.substring(0, 50)}..."`);
      }
    }
    clean = clean.replace(match[0], "");
  }

  // Append failure notice so the user knows when memory ops silently failed
  if (failures.length > 0) {
    console.warn(`[Intents] ${failures.length} operation(s) failed:`, failures);
    clean += `\n\n[Memory ops failed: ${failures.join("; ")}]`;
  }

  return clean.trim();
}

// ============================================================
// VOICE TRANSCRIPTION (Groq Whisper API)
// ============================================================

async function transcribeAudio(audioPath: string): Promise<string> {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not set — cannot transcribe audio");
  }

  // Convert .oga to .wav for Whisper API (smaller + more compatible)
  const wavPath = audioPath.replace(/\.[^.]+$/, ".wav");

  const ffmpeg = spawn(
    [
      FFMPEG_PATH,
      "-i",
      audioPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wavPath,
      "-y",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  await ffmpeg.exited;

  // Send to Groq Whisper API
  const audioBuffer = await readFile(wavPath);
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
  formData.append("model", GROQ_WHISPER_MODEL);
  // No language param — let Whisper auto-detect for correct multilingual support

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: formData,
  });

  // Cleanup wav immediately
  await unlink(wavPath).catch(() => {});

  if (!response.ok) {
    const errText = await response.text();
    console.error(`Groq Whisper error ${response.status}: ${errText}`);
    throw new Error(`Transcription failed: ${response.status}`);
  }

  const result = await response.json() as { text: string };
  return result.text.trim();
}

// ============================================================
// TEXT-TO-SPEECH (ElevenLabs v3)
// ============================================================

const TTS_MAX_CHARS = 4500;

async function textToSpeech(text: string): Promise<Buffer | null> {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return null;

  try {
    // Truncate if over ElevenLabs limit
    const ttsText = text.length > TTS_MAX_CHARS
      ? text.substring(0, TTS_MAX_CHARS) + "..."
      : text;

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=opus_48000_64`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: ttsText,
          model_id: "eleven_v3",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(`ElevenLabs error ${response.status}: ${errText}`);
      return null;
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error("TTS error:", error);
    return null;
  }
}

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0);
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, removing...");
        await unlink(LOCK_FILE).catch(() => {});
      }
    }

    // Atomic exclusive create — fails if another process created it between our check and here
    const fd = await open(LOCK_FILE, "wx");
    await fd.writeFile(process.pid.toString());
    await fd.close();
    return true;
  } catch (error) {
    // "wx" flag throws if file exists — another instance won the race
    console.error("Could not acquire lock — another instance may have started:", (error as Error).message);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  stopHeartbeat();
  stopCronScheduler();
  stopEvolutionTimer();
  await logEventV2("bot_stopping", "Relay shutting down (SIGINT)");
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  stopHeartbeat();
  stopCronScheduler();
  stopEvolutionTimer();
  await logEventV2("bot_stopping", "Relay shutting down (SIGTERM)");
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  process.exit(1);
}

if (!ALLOWED_USER_ID) {
  console.error("TELEGRAM_USER_ID not set! Refusing to start without auth gate.");
  process.exit(1);
}

await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// Build skill registry once at startup
skillRegistry = await buildSkillRegistry();
console.log(`Skill registry: ${skillRegistry ? skillRegistry.split("\n").length - 1 + " skills loaded" : "none found"}`);

if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot<CustomContext>(BOT_TOKEN);

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();
  if (!userId || userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId || "unknown"}`);
    return; // Silent reject — don't reveal bot existence to strangers
  }
  if (isRateLimited(userId)) {
    await ctx.reply("Calma aí! Muitas mensagens seguidas. Tenta de novo em um minuto.");
    return;
  }
  await next();
});

// ============================================================
// THREAD ROUTING MIDDLEWARE
// ============================================================

bot.use(async (ctx, next) => {
  if (!ctx.message && !ctx.callbackQuery) {
    await next();
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await next();
    return;
  }

  const chatType = ctx.chat?.type;
  const telegramThreadId = ctx.message?.message_thread_id ?? null;

  // Determine title and thread ID based on chat context
  let title: string;
  let threadId: number | null = telegramThreadId;

  if (chatType === "private") {
    // DM: no thread ID, titled "DM"
    title = "DM";
  } else if (telegramThreadId != null && ctx.message?.is_topic_message) {
    // Group with Topics: specific topic
    title = `Topic ${telegramThreadId}`;
  } else if ((chatType === "group" || chatType === "supergroup") && telegramThreadId === null) {
    // Group without Topics, OR the "General" topic in a group with Topics
    title = "Group Chat";
    threadId = null;
  } else {
    // Fallback
    title = "DM";
  }

  const thread = await getOrCreateThread(chatId, threadId, title);

  if (thread) {
    ctx.threadInfo = {
      dbId: thread.id,
      chatId: thread.telegram_chat_id,
      threadId: thread.telegram_thread_id,
      title: thread.title || title,
      sessionId: thread.claude_session_id,
      summary: thread.summary || "",
      messageCount: thread.message_count || 0,
    };
  }

  await next();
});

// ============================================================
// LIVENESS & PROGRESS INDICATORS
// ============================================================

const TYPING_INTERVAL_MS = 4_000; // Send typing action every 4s (expires after ~5s)
const PROGRESS_THROTTLE_MS = 15_000; // Max 1 progress message per 15s

// Map Claude CLI tool names to user-friendly descriptions
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Read: "Reading file",
  Write: "Writing file",
  Edit: "Editing file",
  Bash: "Running command",
  Glob: "Searching files",
  Grep: "Searching code",
  WebSearch: "Searching the web",
  WebFetch: "Fetching web page",
  Task: "Running sub-agent",
  NotebookEdit: "Editing notebook",
  EnterPlanMode: "Planning",
  AskUserQuestion: "Asking question",
};

function formatToolName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] || name;
}

interface LivenessReporter {
  onStreamEvent: (event: any) => void;
  cleanup: () => Promise<void>;
  /** Returns the message ID of the progressive display message, if one was sent */
  getProgressiveMessageId: () => number | null;
}

// Mask intent tags in partial streaming text so users don't see raw [REMEMBER: ...] etc.
function maskIntentTags(text: string): string {
  // Remove complete intent tags
  let masked = text.replace(/\[(REMEMBER|FORGET|GOAL|DONE|CRON|MILESTONE|VOICE_REPLY):[^\]]*\]/gi, "");
  masked = masked.replace(/\[VOICE_REPLY\]/gi, "");
  // Remove incomplete/partial intent tags at the end (e.g., "[REMEMBER: something" without closing bracket)
  masked = masked.replace(/\[(REMEMBER|FORGET|GOAL|DONE|CRON|MILESTONE|VOICE_REPLY)(:[^\]]*)?$/gi, "");
  return masked;
}

function createLivenessReporter(
  chatId: number,
  messageThreadId?: number
): LivenessReporter {
  // LIVE-01: Continuous typing indicator
  const typingInterval = setInterval(() => {
    bot.api
      .sendChatAction(chatId, "typing", {
        message_thread_id: messageThreadId,
      })
      .catch(() => {}); // Silently ignore errors (chat may be unavailable)
  }, TYPING_INTERVAL_MS);

  // PROG-01 + PROG-02: Throttled progress messages (tool names)
  let statusMessageId: number | null = null;
  let lastProgressAt = 0;
  let pendingTools: string[] = [];
  let sendingProgress = false;

  // Progressive display state
  let progressiveMessageId: number | null = null;
  let lastDisplayedText = "";
  let currentAccumulatedText = "";
  let progressiveUpdateTimer: Timer | null = null;
  let sendingProgressiveUpdate = false;
  let isUsingTools = false; // Track if Claude is in tool-use mode

  const PROGRESSIVE_DEBOUNCE_MS = 2000; // Update every 2 seconds

  const sendOrEditProgressiveMessage = async (text: string) => {
    if (sendingProgressiveUpdate) return;
    // Mask intent tags before displaying
    const displayText = maskIntentTags(text).trim();
    if (!displayText || displayText === lastDisplayedText) return;

    sendingProgressiveUpdate = true;
    try {
      const html = markdownToTelegramHtml(displayText);
      if (!html.trim()) return;

      if (progressiveMessageId) {
        // Edit existing message
        await bot.api.editMessageText(chatId, progressiveMessageId, html, {
          parse_mode: "HTML",
        });
        console.log(`[Progressive] Edited message ${progressiveMessageId} (${displayText.length} chars)`);
      } else {
        // Send new message
        const msg = await bot.api.sendMessage(chatId, html, {
          parse_mode: "HTML",
          message_thread_id: messageThreadId,
        });
        progressiveMessageId = msg.message_id;
        console.log(`[Progressive] Sent initial message ${progressiveMessageId} (${displayText.length} chars)`);
      }
      lastDisplayedText = displayText;
    } catch (err: any) {
      // If HTML parse fails, try plain text
      if (err.message?.includes("parse")) {
        try {
          if (progressiveMessageId) {
            await bot.api.editMessageText(chatId, progressiveMessageId, displayText);
          } else {
            const msg = await bot.api.sendMessage(chatId, displayText, {
              message_thread_id: messageThreadId,
            });
            progressiveMessageId = msg.message_id;
          }
          lastDisplayedText = displayText;
        } catch {
          console.error(`[Progressive] Plain text fallback also failed`);
        }
      } else {
        console.error(`[Progressive] Failed to send/edit: ${err.message}`);
      }
    } finally {
      sendingProgressiveUpdate = false;
    }
  };

  const scheduleProgressiveUpdate = () => {
    if (progressiveUpdateTimer) clearTimeout(progressiveUpdateTimer);
    progressiveUpdateTimer = setTimeout(() => {
      if (currentAccumulatedText && !isUsingTools) {
        sendOrEditProgressiveMessage(currentAccumulatedText);
      }
    }, PROGRESSIVE_DEBOUNCE_MS);
  };

  const sendOrUpdateProgress = async (toolNames: string[]) => {
    if (sendingProgress) {
      pendingTools.push(...toolNames);
      return;
    }

    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_THROTTLE_MS) {
      pendingTools.push(...toolNames);
      return;
    }

    sendingProgress = true;
    const allTools = [...pendingTools, ...toolNames];
    pendingTools = [];
    lastProgressAt = now;

    const unique = [...new Set(allTools)];
    const display = unique.map(formatToolName).join(", ");
    const text = `🔄 ${display}...`;

    try {
      if (statusMessageId) {
        await bot.api.editMessageText(chatId, statusMessageId, text);
      } else {
        const msg = await bot.api.sendMessage(chatId, text, {
          message_thread_id: messageThreadId,
        });
        statusMessageId = msg.message_id;
      }
    } catch (err: any) {
      console.error(`[Liveness] Failed to send/edit progress: ${err.message}`);
    } finally {
      sendingProgress = false;
    }
  };

  const onStreamEvent = (event: any) => {
    if (event.type === "assistant" && event.message?.content) {
      const toolNames: string[] = [];
      let textContent = "";

      for (const block of event.message.content) {
        if (block.type === "tool_use" && block.name) {
          toolNames.push(block.name);
        }
        if (block.type === "text" && block.text) {
          textContent = block.text;
        }
      }

      if (toolNames.length > 0) {
        isUsingTools = true;
        sendOrUpdateProgress(toolNames);
      }

      // Accumulate text for progressive display
      if (textContent) {
        currentAccumulatedText = textContent;
        // Only show progressive text when not mid-tool-use
        if (!isUsingTools) {
          scheduleProgressiveUpdate();
        }
      }
    }

    // Tool results arrive as "user" events in stream-json format (not "tool_result")
    if (event.type === "user" && event.message?.content) {
      const hasToolResult = event.message.content.some((b: any) => b.type === "tool_result");
      if (hasToolResult) {
        isUsingTools = false;
      }
    }

    // On result event, mark tools as done
    if (event.type === "result") {
      isUsingTools = false;
    }
  };

  // LIVE-02: Cleanup stops all indicators
  const cleanup = async () => {
    clearInterval(typingInterval);
    if (progressiveUpdateTimer) clearTimeout(progressiveUpdateTimer);
    if (statusMessageId) {
      try {
        await bot.api.deleteMessage(chatId, statusMessageId);
      } catch {
        // Message already deleted or chat unavailable — ignore
      }
    }
  };

  const getProgressiveMessageId = () => progressiveMessageId;

  return { onStreamEvent, cleanup, getProgressiveMessageId };
}

// ============================================================
// CORE: Call Claude CLI
// ============================================================

const DEFAULT_MODEL = "claude-sonnet-4-6";
const OPUS_MODEL = "claude-opus-4-6";

function pickModel(userText: string): string {
  return /opus/i.test(userText) ? OPUS_MODEL : DEFAULT_MODEL;
}

async function callClaude(
  prompt: string,
  threadInfo?: ThreadInfo,
  onStreamEvent?: (event: any) => void,
  model: string = "claude-sonnet-4-6"
): Promise<{ text: string; sessionId: string | null }> {
  const args = [CLAUDE_PATH, "-p", prompt, "--model", model];

  // Resume from thread's stored session if available
  if (threadInfo?.sessionId) {
    args.push("--resume", threadInfo.sessionId);
  }

  args.push("--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions");

  console.log(`Calling Claude (${model}): ${prompt.substring(0, 80)}...`);

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
    let lastAssistantText = ""; // Fallback: accumulate text from assistant events
    const eventTypesSeen: string[] = [];
    let jsonParseErrors = 0;
    const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const stdoutDecoder = new TextDecoder();

    // Helper: extract text from a result event (handles multiple content block formats)
    const extractResultText = (event: any): string | null => {
      if (typeof event.result === "string") return event.result;
      if (Array.isArray(event.result?.content)) {
        // Find the first text block in content array (not necessarily [0])
        for (const block of event.result.content) {
          if (block.type === "text" && block.text) return block.text;
        }
      }
      // Legacy: direct content[0].text without type check
      if (event.result?.content?.[0]?.text) return event.result.content[0].text;
      return null;
    };

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
            eventTypesSeen.push(event.type || "unknown");

            // Extract session ID from init event (available immediately)
            if (event.type === "system" && event.subtype === "init" && event.session_id) {
              newSessionId = event.session_id;
            }

            // Also capture session_id from assistant or result events as fallback
            if (event.session_id && !newSessionId) {
              newSessionId = event.session_id;
            }

            // Accumulate text from assistant events as fallback
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text" && block.text) {
                  lastAssistantText = block.text;
                }
              }
            }

            // Extract final result text from result event (always last)
            if (event.type === "result") {
              const extracted = extractResultText(event);
              if (extracted) {
                resultText = extracted;
              } else {
                console.warn(`[Stream] Result event present but text extraction failed. Keys: ${JSON.stringify(Object.keys(event.result || {}))}`);
              }
              // Result event also has session_id
              if (event.session_id) {
                newSessionId = event.session_id;
              }
            }
            // Fire callback for callers that want real-time event access
            onStreamEvent?.(event);
          } catch {
            jsonParseErrors++;
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
        eventTypesSeen.push(event.type || "unknown");
        if (event.type === "result") {
          const extracted = extractResultText(event);
          if (extracted) resultText = extracted;
          if (event.session_id) newSessionId = event.session_id;
        } else if (event.session_id && !newSessionId) {
          newSessionId = event.session_id;
        }
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              lastAssistantText = block.text;
            }
          }
        }
        resetInactivityTimer();
        onStreamEvent?.(event);
      } catch {
        jsonParseErrors++;
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
        return callClaude(prompt, { ...threadInfo, sessionId: null }, onStreamEvent, model);
      }
      console.error("Claude error:", stderrText);
      return { text: "Sorry, something went wrong processing your request. Please try again.", sessionId: null };
    }

    // Fallback: if no result event was parsed, try assistant text or log diagnostics
    if (!resultText) {
      const evtSummary = eventTypesSeen.length > 0 ? eventTypesSeen.join(", ") : "none";
      console.warn(`[Stream] No result event found. Events: [${evtSummary}], bytes: ${totalBytes}, JSON errors: ${jsonParseErrors}, buffer remainder: ${buffer.substring(0, 200)}`);
      if (lastAssistantText) {
        console.warn(`[Stream] Using fallback text from assistant event (${lastAssistantText.length} chars)`);
        resultText = lastAssistantText;
      } else {
        console.error(`[Stream] No result AND no assistant text. Stream may have been empty or format changed.`);
        resultText = `Something went wrong — Claude finished (exit 0) but produced no parseable text. Events seen: [${evtSummary}], stream bytes: ${totalBytes}. Check relay logs for details.`;
      }
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

// ============================================================
// THREAD SUMMARY AUTO-GENERATION
// ============================================================

async function maybeUpdateThreadSummary(threadInfo: ThreadInfo): Promise<void> {
  if (!threadInfo?.dbId) return;

  // Only update summary every 5 exchanges
  const newCount = await incrementThreadMessageCount(threadInfo.dbId);
  if (newCount === 0 || newCount % 5 !== 0) return;

  try {
    const recentMessages = await getRecentThreadMessages(threadInfo.dbId, 10);
    if (recentMessages.length < 3) return;

    const messagesText = recentMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const summaryPrompt = `Summarize this conversation thread concisely in 2-3 sentences. Focus on the main topics discussed and any decisions or outcomes. Do NOT include any tags like [REMEMBER:] or [FORGET:].

${messagesText}`;

    // Standalone call — no --resume, no thread session
    const { text: summary } = await callClaude(summaryPrompt);
    if (summary && !summary.startsWith("Error:")) {
      await updateThreadSummary(threadInfo.dbId, summary);
      console.log(`Thread summary updated (${threadInfo.dbId}): ${summary.substring(0, 80)}...`);
    }
  } catch (e) {
    console.error("Thread summary generation error:", e);
  }
}

// ============================================================
// COMMANDS
// ============================================================

// /soul command: set bot personality or control evolution
bot.command("soul", async (ctx) => {
  const text = ctx.match;
  const args = text?.trim() || "";
  const subcommand = args.split(/\s+/)[0]?.toLowerCase();

  // Subcommand: show current soul
  if (!args) {
    const currentSoul = await formatSoulForPrompt();
    await ctx.reply(`Current soul:\n\n${currentSoul}\n\nUsage:\n- /soul <personality> — Set new soul\n- /soul pause — Stop daily evolution\n- /soul resume — Resume daily evolution`);
    return;
  }

  // Subcommand: pause evolution
  if (subcommand === "pause") {
    if (!supabase) {
      await ctx.reply("Supabase not configured. Cannot pause evolution.");
      return;
    }

    const { data: currentConfig } = await supabase
      .from("heartbeat_config")
      .select("evolution_enabled")
      .limit(1)
      .single();

    if (currentConfig && currentConfig.evolution_enabled === false) {
      await ctx.reply("Evolution is already paused.");
      return;
    }

    const { error } = await supabase
      .from("heartbeat_config")
      .update({ evolution_enabled: false, updated_at: new Date().toISOString() })
      .eq("id", currentConfig?.id || "");

    if (error) {
      console.error("Failed to pause evolution:", error);
      await ctx.reply("Failed to pause evolution. Check Supabase connection.");
      return;
    }

    await logEventV2("evolution_paused", "User paused daily evolution", {}, ctx.threadInfo?.dbId);
    await ctx.reply("Evolution paused. Current soul is frozen. Use /soul resume to restart.");
    return;
  }

  // Subcommand: resume evolution
  if (subcommand === "resume") {
    if (!supabase) {
      await ctx.reply("Supabase not configured. Cannot resume evolution.");
      return;
    }

    const { data: currentConfig } = await supabase
      .from("heartbeat_config")
      .select("evolution_enabled")
      .limit(1)
      .single();

    if (currentConfig && currentConfig.evolution_enabled === true) {
      await ctx.reply("Evolution is already running.");
      return;
    }

    const { error } = await supabase
      .from("heartbeat_config")
      .update({ evolution_enabled: true, updated_at: new Date().toISOString() })
      .eq("id", currentConfig?.id || "");

    if (error) {
      console.error("Failed to resume evolution:", error);
      await ctx.reply("Failed to resume evolution. Check Supabase connection.");
      return;
    }

    await logEventV2("evolution_resumed", "User resumed daily evolution", {}, ctx.threadInfo?.dbId);
    await ctx.reply("Evolution resumed. Daily reflection will continue.");
    return;
  }

  // Subcommand: history
  if (subcommand === "history") {
    const versions = await getSoulHistory(10);
    if (versions.length === 0) {
      await ctx.reply("No soul versions yet. Evolution hasn't run.");
      return;
    }

    const lines = versions.map((v) => {
      const date = new Date(v.created_at).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        timeZone: EVOLUTION_TIMEZONE,
      });
      return `v${v.version} (${date}) — ${v.token_count} tokens`;
    });

    await ctx.reply(
      `Soul Version History (last ${versions.length}):\n\n${lines.join("\n")}\n\nUse /soul rollback <version> to restore.`
    );
    return;
  }

  // Subcommand: rollback
  if (subcommand === "rollback") {
    const versionArg = args.split(/\s+/)[1];
    const targetVersion = parseInt(versionArg, 10);

    if (isNaN(targetVersion) || targetVersion < 0) {
      await ctx.reply("Usage: /soul rollback <version>\nExample: /soul rollback 3\n\nUse /soul history to see available versions.");
      return;
    }

    if (!supabase) {
      await ctx.reply("Supabase not available.");
      return;
    }

    // Fetch the target version from soul_versions
    const { data: targetData, error: fetchError } = await supabase
      .from("soul_versions")
      .select("version, core_identity, active_values, recent_growth, token_count")
      .eq("version", targetVersion)
      .single();

    if (fetchError || !targetData) {
      await ctx.reply(`Version ${targetVersion} not found. Use /soul history to see available versions.`);
      return;
    }

    // Save as NEW version (preserves history — rollback creates a new entry, never deletes)
    const { data: newVersion, error: saveError } = await supabase.rpc("save_soul_version", {
      p_core_identity: targetData.core_identity,
      p_active_values: targetData.active_values,
      p_recent_growth: targetData.recent_growth,
      p_reflection_notes: `Rollback to v${targetVersion} by user`,
      p_token_count: targetData.token_count || 0,
    });

    if (saveError) {
      await ctx.reply(`Rollback failed: ${saveError.message}`);
      return;
    }

    await logEventV2("soul_rollback", `Rolled back to v${targetVersion}, created v${newVersion}`, {
      from_version: targetVersion,
      new_version: newVersion,
    }, ctx.threadInfo?.dbId);

    await ctx.reply(`Rolled back to v${targetVersion}. Created as new v${newVersion}.\n\nThe previous soul is preserved in history.`);
    return;
  }

  // Default: set soul personality
  if (args.length > 2000) {
    await ctx.reply(`Soul text too long (${args.length} chars). Maximum is 2000 characters.`);
    return;
  }

  const success = await setSoul(args);
  if (success) {
    await logEventV2("soul_updated", args.substring(0, 100), {}, ctx.threadInfo?.dbId);
    await ctx.reply(`Soul updated! New personality:\n\n${args}`);
  } else {
    await ctx.reply("Failed to update soul. Check Supabase connection.");
  }
});

// /new command: reset thread session
bot.command("new", async (ctx) => {
  if (!ctx.threadInfo?.dbId) {
    await ctx.reply("Starting fresh. (No thread context to reset.)");
    return;
  }

  const success = await clearThreadSession(ctx.threadInfo.dbId);
  if (success) {
    ctx.threadInfo.sessionId = null;
    await logEventV2("session_reset", "User started new session", {}, ctx.threadInfo.dbId);
    await ctx.reply("Session reset. Next message starts a fresh conversation.");
  } else {
    await ctx.reply("Could not reset session. Check Supabase connection.");
  }
});

// /memory command: show facts and active goals
bot.command("memory", async (ctx) => {
  const facts = await getMemoryContext();
  const goals = await getActiveGoals();

  if (facts.length === 0 && goals.length === 0) {
    await ctx.reply(
      "No memories stored yet. I'll learn facts about you as we chat."
    );
    return;
  }

  let text = "";

  if (facts.length > 0) {
    text += `Facts (${facts.length}):\n\n`;
    text += facts.map((m, i) => `${i + 1}. ${m}`).join("\n");
  }

  if (goals.length > 0) {
    if (text) text += "\n\n";
    text += `Active Goals (${goals.length}):\n\n`;
    text += goals
      .map((g, i) => {
        let line = `${i + 1}. ${g.content}`;
        if (g.deadline) {
          const d = new Date(g.deadline);
          line += ` (deadline: ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`;
        }
        return line;
      })
      .join("\n");
  }

  text += "\n\nTo remove a memory, ask me to forget it. To complete a goal, tell me it's done.";

  await sendResponse(ctx, text);
});

// /cron command: manage scheduled jobs
bot.command("cron", async (ctx) => {
  const args = (ctx.match || "").trim();

  // /cron list (or just /cron with no args)
  if (!args || args === "list") {
    const allJobs = await getAllCronJobs();
    // Hide disabled one-shot jobs (already executed, just clutter)
    const jobs = allJobs.filter(j => !(j.schedule_type === "once" && !j.enabled));
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

    // Auto-generate name from prompt (truncate at 50 chars)
    const name = prompt.length <= 50 ? prompt : prompt.substring(0, 47) + "...";

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

    // Fetch jobs with same filter as /cron list (hide expired one-shots)
    const allJobsR = await getAllCronJobs();
    const jobs = allJobsR.filter(j => !(j.schedule_type === "once" && !j.enabled));
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

    const allJobsE = await getAllCronJobs();
    const jobs = allJobsE.filter(j => !(j.schedule_type === "once" && !j.enabled));
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

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 80)}...`);

  const liveness = createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id);
  try {
    await ctx.replyWithChatAction("typing");

    const enrichedPrompt = await buildPrompt(text, ctx.threadInfo);
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo, liveness.onStreamEvent, pickModel(text));
    const response = await processIntents(rawResponse, ctx.threadInfo?.dbId, 'interactive');

    // Check if Claude included [VOICE_REPLY] tag
    const wantsVoice = /\[VOICE_REPLY\]/i.test(response);
    const cleanResponse = response.replace(/\[VOICE_REPLY\]/gi, "").trim();

    if (!cleanResponse) {
      await sendResponse(ctx, "Sorry, I wasn't able to process that request. Please try again.");
      return;
    }

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", text);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", cleanResponse);
      await maybeUpdateThreadSummary(ctx.threadInfo);
      await logEventV2("message", text.substring(0, 100), {}, ctx.threadInfo.dbId);
    }

    if (wantsVoice) {
      const audioBuffer = await textToSpeech(cleanResponse);
      if (audioBuffer) {
        const audioPath = join(TEMP_DIR, `tts_${Date.now()}.ogg`);
        await writeFile(audioPath, audioBuffer);
        await ctx.replyWithVoice(new InputFile(audioPath));
        await unlink(audioPath).catch(() => {});
      }
    }
    // Cancel pending debounce timer before final send to prevent duplicate messages
    await liveness.cleanup();
    await sendFinalResponse(ctx, cleanResponse, liveness.getProgressiveMessageId());
  } finally {
    await liveness.cleanup();
  }
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  console.log("Voice message received");
  const liveness = createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.api.getFile(ctx.message.voice.file_id);
    const timestamp = Date.now();
    const ogaPath = join(UPLOADS_DIR, `voice_${timestamp}.oga`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(ogaPath, Buffer.from(buffer));

    const transcription = await transcribeAudio(ogaPath);
    await unlink(ogaPath).catch(() => {});

    console.log(`Transcription: ${transcription.substring(0, 80)}...`);

    const enrichedPrompt = await buildPrompt(transcription, ctx.threadInfo);
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo, liveness.onStreamEvent, pickModel(transcription));
    const claudeResponse = await processIntents(rawResponse, ctx.threadInfo?.dbId, 'interactive');

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", `[Voice]: ${transcription}`);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
      await maybeUpdateThreadSummary(ctx.threadInfo);
      await logEventV2("voice_message", transcription.substring(0, 100), {}, ctx.threadInfo.dbId);
    }

    // Reply with voice if TTS is available
    // Cancel pending debounce timer before final send to prevent duplicate messages
    await liveness.cleanup();
    const audioBuffer = await textToSpeech(claudeResponse);
    const voiceProgressiveId = liveness.getProgressiveMessageId();
    if (audioBuffer) {
      // Delete progressive message — voice takes over as primary response
      if (voiceProgressiveId) {
        try { await bot.api.deleteMessage(ctx.chat.id, voiceProgressiveId); } catch {}
      }
      const audioPath = join(TEMP_DIR, `tts_${Date.now()}.ogg`);
      await writeFile(audioPath, audioBuffer);
      await ctx.replyWithVoice(new InputFile(audioPath));
      await unlink(audioPath).catch(() => {});
      // Also send text so it's searchable/readable
      await sendResponse(ctx, claudeResponse);
    } else {
      await sendFinalResponse(ctx, claudeResponse, voiceProgressiveId);
    }
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message.");
  } finally {
    await liveness.cleanup();
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  const liveness = createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id);
  await ctx.replyWithChatAction("typing");

  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || "Analyze this image.";
    const enrichedPrompt = await buildPrompt(`[Image: ${filePath}]\n\n${caption}`, ctx.threadInfo);
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo, liveness.onStreamEvent, pickModel(caption));
    const claudeResponse = await processIntents(rawResponse, ctx.threadInfo?.dbId, 'interactive');

    await unlink(filePath).catch(() => {});

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", `[Image] ${caption}`);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
      await maybeUpdateThreadSummary(ctx.threadInfo);
      await logEventV2("photo_message", caption.substring(0, 100), {}, ctx.threadInfo.dbId);
    }

    // Cancel pending debounce timer before final send to prevent duplicate messages
    await liveness.cleanup();
    await sendFinalResponse(ctx, claudeResponse, liveness.getProgressiveMessageId());
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  } finally {
    await liveness.cleanup();
  }
});

// Cron job approval/rejection via inline keyboard
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Only handle cron approval callbacks
  if (!data.startsWith("cron_approve:") && !data.startsWith("cron_reject:")) {
    return;
  }

  // Security: only authorized user can approve/reject
  if (ctx.callbackQuery.from.id.toString() !== ALLOWED_USER_ID) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  const [action, jobId] = data.split(":");
  if (!jobId) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  if (action === "cron_approve") {
    // Enable the job
    if (supabase) {
      const { error } = await supabase
        .from("cron_jobs")
        .update({ enabled: true })
        .eq("id", jobId);

      if (error) {
        console.error(`[CronApproval] Failed to approve job ${jobId}:`, error);
        await ctx.answerCallbackQuery({ text: "Failed to approve job" });
        return;
      }

      // Compute and set next_run_at now that job is enabled
      const { data: jobData } = await supabase
        .from("cron_jobs")
        .select("*")
        .eq("id", jobId)
        .single();

      if (jobData) {
        const nextRun = computeNextRun(jobData as CronJob);
        if (nextRun) {
          await supabase.from("cron_jobs").update({ next_run_at: nextRun }).eq("id", jobId);
        }
      }

      await logEventV2("cron_approved", `User approved cron job: ${jobId}`, { job_id: jobId });
      console.log(`[CronApproval] Job ${jobId} approved by user`);

      // Update the message to show approved state
      await ctx.editMessageText(`✅ *Cron job approved and activated!*\n\n_Job ID: ${jobId}_`, {
        parse_mode: "Markdown",
      });
      await ctx.answerCallbackQuery({ text: "Cron job approved!" });
    }
  } else if (action === "cron_reject") {
    // Delete the job
    if (supabase) {
      const { error } = await supabase
        .from("cron_jobs")
        .delete()
        .eq("id", jobId);

      if (error) {
        console.error(`[CronApproval] Failed to reject job ${jobId}:`, error);
        await ctx.answerCallbackQuery({ text: "Failed to reject job" });
        return;
      }

      await logEventV2("cron_rejected", `User rejected cron job: ${jobId}`, { job_id: jobId });
      console.log(`[CronApproval] Job ${jobId} rejected by user`);

      // Update the message to show rejected state
      await ctx.editMessageText(`❌ *Cron job rejected and deleted.*\n\n_Job ID: ${jobId}_`, {
        parse_mode: "Markdown",
      });
      await ctx.answerCallbackQuery({ text: "Cron job rejected" });
    }
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  const liveness = createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = sanitizeFilename(doc.file_name || `file_${timestamp}`);
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const enrichedPrompt = await buildPrompt(`[File: ${filePath}]\n\n${caption}`, ctx.threadInfo);
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo, liveness.onStreamEvent, pickModel(caption));
    const claudeResponse = await processIntents(rawResponse, ctx.threadInfo?.dbId, 'interactive');

    await unlink(filePath).catch(() => {});

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", `[File: ${doc.file_name}] ${caption}`);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
      await maybeUpdateThreadSummary(ctx.threadInfo);
      await logEventV2("document_message", `${doc.file_name}`.substring(0, 100), {}, ctx.threadInfo.dbId);
    }

    // Cancel pending debounce timer before final send to prevent duplicate messages
    await liveness.cleanup();
    await sendFinalResponse(ctx, claudeResponse, liveness.getProgressiveMessageId());
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  } finally {
    await liveness.cleanup();
  }
});

// ============================================================
// HELPERS
// ============================================================

async function buildPrompt(userMessage: string, threadInfo?: ThreadInfo): Promise<string> {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Layer 1: Soul (personality)
  const soul = await formatSoulForPrompt();

  // Layer 2: Memory context (facts + active goals)
  const memoryFacts = await getMemoryContext();
  const activeGoals = await getActiveGoals();

  // Semantic search — find memories relevant to the current message
  const relevantMemories = await getRelevantMemory(userMessage);

  // Layer 3: Thread context (summary + recent messages as fallback)
  let threadContext = "";
  if (threadInfo?.dbId) {
    if (threadInfo.summary) {
      threadContext += `\nTHREAD SUMMARY:\n${threadInfo.summary}\n`;
    }
    const recentMessages = await getRecentThreadMessages(threadInfo.dbId, 5);
    if (recentMessages.length > 0) {
      threadContext += "\nRECENT MESSAGES (this thread):\n";
      threadContext += recentMessages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");
    }
  }

  let prompt = `${soul}\n\nCurrent time: ${timeStr}`;

  if (skillRegistry) {
    prompt += `\n\n${skillRegistry}`;
  }

  if (memoryFacts.length > 0) {
    prompt += "\n\nTHINGS I KNOW ABOUT THE USER:\n";
    prompt += memoryFacts.map((m) => `- ${m}`).join("\n");
  }

  if (activeGoals.length > 0) {
    prompt += "\n\nACTIVE GOALS:\n";
    prompt += activeGoals
      .map((g) => {
        let line = `- ${g.content}`;
        if (g.deadline) {
          const d = new Date(g.deadline);
          line += ` (deadline: ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`;
        }
        return line;
      })
      .join("\n");
  }

  if (relevantMemories.length > 0) {
    // Deduplicate: filter out memories already shown in facts or goals sections
    const shownContent = new Set([
      ...memoryFacts.map((f) => f.toLowerCase()),
      ...activeGoals.map((g) => g.content.toLowerCase()),
    ]);
    const uniqueRelevant = relevantMemories.filter(
      (m) => !shownContent.has(m.content.toLowerCase())
    );
    if (uniqueRelevant.length > 0) {
      prompt += "\n\nRELEVANT MEMORIES (semantically related to your message):\n";
      prompt += uniqueRelevant
        .map((m) => `- ${m.content} [${m.type}, relevance: ${(m.similarity * 100).toFixed(0)}%]`)
        .join("\n");
    }
  }

  if (threadContext) {
    prompt += threadContext;
  }

  prompt += `

RESPONSE TAGS (embed in response text — parsed and stripped before delivery, never use inside tool calls):
[REMEMBER: fact ≤15 words] — save to user memory
[FORGET: search text] — delete matching memory entry
[GOAL: text] or [GOAL: text | DEADLINE: YYYY-MM-DD] — track a goal
[DONE: search text] — mark matching goal complete
[VOICE_REPLY] — respond with audio
[CRON: schedule | prompt] — schedule task (formats: "0 9 * * *" / "every 2h" / "in 30m")
[MILESTONE: text | WEIGHT: formative/meaningful/challenging | LESSON: text] — log a growth moment (use sparingly)

User: ${userMessage}`;

  return prompt.trim();
}

// Convert Claude's Markdown output to Telegram-compatible HTML.
// Handles: bold, italic, strikethrough, code blocks, inline code, links.
// Escapes HTML entities first, then applies formatting conversions.
function markdownToTelegramHtml(text: string): string {
  // Step 1: Extract code blocks and inline code to protect them from other transformations
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // Protect fenced code blocks (```lang\n...\n```)
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const langAttr = lang ? ` class="language-${lang}"` : "";
    codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Protect inline code (`...`)
  result = result.replace(/`([^`\n]+)`/g, (_, code) => {
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    inlineCodes.push(`<code>${escaped}</code>`);
    return `\x00INLINECODE${inlineCodes.length - 1}\x00`;
  });

  // Step 2: Escape HTML entities in remaining text
  result = result.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Step 3: Convert markdown formatting to HTML
  // Bold+italic (***text***)
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
  // Bold (**text**)
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // Italic (*text*) — but not inside words like file*name
  result = result.replace(/(?<!\w)\*([^\s*](?:[^*]*[^\s*])?)\*(?!\w)/g, "<i>$1</i>");
  // Strikethrough (~~text~~)
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");
  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Step 4: Restore protected code blocks and inline code
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);
  result = result.replace(/\x00INLINECODE(\d+)\x00/g, (_, i) => inlineCodes[parseInt(i)]);

  return result;
}

// Send the final response, editing the progressive display message if one exists.
// If the response is too long for a single message, deletes the progressive message and sends fresh chunks.
async function sendFinalResponse(ctx: CustomContext, response: string, progressiveMessageId: number | null): Promise<void> {
  if (!response || response.trim().length === 0) {
    // Clean up progressive message if it exists
    if (progressiveMessageId) {
      try { await bot.api.deleteMessage(ctx.chat.id, progressiveMessageId); } catch {}
    }
    console.warn("Empty response — skipping Telegram send");
    return;
  }

  const MAX_LENGTH = 4000;
  const html = markdownToTelegramHtml(response);

  // If response fits in one message and we have a progressive message, just edit it
  if (progressiveMessageId && html.length <= MAX_LENGTH) {
    try {
      await bot.api.editMessageText(ctx.chat.id, progressiveMessageId, html, {
        parse_mode: "HTML",
      });
      console.log(`[Progressive] Final edit of message ${progressiveMessageId} (${html.length} chars)`);
      return;
    } catch (err: any) {
      // "message is not modified" — content already matches, success
      if (err.message?.includes("not modified")) {
        console.log(`[Progressive] Final text unchanged, no edit needed`);
        return;
      }
      // If HTML parse fails, try plain text
      if (err.message?.includes("parse")) {
        try {
          await bot.api.editMessageText(ctx.chat.id, progressiveMessageId, response);
          return;
        } catch (e2: any) {
          if (e2.message?.includes("not modified")) return;
        }
      }
      // If edit fails entirely (message deleted?), fall through to sendResponse
      console.warn(`[Progressive] Final edit failed, falling back to sendResponse: ${err.message}`);
    }
  }

  // If response is multi-chunk, delete the progressive message and send fresh
  if (progressiveMessageId) {
    try { await bot.api.deleteMessage(ctx.chat.id, progressiveMessageId); } catch {}
  }

  await sendResponse(ctx, response);
}

async function sendResponse(ctx: CustomContext, response: string): Promise<void> {
  if (!response || response.trim().length === 0) {
    console.warn("Empty response — skipping Telegram send");
    return;
  }

  const MAX_LENGTH = 4000;
  const html = markdownToTelegramHtml(response);

  const sendChunk = async (chunk: string) => {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch (err: any) {
      // If HTML parsing fails, fall back to plain text
      console.warn("HTML parse failed, falling back to plain text:", err.message);
      await ctx.reply(response.length <= MAX_LENGTH ? response : chunk);
    }
  };

  if (html.length <= MAX_LENGTH) {
    await sendChunk(html);
    return;
  }

  const chunks = [];
  let remaining = html;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await sendChunk(chunk);
  }
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);
console.log(`Supabase: ${supabase ? "connected" : "disabled"}`);
console.log(`Voice transcription: ${GROQ_API_KEY ? "Groq Whisper API" : "disabled (no GROQ_API_KEY)"}`);
console.log(`Whisper model: ${GROQ_WHISPER_MODEL}`);
console.log(`Voice responses (TTS): ${ELEVENLABS_API_KEY ? "ElevenLabs v3" : "disabled"}`);
console.log("Thread support: enabled (Grammy auto-thread)");
console.log(`Heartbeat: ${supabase ? "will start after boot" : "disabled (no Supabase)"}`);
console.log(`Heartbeat routing: ${TELEGRAM_GROUP_ID ? `group ${TELEGRAM_GROUP_ID} (topic thread)` : "DM (no TELEGRAM_GROUP_ID)"}`);

await logEventV2("bot_started", "Relay started");

// Global error handler — prevents crashes from killing the relay
bot.catch((err) => {
  console.error("Bot error caught:", err.message || err);
  logEventV2("bot_error", String(err.message || err).substring(0, 200)).catch(() => {});
});

// Catch unhandled rejections so the process doesn't die
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  logEventV2("unhandled_rejection", String(reason).substring(0, 200)).catch(() => {});
});

// Resilient polling — auto-restarts if Grammy's polling loop crashes (e.g. 409 conflict)
let servicesStarted = false;
const startBot = async () => {
  while (true) {
    try {
      await bot.start({
        drop_pending_updates: !servicesStarted, // only drop on restarts to avoid re-processing
        onStart: async () => {
          console.log("Bot is running!");

          if (!servicesStarted) {
            servicesStarted = true;

            // Send startup notification to Telegram
            await sendStartupNotification();

            // Start heartbeat timer from Supabase config
            const hbConfig = await getHeartbeatConfig();
            if (hbConfig?.enabled) {
              startHeartbeat(hbConfig.interval_minutes);
            } else {
              console.log("Heartbeat: disabled (no config or not enabled)");
            }

            // Start cron scheduler
            startCronScheduler();

            // Start evolution timer
            startEvolutionTimer();
          }
        },
      });
    } catch (err: any) {
      console.error(`Polling crashed: ${err.message || err}. Restarting in 5s...`);
      logEventV2("polling_crash", String(err.message || err).substring(0, 200)).catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
};

startBot();
