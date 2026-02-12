/**
 * Claude Code Telegram Relay
 *
 * Relay that connects Telegram to Claude Code CLI with:
 * - Threaded conversations (DMs + Telegram Topics)
 * - Three-layer memory (soul, global facts, thread context)
 * - Voice transcription via mlx_whisper
 * - Intent-based memory management ([LEARN:]/[FORGET:] tags)
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile } from "grammy";
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
  return name.replace(/[\/\\]/g, "_").replace(/\.\./g, "_");
}

// Claude CLI limits
const CLAUDE_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min of no output = stuck
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB

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
    return `AVAILABLE SKILLS (read the full SKILL.md in ~/.claude/skills/<name>/ before using):\n${skills.join("\n")}`;
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

async function getGlobalMemory(): Promise<string[]> {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("global_memory")
      .select("content")
      .order("created_at", { ascending: false })
      .limit(30);
    return (data || []).map((m) => m.content);
  } catch (e) {
    console.error("getGlobalMemory error:", e);
    return [];
  }
}

async function insertGlobalMemory(
  content: string,
  sourceThreadId?: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("global_memory")
      .insert({ content, source_thread_id: sourceThreadId || null });
  } catch (e) {
    console.error("insertGlobalMemory error:", e);
  }
}

async function deleteGlobalMemory(searchText: string): Promise<boolean> {
  if (!supabase) return false;
  if (!searchText || searchText.length > 200) return false; // Guard against abuse
  try {
    const { data: items } = await supabase
      .from("global_memory")
      .select("id, content")
      .limit(100); // Cap to prevent fetching unbounded data
    const match = items?.find((m) =>
      m.content.toLowerCase().includes(searchText.toLowerCase())
    );
    if (match) {
      await supabase.from("global_memory").delete().eq("id", match.id);
      console.log(`Forgot global memory: ${match.content}`);
      return true;
    }
    return false;
  } catch (e) {
    console.error("deleteGlobalMemory error:", e);
    return false;
  }
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

  const prefix = `<b>[Cron: ${job.name}]</b>\n\n`;
  const fullMessage = prefix + message;
  const html = markdownToTelegramHtml(fullMessage);

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
  const soul = await getActiveSoul();
  const globalMemory = await getGlobalMemory();

  const timeZone = "America/Sao_Paulo";
  const timeString = new Date().toLocaleString("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  });

  let prompt = soul + `\n\nCurrent time: ${timeString}\n\n`;

  if (globalMemory.length > 0) {
    prompt += "THINGS I KNOW ABOUT THE USER:\n";
    prompt += globalMemory.map((m) => `- ${m}`).join("\n");
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

  // Process intents
  const cleanResponse = await processIntents(text, threadInfo?.dbId);

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

    // Step 4: Process intents ([LEARN:], [FORGET:])
    const cleanResponse = await processIntents(rawResponse);

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

  const soul = await getActiveSoul();
  const globalMemory = await getGlobalMemory();

  let prompt = `${soul}\n\nCurrent time: ${timeStr}`;

  if (globalMemory.length > 0) {
    prompt += "\n\nTHINGS I KNOW ABOUT THE USER:\n";
    prompt += globalMemory.map((m) => `- ${m}`).join("\n");
  }

  if (checklist) {
    prompt += `\n\nHEARTBEAT CHECKLIST:\n${checklist}`;
  }

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

async function processIntents(response: string, threadDbId?: string): Promise<string> {
  let clean = response;

  // [LEARN: concise fact about the user]
  const learnMatches = response.matchAll(/\[LEARN:\s*(.+?)\]/gi);
  for (const match of learnMatches) {
    const fact = match[1].trim();
    // Security: cap fact length to prevent memory abuse
    if (fact.length > 0 && fact.length <= 200) {
      await insertGlobalMemory(fact, threadDbId);
      console.log(`Learned: ${fact}`);
    } else {
      console.warn(`Rejected LEARN fact: too long (${fact.length} chars)`);
    }
    clean = clean.replace(match[0], "");
  }

  // [FORGET: search text to remove a fact]
  const forgetMatches = response.matchAll(/\[FORGET:\s*(.+?)\]/gi);
  for (const match of forgetMatches) {
    const searchText = match[1].trim();
    const deleted = await deleteGlobalMemory(searchText);
    if (deleted) {
      console.log(`Forgot memory matching: ${searchText}`);
    }
    clean = clean.replace(match[0], "");
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
        console.log("Stale lock found, taking over...");
      }
    }

    // Use exclusive flag to prevent race conditions between instances
    const fd = await open(LOCK_FILE, "wx").catch(() => null);
    if (fd) {
      await fd.writeFile(process.pid.toString());
      await fd.close();
    } else {
      // File was created between our check and open — retry with overwrite
      // (only happens after stale lock removal)
      await writeFile(LOCK_FILE, process.pid.toString());
    }
    return true;
  } catch (error) {
    console.error("Lock error:", error);
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
  await logEventV2("bot_stopping", "Relay shutting down (SIGINT)");
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  stopHeartbeat();
  stopCronScheduler();
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
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  threadInfo?: ThreadInfo
): Promise<{ text: string; sessionId: string | null }> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume from thread's stored session if available
  if (threadInfo?.sessionId) {
    args.push("--resume", threadInfo.sessionId);
  }

  args.push("--output-format", "json", "--dangerously-skip-permissions");

  console.log(`Calling Claude: ${prompt.substring(0, 80)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: { ...process.env },
    });

    // Inactivity-based timeout: kill only if Claude goes silent for 5 min.
    // Long-running tasks that produce output (tool calls, progress) stay alive.
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

    // Read stderr incrementally to detect activity and reset the timer
    const stderrChunks: string[] = [];
    const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const stderrDrain = (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          stderrChunks.push(decoder.decode(value, { stream: true }));
          resetInactivityTimer();
        }
      } catch {
        // Stream closed — process ended
      }
    })();

    // Read stdout fully (JSON output arrives at end)
    let output = await new Response(proc.stdout).text();
    await stderrDrain;
    clearTimeout(inactivityTimer);
    const stderrText = stderrChunks.join("");
    const exitCode = await proc.exited;

    if (timedOut) {
      console.error("Claude CLI timed out (no activity for 5 minutes)");
      // Clean up any orphaned child processes (skill scripts, auth flows, etc.)
      await killOrphanedProcesses(proc.pid!);
      return { text: "Sorry, Claude appears to be stuck (no activity for 5 minutes). Please try again.", sessionId: null };
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

    // Size guard before JSON parsing
    if (output.length > MAX_OUTPUT_SIZE) {
      console.warn(`Claude output very large (${output.length} bytes), truncating`);
      output = output.substring(0, MAX_OUTPUT_SIZE);
    }

    // Parse JSON response
    let resultText: string;
    let newSessionId: string | null = null;
    try {
      const json = JSON.parse(output);
      resultText = typeof json.result === "string"
        ? json.result
        : json.result?.content?.[0]?.text || output;
      newSessionId = json.session_id || null;
    } catch {
      // Fallback: if JSON parse fails, treat entire output as text
      console.warn("Failed to parse Claude JSON output, using raw text");
      resultText = output;
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

    const summaryPrompt = `Summarize this conversation thread concisely in 2-3 sentences. Focus on the main topics discussed and any decisions or outcomes. Do NOT include any tags like [LEARN:] or [FORGET:].

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

// /soul command: set bot personality
bot.command("soul", async (ctx) => {
  const text = ctx.match;
  if (!text || text.trim().length === 0) {
    const currentSoul = await getActiveSoul();
    await ctx.reply(`Current soul:\n\n${currentSoul}\n\nUsage: /soul <personality description>`);
    return;
  }

  const success = await setSoul(text.trim());
  if (success) {
    await logEventV2("soul_updated", text.trim().substring(0, 100), {}, ctx.threadInfo?.dbId);
    await ctx.reply(`Soul updated! New personality:\n\n${text.trim()}`);
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

// /memory command: show global memory
bot.command("memory", async (ctx) => {
  const memories = await getGlobalMemory();

  if (memories.length === 0) {
    await ctx.reply("No memories stored yet. I'll learn facts about you as we chat.");
    return;
  }

  let text = `I know ${memories.length} thing${memories.length === 1 ? "" : "s"} about you:\n\n`;
  text += memories.map((m, i) => `${i + 1}. ${m}`).join("\n");
  text += "\n\nTo remove a fact, just ask me to forget it.";

  await sendResponse(ctx, text);
});

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

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 80)}...`);

  await ctx.replyWithChatAction("typing");

  const enrichedPrompt = await buildPrompt(text, ctx.threadInfo);
  const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
  const response = await processIntents(rawResponse, ctx.threadInfo?.dbId);

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
  await sendResponse(ctx, cleanResponse);
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  console.log("Voice message received");
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
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
    const claudeResponse = await processIntents(rawResponse, ctx.threadInfo?.dbId);

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", `[Voice]: ${transcription}`);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
      await maybeUpdateThreadSummary(ctx.threadInfo);
      await logEventV2("voice_message", transcription.substring(0, 100), {}, ctx.threadInfo.dbId);
    }

    // Reply with voice if TTS is available
    const audioBuffer = await textToSpeech(claudeResponse);
    if (audioBuffer) {
      const audioPath = join(TEMP_DIR, `tts_${Date.now()}.ogg`);
      await writeFile(audioPath, audioBuffer);
      await ctx.replyWithVoice(new InputFile(audioPath));
      await unlink(audioPath).catch(() => {});
      // Also send text so it's searchable/readable
      await sendResponse(ctx, claudeResponse);
    } else {
      await sendResponse(ctx, claudeResponse);
    }
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
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
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
    const claudeResponse = await processIntents(rawResponse, ctx.threadInfo?.dbId);

    await unlink(filePath).catch(() => {});

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", `[Image] ${caption}`);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
      await maybeUpdateThreadSummary(ctx.threadInfo);
      await logEventV2("photo_message", caption.substring(0, 100), {}, ctx.threadInfo.dbId);
    }

    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
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
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
    const claudeResponse = await processIntents(rawResponse, ctx.threadInfo?.dbId);

    await unlink(filePath).catch(() => {});

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", `[File: ${doc.file_name}] ${caption}`);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
      await maybeUpdateThreadSummary(ctx.threadInfo);
      await logEventV2("document_message", `${doc.file_name}`.substring(0, 100), {}, ctx.threadInfo.dbId);
    }

    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
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
  const soul = await getActiveSoul();

  // Layer 2: Global memory (cross-thread learned facts)
  const globalMemory = await getGlobalMemory();

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

  if (globalMemory.length > 0) {
    prompt += "\n\nTHINGS I KNOW ABOUT THE USER:\n";
    prompt += globalMemory.map((m) => `- ${m}`).join("\n");
  }

  if (threadContext) {
    prompt += threadContext;
  }

  if (skillRegistry) {
    prompt += `\n\n${skillRegistry}`;
  }

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

bot.start({
  onStart: async () => {
    console.log("Bot is running!");

    // Start heartbeat timer from Supabase config
    const hbConfig = await getHeartbeatConfig();
    if (hbConfig?.enabled) {
      startHeartbeat(hbConfig.interval_minutes);
    } else {
      console.log("Heartbeat: disabled (no config or not enabled)");
    }

    // Start cron scheduler
    startCronScheduler();
  },
});
