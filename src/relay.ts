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
import { writeFile, mkdir, readFile, unlink, open } from "fs/promises";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";

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

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Security: sanitize filenames to prevent path traversal
function sanitizeFilename(name: string): string {
  return name.replace(/[\/\\]/g, "_").replace(/\.\./g, "_");
}

// Claude CLI limits
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB

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
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
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

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error("Claude CLI timed out"));
      }, CLAUDE_TIMEOUT_MS)
    );

    let output: string;
    let stderrText: string;
    let exitCode: number;
    try {
      [output, stderrText, exitCode] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]),
        timeoutPromise,
      ]);
    } catch (error: any) {
      if (error.message?.includes("timed out")) {
        console.error("Claude CLI timed out");
        return { text: "Sorry, that request took too long. Please try a simpler query.", sessionId: null };
      }
      throw error;
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

async function sendResponse(ctx: CustomContext, response: string): Promise<void> {
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  const chunks = [];
  let remaining = response;

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
    await ctx.reply(chunk);
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
  onStart: () => {
    console.log("Bot is running!");
  },
});
