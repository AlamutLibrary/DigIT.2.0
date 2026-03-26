/**
 * Alamut Library — Cloudflare Worker API Proxy
 *
 * DEPLOY:
 *   wrangler deploy
 *   wrangler secret put ANTHROPIC_API_KEY
 *
 * Set WORKER_URL in index.html to just the base URL, e.g.:
 *   const WORKER_URL = 'https://alamut-proxy.YOUR_ACCOUNT.workers.dev';
 *   (do NOT add /v1/messages to this URL — the app adds the path automatically)
 *
 * TEST:
 *   curl -X POST https://alamut-proxy.YOUR_ACCOUNT.workers.dev/v1/messages \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"claude-sonnet-4-20250514","max_tokens":50,"messages":[{"role":"user","content":"Say: Worker connected."}]}'
 */

export default {
  async fetch(request, env) {

    // ── CORS ──────────────────────────────────────────────────────────────────
    const ALLOWED_ORIGINS = [
      'https://alamutlibrary.github.io',
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'http://localhost:8080',
      'null', // file:// opened locally
    ];

    const origin = request.headers.get('Origin') || '';
    // Allow any origin in ALLOWED_ORIGINS, otherwise fall back to first entry
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    const corsHeaders = {
      'Access-Control-Allow-Origin':  allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Access-Control-Max-Age':       '86400',
    };

    // ── PREFLIGHT ─────────────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── HEALTH CHECK (GET /) ──────────────────────────────────────────────────
    // Lets you verify the worker is alive by visiting its URL in a browser
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'Alamut Library Worker is running' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    // ── API KEY ───────────────────────────────────────────────────────────────
    // Uses Cloudflare secret (set via `wrangler secret put ANTHROPIC_API_KEY`)
    // Falls back to key passed in X-API-Key header from the browser sidebar input
    const apiKey = (env.ANTHROPIC_API_KEY || '').trim() ||
                   (request.headers.get('X-API-Key') || '').trim();

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: 'No API key. Run: wrangler secret put ANTHROPIC_API_KEY' } }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── PARSE BODY ────────────────────────────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch(e) {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid JSON body: ' + e.message } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Basic validation
    if (!body.model || !String(body.model).startsWith('claude-')) {
      return new Response(
        JSON.stringify({ error: { message: 'Missing or invalid model field.' } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Safety cap on tokens
    body.max_tokens = Math.min(body.max_tokens || 1000, 4000);

    // ── PROXY TO ANTHROPIC ────────────────────────────────────────────────────
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      return new Response(JSON.stringify(data), {
        status:  response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } catch(err) {
      return new Response(
        JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }
};