import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const openaiKey = Deno.env.get("OPENAI_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseKey);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Auth guard: verify service_role JWT
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ") || authHeader.split(" ")[1] !== Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    console.warn("Unauthorized request to embed function");
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const payload = await req.json();

    // Database webhook sends: { type: "INSERT", record: { id, content, ... } }
    // Direct invocation sends: { id, content }
    const record = payload.record || payload;

    if (!record.id || !record.content) {
      return new Response(
        JSON.stringify({ error: "Missing id or content" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Skip if embedding already exists (idempotency)
    if (record.embedding) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "embedding already exists" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Generate embedding via OpenAI
    const embeddingResponse = await fetch(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: record.content,
        }),
      }
    );

    if (!embeddingResponse.ok) {
      const err = await embeddingResponse.text();
      console.error("OpenAI API error:", err);
      return new Response(
        JSON.stringify({ error: "Embedding generation failed" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const embeddingData = await embeddingResponse.json();
    const embedding = embeddingData.data?.[0]?.embedding;

    if (!embedding) {
      return new Response(
        JSON.stringify({ error: "Embedding generation failed" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // Update the row with the generated embedding
    const { error: updateError } = await supabase
      .from("global_memory")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", record.id);

    if (updateError) {
      console.error("Supabase update error:", updateError);
      return new Response(
        JSON.stringify({ error: "Processing failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log(`Embedded memory ${record.id}: "${record.content.substring(0, 50)}..."`);

    return new Response(
      JSON.stringify({ success: true, id: record.id }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Embed function error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
