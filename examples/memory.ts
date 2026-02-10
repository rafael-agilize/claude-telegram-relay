/**
 * Memory Persistence Example
 *
 * Patterns for giving your bot persistent memory:
 * 1. Local JSON file (simplest, good for prototyping)
 * 2. Intent-based auto-learning (v2 — used by the relay)
 * 3. Supabase cloud persistence (production)
 *
 * The relay uses Option 2 + 3: Claude auto-extracts facts via [LEARN:] tags,
 * stored in Supabase's global_memory table.
 */

import { readFile, writeFile } from "fs/promises";

// ============================================================
// TYPES
// ============================================================

interface Memory {
  facts: string[]; // Things to always remember
}

// ============================================================
// OPTION 1: LOCAL JSON FILE (Simplest — good for prototyping)
// ============================================================

const MEMORY_FILE = process.env.MEMORY_FILE || "/tmp/bot-memory.json";

export async function loadMemory(): Promise<Memory> {
  try {
    const content = await readFile(MEMORY_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { facts: [] };
  }
}

export async function saveMemory(memory: Memory): Promise<void> {
  await writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

export async function addFact(fact: string): Promise<string> {
  const memory = await loadMemory();
  memory.facts.push(fact);
  await saveMemory(memory);
  return `Remembered: "${fact}"`;
}

export async function removeFact(searchText: string): Promise<string> {
  const memory = await loadMemory();
  const index = memory.facts.findIndex((f) =>
    f.toLowerCase().includes(searchText.toLowerCase())
  );

  if (index === -1) {
    return `No fact found matching "${searchText}"`;
  }

  const [removed] = memory.facts.splice(index, 1);
  await saveMemory(memory);
  return `Forgot: "${removed}"`;
}

export async function getMemoryContext(): Promise<string> {
  const memory = await loadMemory();
  let context = "";

  if (memory.facts.length > 0) {
    context += "\nTHINGS I KNOW ABOUT THE USER:\n";
    context += memory.facts.map((f) => `- ${f}`).join("\n");
  }

  return context;
}

// ============================================================
// OPTION 2: INTENT-BASED AUTO-LEARNING (v2 — used by the relay)
// ============================================================

/*
The relay uses intent tags that Claude includes in responses.
These are parsed and stripped before delivery to the user.

Add this to your Claude prompt:

"
MEMORY INSTRUCTIONS:
You can automatically learn and remember facts about the user.
When you notice something worth remembering, include this tag:

[LEARN: concise fact about the user]

Keep learned facts very concise (under 15 words each).
Only learn genuinely useful things.

To remove an outdated or wrong fact:
[FORGET: search text matching the fact to remove]
"

Then parse Claude's response:

async function processIntents(response: string): Promise<string> {
  let clean = response;

  // [LEARN: concise fact about the user]
  const learnMatches = response.matchAll(/\[LEARN:\s*(.+?)\]/gi);
  for (const match of learnMatches) {
    const fact = match[1].trim();
    await insertGlobalMemory(fact);
    clean = clean.replace(match[0], "");
  }

  // [FORGET: search text to remove a fact]
  const forgetMatches = response.matchAll(/\[FORGET:\s*(.+?)\]/gi);
  for (const match of forgetMatches) {
    await deleteGlobalMemory(match[1].trim());
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}
*/

// ============================================================
// OPTION 3: SUPABASE CLOUD PERSISTENCE (Production)
// ============================================================

/*
The relay stores learned facts in Supabase's global_memory table.
See examples/supabase-schema-v2.sql for the full schema.

Tables:
- global_memory: Cross-thread facts (content, source_thread_id)
- bot_soul: Personality definition (content, is_active)
- threads: Conversation channels (session, summary)
- thread_messages: Per-thread message history

Example:

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function getGlobalMemory(): Promise<string[]> {
  const { data } = await supabase
    .from("global_memory")
    .select("content")
    .order("created_at", { ascending: false })
    .limit(30);
  return (data || []).map((m) => m.content);
}

async function insertGlobalMemory(content: string): Promise<void> {
  await supabase.from("global_memory").insert({ content });
}

async function deleteGlobalMemory(searchText: string): Promise<boolean> {
  const { data: items } = await supabase
    .from("global_memory")
    .select("id, content");
  const match = items?.find((m) =>
    m.content.toLowerCase().includes(searchText.toLowerCase())
  );
  if (match) {
    await supabase.from("global_memory").delete().eq("id", match.id);
    return true;
  }
  return false;
}
*/
