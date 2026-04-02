/**
 * Alamut Library — Multi-Provider Cloudflare Worker v2.3
 *
 * Providers: Anthropic, OpenAI, Google Gemini, Mistral, DeepSeek, Groq
 * Vector search: Qdrant + OpenAI embeddings
 *
 * DEPLOY:
 *   wrangler deploy
 *   wrangler secret put ANTHROPIC_API_KEY
 *   wrangler secret put OPENAI_API_KEY
 *   wrangler secret put QDRANT_URL
 *   wrangler secret put QDRANT_API_KEY
 */

const ALLOWED_ORIGINS = [
  'https://alamutlibrary.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8080',
  'null',
];

// OpenAI-compatible provider endpoints
const OPENAI_ENDPOINTS = {
  'openai':    'https://api.openai.com/v1/chat/completions',
  'mistral':   'https://api.mistral.ai/v1/chat/completions',
  'deepseek':  'https://api.deepseek.com/chat/completions',
  'groq':      'https://api.groq.com/openai/v1/chat/completions',
};

// ═══════════════════════════════════════════════════════════════════════════════
// VECTOR SEARCH CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL = "text-embedding-3-small";
const QDRANT_COLLECTION = "alamut-corpus";


// ═══════════════════════════════════════════════════════════════════════════════
// VECTOR SEARCH FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Embed a query using OpenAI
 */
async function embedQuery(query, env) {
  const response = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: query
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI embedding failed: ${error}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

/**
 * Search Qdrant for similar vectors
 */
async function searchQdrant(queryVector, topK, filter, env) {
  const url = `${env.QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/search`;
  
  const body = {
    vector: queryVector,
    limit: topK,
    with_payload: true
  };
  
  if (filter && Object.keys(filter).length > 0) {
    body.filter = {
      must: Object.entries(filter).map(([key, value]) => ({
        key: key,
        match: { value: value }
      }))
    };
  }

  const headers = {
    "Content-Type": "application/json"
  };
  
  if (env.QDRANT_API_KEY) {
    headers["api-key"] = env.QDRANT_API_KEY;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Qdrant search failed: ${error}`);
  }

  const data = await response.json();
  
  return data.result.map(match => ({
    chunk_id: match.payload?.chunk_id || String(match.id),
    score: match.score,
    text: match.payload?.text || "",
    book: match.payload?.book || "",
    book_uri: match.payload?.book_uri || "",
    book_title: match.payload?.book || "",
    author: match.payload?.author || "",
    author_name: match.payload?.author_name || match.payload?.author || "",
    author_uri: match.payload?.author_uri || "",
    language: match.payload?.language || "ar",
    is_poetry: match.payload?.is_poetry || false,
    page_ref: match.payload?.page_ref || null
  }));
}

/**
 * Handle vector search requests
 */
async function handleVectorSearch(request, env, corsHeaders) {
  // Check required environment variables
  if (!env.OPENAI_API_KEY) {
    return new Response(JSON.stringify({ 
      error: { message: "OPENAI_API_KEY not configured" } 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
  
  if (!env.QDRANT_URL) {
    return new Response(JSON.stringify({ 
      error: { message: "QDRANT_URL not configured" } 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Parse request body
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ 
      error: { message: "Invalid JSON body" } 
    }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const { query, top_k = 10, filter = null } = body;

  if (!query) {
    return new Response(JSON.stringify({ 
      error: { message: "Missing 'query' field" } 
    }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    // Step 1: Embed the query using OpenAI
    const queryVector = await embedQuery(query, env);

    // Step 2: Search Qdrant
    const results = await searchQdrant(queryVector, top_k, filter, env);

    // Step 3: Return results
    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (e) {
    console.error("Vector search error:", e);
    return new Response(JSON.stringify({ 
      error: { message: e.message } 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN WORKER
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {

    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    const corsHeaders = {
      'Access-Control-Allow-Origin':  allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Provider, X-Model',
      'Access-Control-Max-Age':       '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Parse URL path
    const url = new URL(request.url);

    // ════════════════════════════════════════════════════
    // VECTOR SEARCH ENDPOINT
    // ════════════════════════════════════════════════════
    if (url.pathname === '/v1/search') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: corsHeaders });
      }
      return handleVectorSearch(request, env, corsHeaders);
    }

    // ════════════════════════════════════════════════════
    // HEALTH CHECK
    // ════════════════════════════════════════════════════
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        version: '2.3',
        embedding_model: EMBEDDING_MODEL,
        vector_search: env.QDRANT_URL ? 'configured' : 'not configured'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ════════════════════════════════════════════════════
    // ROOT / GET — Status check
    // ════════════════════════════════════════════════════
    if (request.method === 'GET') {
      return new Response(
        JSON.stringify({ 
          status: 'Alamut Library Worker is running', 
          version: '2.3',
          endpoints: {
            '/v1/messages': 'LLM chat (POST)',
            '/v1/search': 'Vector search (POST)',
            '/health': 'Health check (GET)'
          }
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    // ── Provider + key ───────────────────────────────────────────────────────
    const provider = (request.headers.get('X-Provider') || 'anthropic').toLowerCase();
    const model    = request.headers.get('X-Model') || 'claude-sonnet-4-20250514';

    let apiKey = (request.headers.get('X-API-Key') || '').trim();
    if (!apiKey && provider === 'anthropic') {
      apiKey = (env.ANTHROPIC_API_KEY || '').trim();
    }

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: 'No API key provided for provider: ' + provider } }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Parse body ───────────────────────────────────────────────────────────
    let body;
    try { body = await request.json(); }
    catch(e) {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid JSON: ' + e.message } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const maxTokens = Math.min(body.max_tokens || 1000, 4000);
    const system    = body.system || '';
    const messages  = body.messages || [];

    try {

      // ════════════════════════════════════════════════════
      // ANTHROPIC
      // ════════════════════════════════════════════════════
      if (provider === 'anthropic' || provider === 'anthropic-own') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ════════════════════════════════════════════════════
      // OPENAI-COMPATIBLE (openai, mistral, deepseek, groq)
      // ════════════════════════════════════════════════════
      if (OPENAI_ENDPOINTS[provider]) {
        const oaiMessages = [];
        if (system) oaiMessages.push({ role: 'system', content: system });
        messages.forEach(m => oaiMessages.push({ role: m.role, content: m.content }));

        const res = await fetch(OPENAI_ENDPOINTS[provider], {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': 'Bearer ' + apiKey,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: oaiMessages,
          }),
        });

        const data = await res.json();

        if (data.choices && data.choices[0]) {
          return new Response(JSON.stringify({
            content: [{ type: 'text', text: data.choices[0].message.content || '' }],
            model: data.model,
            usage: data.usage,
          }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ════════════════════════════════════════════════════
      // GOOGLE GEMINI
      // ════════════════════════════════════════════════════
      if (provider === 'gemini') {
        const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' +
          model + ':generateContent?key=' + apiKey;

        const contents = [];
        if (system) {
          contents.push({ role: 'user',  parts: [{ text: '[System]: ' + system }] });
          contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
        }
        messages.forEach(m => {
          contents.push({
            role:  m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          });
        });

        const res = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            generationConfig: { maxOutputTokens: maxTokens },
          }),
        });

        const data = await res.json();

        if (data.candidates && data.candidates[0]) {
          const text = data.candidates[0].content.parts
            .map(p => p.text || '').join('');
          return new Response(JSON.stringify({
            content: [{ type: 'text', text }],
          }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        return new Response(JSON.stringify({
          error: {
            message: data.error
              ? data.error.message
              : 'Gemini error: ' + JSON.stringify(data)
          }
        }), { status: res.status || 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      return new Response(
        JSON.stringify({ error: { message: 'Unknown provider: ' + provider } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } catch(err) {
      return new Response(
        JSON.stringify({ error: { message: 'Worker error: ' + err.message } }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }
};
