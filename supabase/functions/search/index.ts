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
    console.warn("Unauthorized request to search function");
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const query = body.query;
    const matchCount = body.match_count ?? 5;
    const matchThreshold = body.match_threshold ?? 0.7;

    if (!query || typeof query !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid query parameter" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Generate embedding for the query
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
          input: query,
        }),
      }
    );

    if (!embeddingResponse.ok) {
      const err = await embeddingResponse.text();
      console.error("OpenAI API error:", err);
      return new Response(
        JSON.stringify({ results: [], error: "OpenAI API error" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const embeddingData = await embeddingResponse.json();
    const queryEmbedding = embeddingData.data?.[0]?.embedding;

    if (!queryEmbedding) {
      return new Response(
        JSON.stringify({ results: [], error: "No embedding returned" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Call match_memory() RPC
    const { data, error } = await supabase.rpc("match_memory", {
      query_embedding: JSON.stringify(queryEmbedding),
      match_threshold: matchThreshold,
      match_count: matchCount,
    });

    if (error) {
      console.error("match_memory RPC error:", error);
      return new Response(
        JSON.stringify({ results: [], error: error.message }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ results: data || [] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Search function error:", err);
    return new Response(
      JSON.stringify({ results: [], error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
});
