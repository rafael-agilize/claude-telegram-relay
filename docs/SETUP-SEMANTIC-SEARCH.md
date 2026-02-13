# Semantic Search Setup

Phase 16 of the Claude Telegram Relay adds semantic memory search powered by OpenAI embeddings and Supabase Edge Functions.

## Prerequisites

- Supabase project with Phase 14 migration applied (vector column, match_memory RPC)
- Supabase CLI installed (`npm i -g supabase`)
- OpenAI API key with access to text-embedding-3-small

## 1. Set Supabase Secrets

The OpenAI API key lives exclusively in Supabase Edge Function secrets — it is never added to the relay's `.env` file.

```bash
supabase secrets set OPENAI_API_KEY=sk-your-key-here
```

## 2. Deploy Edge Functions

From the project root:

```bash
supabase functions deploy embed
supabase functions deploy search
```

To verify deployment:

```bash
supabase functions list
```

## 3. Configure Database Webhook

The embed function must be triggered automatically when a new memory is inserted.

### Option A: Supabase Dashboard (Recommended)

1. Go to **Database > Webhooks** in your Supabase Dashboard
2. Click **Create a new webhook**
3. Configure:
   - **Name:** `embed_memory`
   - **Table:** `global_memory`
   - **Events:** `INSERT` only
   - **Type:** Supabase Edge Function
   - **Edge Function:** `embed`
4. Click **Create webhook**

### Option B: SQL Trigger with pg_net

If you prefer version-controlled infrastructure, run this SQL after storing your project URL in vault:

```sql
-- Store project URL in vault (run once)
-- Local: select vault.create_secret('http://api.supabase.internal:8000', 'project_url');
-- Production: select vault.create_secret('https://YOUR-PROJECT.supabase.co', 'project_url');

-- Helper to get project URL from vault
CREATE OR REPLACE FUNCTION util_get_project_url()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  url TEXT;
BEGIN
  SELECT decrypted_secret INTO url
  FROM vault.decrypted_secrets
  WHERE name = 'project_url';
  RETURN url;
END;
$$;

-- Trigger function: POST to embed Edge Function on INSERT
CREATE OR REPLACE FUNCTION trigger_embed_memory()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM net.http_post(
    url := util_get_project_url() || '/functions/v1/embed',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('supabase.service_role_key', true)
    ),
    body := jsonb_build_object(
      'id', NEW.id,
      'content', NEW.content,
      'type', NEW.type
    ),
    timeout_milliseconds := 30000
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_global_memory_insert
  AFTER INSERT ON global_memory
  FOR EACH ROW
  EXECUTE FUNCTION trigger_embed_memory();
```

## 4. Test the Setup

### Test embed function:

Insert a test memory and verify the embedding is generated:

```sql
INSERT INTO global_memory (content, type) VALUES ('Test semantic search', 'fact');

-- Wait a few seconds, then check:
SELECT id, content, embedding IS NOT NULL AS has_embedding
FROM global_memory
WHERE content = 'Test semantic search';
```

### Test search function:

```bash
curl -X POST "https://YOUR-PROJECT.supabase.co/functions/v1/search" \
  -H "Authorization: Bearer YOUR-ANON-KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "test search"}'
```

### Test from relay:

Send a message to the bot. Check the relay logs for:
- `Semantic search unavailable` — Edge Functions not deployed or unreachable (fallback working)
- No warning — semantic search is working

## Graceful Degradation

If Edge Functions are not deployed:
- Memory INSERT/FORGET/GOAL/DONE all work normally
- `getRelevantMemory()` returns an empty array silently
- The RELEVANT MEMORIES section simply doesn't appear in the prompt
- No errors shown to the user

## Backfilling Existing Memories

To generate embeddings for memories that were created before the webhook was configured:

```sql
-- Find memories without embeddings
SELECT id, content FROM global_memory WHERE embedding IS NULL;
```

Then invoke the embed function for each:

```bash
curl -X POST "https://YOUR-PROJECT.supabase.co/functions/v1/embed" \
  -H "Authorization: Bearer YOUR-SERVICE-ROLE-KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": "UUID-HERE", "content": "memory content here"}'
```

Or use a SQL loop with pg_net (see Option B trigger setup above).
