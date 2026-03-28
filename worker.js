/**
 * Alamut Library — Multi-Provider Cloudflare Worker
 *
 * Routes to Anthropic, OpenAI, Gemini, Mistral, or DeepSeek
 * based on the X-Provider header from the frontend.
 *
 * DEPLOY:
 *   wrangler deploy
 *   wrangler secret put ANTHROPIC_API_KEY   ← library's default key (Anthropic only)
 *
 * Visitors using their own keys pass them via X-API-Key header.
 */

const ALLOWED_ORIGINS = [
  'https://alamutlibrary.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8080',
  'null',
];

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

    if (request.method === 'GET') {
      return new Response(
        JSON.stringify({ status: 'Alamut Library Worker is running', version: '2.0-multi-provider' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    // ── Determine provider ───────────────────────────────────────────────────
    const provider = (request.headers.get('X-Provider') || 'anthropic').toLowerCase();
    const model    = request.headers.get('X-Model') || 'claude-sonnet-4-20250514';

    // ── Resolve API key ──────────────────────────────────────────────────────
    // Visitor key always takes priority (allows them to use their own account).
    // Fall back to Cloudflare secret only for the library's Anthropic provider.
    let apiKey = (request.headers.get('X-API-Key') || '').trim();
    if (!apiKey && (provider === 'anthropic')) {
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
      // ANTHROPIC (claude-*)
      // ════════════════════════════════════════════════════
      if (provider === 'anthropic' || provider === 'anthropic-own') {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
        });
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ════════════════════════════════════════════════════
      // OPENAI-COMPATIBLE (openai, mistral, deepseek)
      // ════════════════════════════════════════════════════
      if (provider === 'openai' || provider === 'mistral' || provider === 'deepseek') {
        const endpoints = {
          'openai':   'https://api.openai.com/v1/chat/completions',
          'mistral':  'https://api.mistral.ai/v1/chat/completions',
          'deepseek': 'https://api.deepseek.com/v1/chat/completions',
        };

        // Convert Anthropic-style messages to OpenAI format
        const oaiMessages = [];
        if (system) oaiMessages.push({ role: 'system', content: system });
        messages.forEach(function(m) { oaiMessages.push({ role: m.role, content: m.content }); });

        const response = await fetch(endpoints[provider], {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': 'Bearer ' + apiKey,
          },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages: oaiMessages }),
        });
        const data = await response.json();

        // Normalise OpenAI response → Anthropic format so frontend works identically
        if (data.choices && data.choices[0]) {
          return new Response(JSON.stringify({
            content: [{ type: 'text', text: data.choices[0].message.content || '' }],
            model: data.model,
            usage: data.usage,
          }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        // Pass through errors
        return new Response(JSON.stringify(data), {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ════════════════════════════════════════════════════
      // GOOGLE GEMINI
      // ════════════════════════════════════════════════════
      if (provider === 'gemini') {
        const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' +
          model + ':generateContent?key=' + apiKey;

        // Convert to Gemini format
        const contents = [];
        if (system) {
          // Gemini doesn't have a system role — prepend as user/model exchange
          contents.push({ role: 'user',  parts: [{ text: '[System instruction]: ' + system }] });
          contents.push({ role: 'model', parts: [{ text: 'Understood, I will follow these instructions.' }] });
        }
        messages.forEach(function(m) {
          contents.push({
            role:  m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          });
        });

        const response = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            generationConfig: { maxOutputTokens: maxTokens },
          }),
        });
        const data = await response.json();

        // Normalise Gemini response → Anthropic format
        if (data.candidates && data.candidates[0]) {
          const text = data.candidates[0].content.parts
            .map(function(p){ return p.text || ''; }).join('');
          return new Response(JSON.stringify({
            content: [{ type: 'text', text }],
          }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify(data), {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Unknown provider
      return new Response(
        JSON.stringify({ error: { message: 'Unknown provider: ' + provider } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } catch(err) {
      return new Response(
        JSON.stringify({ error: { message: 'Worker proxy error: ' + err.message } }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }
};
