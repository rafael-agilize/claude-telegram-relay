/**
 * Claude Telegram Relay — Test Supabase Connection
 *
 * Verifies Supabase URL and anon key are valid, and checks if
 * required tables exist.
 *
 * Usage: bun run setup/test-supabase.ts
 */

import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");
const WARN = yellow("!");

// Load .env manually
async function loadEnv(): Promise<Record<string, string>> {
  const envPath = join(PROJECT_ROOT, ".env");
  try {
    const content = await Bun.file(envPath).text();
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

const REQUIRED_TABLES = ["messages", "memory", "logs"];

async function main() {
  console.log("");
  console.log(bold("  Supabase Connection Test"));
  console.log("");

  const env = await loadEnv();
  const url = env.SUPABASE_URL || process.env.SUPABASE_URL || "";
  const key = env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";

  // Check URL
  if (!url || url === "your_project_url") {
    console.log(`  ${FAIL} SUPABASE_URL not set in .env`);
    console.log(`      ${dim("Get it from Supabase > Project Settings > API")}`);
    process.exit(1);
  }
  console.log(`  ${PASS} Supabase URL: ${url}`);

  // Check key
  if (!key || key === "your_anon_key") {
    console.log(`  ${FAIL} SUPABASE_ANON_KEY not set in .env`);
    console.log(`      ${dim("Get it from Supabase > Project Settings > API")}`);
    process.exit(1);
  }
  console.log(`  ${PASS} Anon key found`);

  // Test connection by querying each required table
  console.log(`\n  Testing connection...`);

  let allTablesExist = true;

  for (const table of REQUIRED_TABLES) {
    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      });

      if (res.status === 200) {
        console.log(`  ${PASS} Table "${table}" exists`);
      } else if (res.status === 404 || res.status === 406) {
        console.log(`  ${FAIL} Table "${table}" not found`);
        allTablesExist = false;
      } else {
        const body = await res.text();
        console.log(`  ${FAIL} Table "${table}": ${res.status} ${body.slice(0, 100)}`);
        allTablesExist = false;
      }
    } catch (err: any) {
      console.log(`  ${FAIL} Could not reach Supabase`);
      console.log(`      ${dim(err.message)}`);
      process.exit(1);
    }
  }

  if (!allTablesExist) {
    console.log(`\n  ${WARN} Some tables are missing. Run the schema in your Supabase SQL Editor:`);
    console.log(`      ${dim("1. Open your Supabase dashboard > SQL Editor")}`);
    console.log(`      ${dim("2. Paste contents of db/schema.sql")}`);
    console.log(`      ${dim("3. Click Run")}`);
    console.log(`      ${dim("4. Re-run this test")}`);
  } else {
    console.log(`\n  ${green("All good!")} Supabase is configured correctly.`);
  }

  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
