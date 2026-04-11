/**
 * Alamut Library — Multi-Provider Cloudflare Worker v2.4
 *
 * Providers: Anthropic, OpenAI, Google Gemini, Mistral, DeepSeek, Groq
 * Vector search: Qdrant + OpenAI embeddings
 * Usage logging: Cloudflare KV (ALAMUT_LOGS binding)
 *
 * DEPLOY:
 *   wrangler deploy
 *   wrangler secret put ANTHROPIC_API_KEY
 *   wrangler secret put OPENAI_API_KEY
 *   wrangler secret put QDRANT_URL
 *   wrangler secret put QDRANT_API_KEY
 *
 * KV SETUP (run once):
 *   wrangler kv:namespace create ALAMUT_LOGS
 *   Then add the binding to wrangler.jsonc:
 *   "kv_namespaces": [{ "binding": "ALAMUT_LOGS", "id": "<your-kv-id>" }]
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
// USAGE LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log a usage event to Cloudflare KV.
 * Only logs if the user has consented (X-Consent: yes header).
 * Stores anonymised data only — no full IP, no personal identifiers.
 */
async function logUsage(request, env, eventType, extra = {}) {
  // Respect consent — frontend sends X-Consent header
  const consent = request.headers.get('X-Consent') || 'no';
  if (consent !== 'yes') return;

  // KV binding must exist
  if (!env.ALAMUT_LOGS) return;

  try {
    const entry = {
      ts:       new Date().toISOString(),
      type:     eventType,                                        // 'chat' | 'search'
      country:  request.headers.get('CF-IPCountry') || 'XX',    // Cloudflare geo header
      provider: extra.provider || null,
      mode:     extra.mode     || null,                          // 'full' | 'relevant'
      rag:      extra.rag      !== undefined ? extra.rag : null, // true | false
      passages: extra.passages || null,                          // slider value
      qlen:     extra.qlen     || null,                          // query character length
      // query text stored only if short enough to be non-identifying (<200 chars)
      query:    extra.query && extra.query.length <= 200 ? extra.query : null,
    };

    // Key format: logs/<date>/<random-id>
    // This allows easy listing by date range
    const date = entry.ts.slice(0, 10); // YYYY-MM-DD
    const uid  = crypto.randomUUID();
    const key  = `logs/${date}/${uid}`;

    // Store with 13-month expiration (TTL in seconds)
    await env.ALAMUT_LOGS.put(key, JSON.stringify(entry), {
      expirationTtl: 60 * 60 * 24 * 395
    });
  } catch(e) {
    // Never let logging failures affect the main request
    console.warn('Logging failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VECTOR SEARCH CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const OPENAI_EMBED_URL  = "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL   = "text-embedding-3-small";
const QDRANT_COLLECTION = "alamut-corpus";

// ═══════════════════════════════════════════════════════════════════════════════
// VECTOR SEARCH FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function embedQuery(query, env) {
  const response = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: query })
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI embedding failed: ${error}`);
  }
  const data = await response.json();
  return data.data[0].embedding;
}

async function searchQdrant(queryVector, topK, filter, env) {
  const url = `${env.QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/search`;
  const body = { vector: queryVector, limit: topK, with_payload: true };
  if (filter && Object.keys(filter).length > 0) {
    body.filter = {
      must: Object.entries(filter).map(([key, value]) => ({
        key, match: { value }
      }))
    };
  }
  const headers = { "Content-Type": "application/json" };
  if (env.QDRANT_API_KEY) headers["api-key"] = env.QDRANT_API_KEY;

  const response = await fetch(url, {
    method: "POST", headers, body: JSON.stringify(body)
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Qdrant search failed: ${error}`);
  }
  const data = await response.json();
  return data.result.map(match => ({
    chunk_id:    match.payload?.chunk_id   || String(match.id),
    score:       match.score,
    text:        match.payload?.text       || "",
    book:        match.payload?.book       || "",
    book_uri:    match.payload?.book_uri   || "",
    book_title:  match.payload?.book       || "",
    author:      match.payload?.author     || "",
    author_name: match.payload?.author_name || match.payload?.author || "",
    author_uri:  match.payload?.author_uri || "",
    language:    match.payload?.language   || "ar",
    is_poetry:   match.payload?.is_poetry  || false,
    page_ref:    match.payload?.page_ref   || null
  }));
}

async function handleVectorSearch(request, env, corsHeaders) {
  if (!env.OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: { message: "OPENAI_API_KEY not configured" } }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (!env.QDRANT_URL) {
    return new Response(JSON.stringify({ error: { message: "QDRANT_URL not configured" } }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  let body;
  try { body = await request.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body" } }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const { query, top_k = 10, filter = null } = body;
  if (!query) {
    return new Response(JSON.stringify({ error: { message: "Missing 'query' field" } }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const queryVector = await embedQuery(query, env);
    const results     = await searchQdrant(queryVector, top_k, filter, env);

    // Log the search event (fire-and-forget)
    logUsage(request, env, 'search', {
      query:    query,
      qlen:     query.length,
      passages: top_k,
    });

    return new Response(JSON.stringify({ results }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch(e) {
    console.error("Vector search error:", e);
    return new Response(JSON.stringify({ error: { message: e.message } }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOG VIEWER ENDPOINT  (GET /v1/logs?date=YYYY-MM-DD)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleLogViewer(request, env, corsHeaders) {
  if (!env.ALAMUT_LOGS) {
    return new Response(JSON.stringify({ error: 'ALAMUT_LOGS KV not configured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  const url    = new URL(request.url);
  const date   = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const prefix = `logs/${date}/`;
  const list   = await env.ALAMUT_LOGS.list({ prefix });
  const entries = await Promise.all(
    list.keys.map(async k => {
      const val = await env.ALAMUT_LOGS.get(k.name);
      try { return JSON.parse(val); } catch { return null; }
    })
  );
  return new Response(JSON.stringify({
    date,
    count: entries.filter(Boolean).length,
    entries: entries.filter(Boolean)
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN WORKER
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {

    const origin        = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    const corsHeaders = {
      'Access-Control-Allow-Origin':  allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Provider, X-Model, X-Consent, X-Mode, X-RAG, X-Passages',
      'Access-Control-Max-Age':       '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ── Vector search ────────────────────────────────────────────────────────
    if (url.pathname === '/v1/search') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: corsHeaders });
      }
      return handleVectorSearch(request, env, corsHeaders);
    }

    // ── Log viewer ───────────────────────────────────────────────────────────
    if (url.pathname === '/v1/logs') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: corsHeaders });
      }
      return handleLogViewer(request, env, corsHeaders);
    }

    // ── Health check ─────────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status:          'ok',
        version:         '2.4',
        embedding_model: EMBEDDING_MODEL,
        vector_search:   env.QDRANT_URL      ? 'configured' : 'not configured',
        logging:         env.ALAMUT_LOGS     ? 'configured' : 'not configured',
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Status ───────────────────────────────────────────────────────────────
    if (request.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'Alamut Library Worker is running',
        version: '2.4',
        endpoints: {
          '/v1/messages': 'LLM chat (POST)',
          '/v1/search':   'Vector search (POST)',
          '/v1/logs':     'Usage logs viewer (GET)',
          '/health':      'Health check (GET)',
        }
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
    const system    = body.system   || '';
    const messages  = body.messages || [];

    // ── Log the chat request (fire-and-forget) ───────────────────────────────
    const lastMsg = messages[messages.length - 1];
    const query   = lastMsg?.content || '';
    logUsage(request, env, 'chat', {
      provider: provider,
      mode:     request.headers.get('X-Mode')     || null,
      rag:      request.headers.get('X-RAG')      || null,
      passages: request.headers.get('X-Passages') || null,
      query:    query,
      qlen:     query.length,
    });

    try {

      // ── Anthropic ──────────────────────────────────────────────────────────
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

      // ── OpenAI-compatible (openai, mistral, deepseek, groq) ───────────────
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
          body: JSON.stringify({ model, max_tokens: maxTokens, messages: oaiMessages }),
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

      // ── Google Gemini ──────────────────────────────────────────────────────
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
          body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens } }),
        });
        const data = await res.json();
        if (data.candidates && data.candidates[0]) {
          const text = data.candidates[0].content.parts.map(p => p.text || '').join('');
          return new Response(JSON.stringify({ content: [{ type: 'text', text }] }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          error: { message: data.error ? data.error.message : 'Gemini error: ' + JSON.stringify(data) }
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
