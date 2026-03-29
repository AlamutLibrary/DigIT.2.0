/**
 * Alamut Library — Multi-Provider Cloudflare Worker v2.1
 *
 * Providers: Anthropic, OpenAI, Google Gemini, Mistral, DeepSeek, Groq
 *
 * DEPLOY:
 *   wrangler deploy
 *   wrangler secret put ANTHROPIC_API_KEY
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
  'deepseek':  'https://api.deepseek.com/chat/completions',  // note: no /v1/
  'groq':      'https://api.groq.com/openai/v1/chat/completions',
};

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
        JSON.stringify({ status: 'Alamut Library Worker is running', version: '2.1' }),
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
        // Convert Anthropic-style to OpenAI format
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

        // Normalise to Anthropic format so frontend works identically
        if (data.choices && data.choices[0]) {
          return new Response(JSON.stringify({
            content: [{ type: 'text', text: data.choices[0].message.content || '' }],
            model: data.model,
            usage: data.usage,
          }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Pass through errors unchanged
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

        // Surface Gemini errors clearly
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
