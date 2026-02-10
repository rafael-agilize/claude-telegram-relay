/**
 * Claude Code Telegram Relay
 *
 * Relay that connects Telegram to Claude Code CLI with:
 * - Supabase persistence (conversations, memory, goals)
 * - Voice transcription via mlx_whisper
 * - Intent-based memory management (Claude manages memory automatically)
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
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

const MLX_WHISPER_PATH =
  process.env.MLX_WHISPER_PATH || "/Users/roviana/.local/bin/mlx_whisper";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

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
    // Read current, increment, write back
    const { data } = await supabase
      .from("threads")
      .select("message_count")
      .eq("id", threadDbId)
      .single();
    const newCount = (data?.message_count || 0) + 1;
    await supabase
      .from("threads")
      .update({ message_count: newCount })
      .eq("id", threadDbId);
    return newCount;
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
  try {
    const { data: items } = await supabase
      .from("global_memory")
      .select("id, content");
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
// SUPABASE v1 (legacy - kept for backward compat during migration)
// ============================================================

async function logMessage(
  role: "user" | "assistant",
  content: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("messages")
      .insert({ role, content, channel: "telegram" });
  } catch (e) {
    console.error("Supabase log error:", e);
  }
}

async function logEvent(
  event: string,
  message?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("logs")
      .insert({ event, message, metadata: metadata || {} });
  } catch (e) {
    console.error("Supabase log event error:", e);
  }
}

async function getMemoryContext(): Promise<string> {
  if (!supabase) return "";

  try {
    const [factsResult, goalsResult, recentResult] = await Promise.all([
      supabase
        .from("memory")
        .select("content")
        .eq("type", "fact")
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("memory")
        .select("content, deadline")
        .eq("type", "goal")
        .order("priority", { ascending: false })
        .limit(10),
      supabase
        .from("messages")
        .select("role, content")
        .order("created_at", { ascending: false })
        .limit(6),
    ]);

    let context = "";

    if (factsResult.data?.length) {
      context += "\nPERSISTENT MEMORY:\n";
      context += factsResult.data.map((f) => `- ${f.content}`).join("\n");
    }

    if (goalsResult.data?.length) {
      context += "\n\nACTIVE GOALS:\n";
      context += goalsResult.data
        .map((g) => {
          const dl = g.deadline ? ` (by ${g.deadline})` : "";
          return `- ${g.content}${dl}`;
        })
        .join("\n");
    }

    if (recentResult.data?.length) {
      context += "\n\nRECENT CONVERSATION:\n";
      context += recentResult.data
        .reverse()
        .map((m) => `${m.role}: ${m.content.substring(0, 200)}`)
        .join("\n");
    }

    return context;
  } catch (e) {
    console.error("Memory context error:", e);
    return "";
  }
}

async function processIntents(response: string): Promise<string> {
  if (!supabase) return response;

  let clean = response;

  // [REMEMBER: fact to store]
  const rememberMatches = response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi);
  for (const match of rememberMatches) {
    await supabase
      .from("memory")
      .insert({ type: "fact", content: match[1].trim() });
    clean = clean.replace(match[0], "");
    console.log(`Remembered: ${match[1].trim()}`);
  }

  // [GOAL: goal text | DEADLINE: optional]
  const goalMatches = response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  );
  for (const match of goalMatches) {
    const deadline = match[2] ? new Date(match[2]).toISOString() : null;
    await supabase
      .from("memory")
      .insert({ type: "goal", content: match[1].trim(), deadline });
    clean = clean.replace(match[0], "");
    console.log(`Goal set: ${match[1].trim()}`);
  }

  // [DONE: search text for completed goal]
  const doneMatches = response.matchAll(/\[DONE:\s*(.+?)\]/gi);
  for (const match of doneMatches) {
    const searchText = match[1].trim().toLowerCase();
    const { data: goals } = await supabase
      .from("memory")
      .select("id, content")
      .eq("type", "goal");

    const goal = goals?.find((g) =>
      g.content.toLowerCase().includes(searchText)
    );
    if (goal) {
      await supabase
        .from("memory")
        .update({
          type: "completed_goal",
          completed_at: new Date().toISOString(),
        })
        .eq("id", goal.id);
      console.log(`Completed goal: ${goal.content}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [FORGET: search text to remove a fact]
  const forgetMatches = response.matchAll(/\[FORGET:\s*(.+?)\]/gi);
  for (const match of forgetMatches) {
    const searchText = match[1].trim().toLowerCase();
    const { data: facts } = await supabase
      .from("memory")
      .select("id, content")
      .eq("type", "fact");

    const fact = facts?.find((f) =>
      f.content.toLowerCase().includes(searchText)
    );
    if (fact) {
      await supabase.from("memory").delete().eq("id", fact.id);
      console.log(`Forgot: ${fact.content}`);
    }
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

// ============================================================
// VOICE TRANSCRIPTION (mlx_whisper)
// ============================================================

async function transcribeAudio(audioPath: string): Promise<string> {
  // Convert .oga to .wav for whisper
  const wavPath = audioPath.replace(/\.[^.]+$/, ".wav");

  const ffmpeg = spawn(
    [
      "ffmpeg",
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

  // Run mlx_whisper
  const whisper = spawn(
    [
      MLX_WHISPER_PATH,
      "--model",
      "mlx-community/whisper-large-v3-turbo",
      "--language",
      "pt",
      "--output-format",
      "txt",
      "--output-dir",
      TEMP_DIR,
      wavPath,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  const stderr = await new Response(whisper.stderr).text();
  const exitCode = await whisper.exited;

  if (exitCode !== 0) {
    console.error("Whisper error:", stderr);
    throw new Error("Transcription failed");
  }

  // Read the output txt file
  const txtPath = join(
    TEMP_DIR,
    wavPath.split("/").pop()!.replace(".wav", ".txt")
  );
  const transcription = await readFile(txtPath, "utf-8");

  // Cleanup temp files
  await unlink(wavPath).catch(() => {});
  await unlink(txtPath).catch(() => {});

  return transcription.trim();
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

    await writeFile(LOCK_FILE, process.pid.toString());
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
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
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

  // Extract thread ID: present in forum topic messages, null for DMs
  const telegramThreadId = ctx.message?.message_thread_id ?? null;

  // Determine title: topic name for groups, "DM" for direct messages
  const title = ctx.message?.is_topic_message
    ? `Topic ${telegramThreadId}`
    : "DM";

  const thread = await getOrCreateThread(chatId, telegramThreadId, title);

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

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      // If we used --resume and it failed, retry without it (session may be expired/corrupt)
      if (threadInfo?.sessionId) {
        console.warn(`Session ${threadInfo.sessionId} failed (exit ${exitCode}), starting fresh`);
        return callClaude(prompt, { ...threadInfo, sessionId: null });
      }
      console.error("Claude error:", stderr);
      return { text: `Error: ${stderr || "Claude exited with code " + exitCode}`, sessionId: null };
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

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 80)}...`);

  await ctx.replyWithChatAction("typing");

  await logMessage("user", text);

  const enrichedPrompt = await buildPrompt(text);
  const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
  const response = await processIntents(rawResponse);

  // Check if Claude included [VOICE_REPLY] tag
  const wantsVoice = /\[VOICE_REPLY\]/i.test(response);
  const cleanResponse = response.replace(/\[VOICE_REPLY\]/gi, "").trim();

  await logMessage("assistant", cleanResponse);
  await logEvent("message", text.substring(0, 100));

  // V2 thread-aware logging
  if (ctx.threadInfo) {
    await insertThreadMessage(ctx.threadInfo.dbId, "user", text);
    await insertThreadMessage(ctx.threadInfo.dbId, "assistant", cleanResponse);
    await incrementThreadMessageCount(ctx.threadInfo.dbId);
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

    await logMessage("user", `[Voice]: ${transcription}`);

    const enrichedPrompt = await buildPrompt(transcription);
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo);
    const claudeResponse = await processIntents(rawResponse);

    await logMessage("assistant", claudeResponse);
    await logEvent("voice_message", transcription.substring(0, 100));

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", `[Voice]: ${transcription}`);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
      await incrementThreadMessageCount(ctx.threadInfo.dbId);
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
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await logMessage("user", `[Image] ${caption}`);

    const { text: rawResponse } = await callClaude(prompt, ctx.threadInfo);
    const claudeResponse = await processIntents(rawResponse);

    await unlink(filePath).catch(() => {});

    await logMessage("assistant", claudeResponse);

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", `[Image] ${caption}`);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
      await incrementThreadMessageCount(ctx.threadInfo.dbId);
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
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    await logMessage("user", `[File: ${doc.file_name}] ${caption}`);

    const { text: rawResponse } = await callClaude(prompt, ctx.threadInfo);
    const claudeResponse = await processIntents(rawResponse);

    await unlink(filePath).catch(() => {});

    await logMessage("assistant", claudeResponse);

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", `[File: ${doc.file_name}] ${caption}`);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
      await incrementThreadMessageCount(ctx.threadInfo.dbId);
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

async function buildPrompt(userMessage: string): Promise<string> {
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

  const memoryContext = await getMemoryContext();

  return `
You are responding via Telegram. Keep responses concise.

Current time: ${timeStr}
${memoryContext}

MEMORY MANAGEMENT:
When the user mentions something to remember, goals, or completions,
include these tags in your response (they will be processed and removed automatically):

[REMEMBER: fact to store]
[GOAL: goal text | DEADLINE: optional date]
[DONE: search text for completed goal]
[FORGET: search text to remove a fact]
[VOICE_REPLY] - include this tag if the user explicitly asks for a voice/audio reply

User: ${userMessage}
`.trim();
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
console.log(`Voice transcription: mlx_whisper`);
console.log(`Voice responses (TTS): ${ELEVENLABS_API_KEY ? "ElevenLabs v3" : "disabled"}`);
console.log("Thread support: enabled (Grammy auto-thread)");

await logEvent("bot_started", "Relay started");

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
