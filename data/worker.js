/**
 * Alamut Library — Cloudflare Worker API Proxy
 *
 * This Worker proxies requests from the GitHub Pages frontend to the Anthropic API.
 * The API key can be stored as a Cloudflare secret OR passed in the request header.
 *
 * DEPLOY STEPS:
 *   1.  npm install -g wrangler
 *   2.  wrangler login
 *   3.  wrangler deploy
 *   4.  wrangler secret put ANTHROPIC_API_KEY   ← paste your sk-ant-… key
 *   5.  Copy your Worker URL (e.g. https://alamut-proxy.YOUR_ACCOUNT.workers.dev)
 *   6.  In index.html set:  const WORKER_URL = 'https://alamut-proxy.YOUR_ACCOUNT.workers.dev';
 *   7.  Commit + push → GitHub Pages auto-deploys
 *
 * TEST YOUR WORKER (before connecting the frontend):
 *   curl -X POST https://alamut-proxy.YOUR_ACCOUNT.workers.dev/v1/messages \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"claude-sonnet-4-20250514","max_tokens":50,"messages":[{"role":"user","content":"Say hello"}]}'
 */

export default {
  async fetch(request, env) {

    // ── CORS ──────────────────────────────────────────────────────────────────
    // Add your GitHub Pages URL here.  The wildcard fallback is safe because
    // the API key stays server-side regardless.
    const ALLOWED_ORIGINS = [
      'https://alamutlibrary.github.io',
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'http://localhost:8080',
      'null',           // file:// opened locally shows Origin: null
    ];

    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    const corsHeaders = {
      'Access-Control-Allow-Origin':  allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Access-Control-Max-Age':       '86400',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    // ── RESOLVE API KEY ───────────────────────────────────────────────────────
    // Priority: Cloudflare secret > X-API-Key header from request
    const apiKey = env.ANTHROPIC_API_KEY || request.headers.get('X-API-Key') || '';
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: 'No API key configured. Set ANTHROPIC_API_KEY as a Cloudflare secret.' } }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── PARSE & VALIDATE BODY ─────────────────────────────────────────────────
    let body;
    try { body = await request.json(); }
    catch(e) {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid JSON body' } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!body.model || !String(body.model).startsWith('claude-')) {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid or missing model. Must start with "claude-".' } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Cap tokens to prevent runaway costs
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
        JSON.stringify({ error: { message: 'Worker fetch error: ' + err.message } }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }
};
