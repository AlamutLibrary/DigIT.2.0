export default {
  async fetch(request, env) {
    const ALLOWED_ORIGINS = [
      'https://alamutlibrary.github.io',
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'null',
    ];
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method === 'GET') return new Response(JSON.stringify({ status: 'Alamut Library Worker is running' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    const apiKey = (env.ANTHROPIC_API_KEY || '').trim() || (request.headers.get('X-API-Key') || '').trim();
    if (!apiKey) return new Response(JSON.stringify({ error: { message: 'No API key. Run: wrangler secret put ANTHROPIC_API_KEY' } }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    let body;
    try { body = await request.json(); } catch(e) { return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }
    body.max_tokens = Math.min(body.max_tokens || 1000, 4000);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch(err) {
      return new Response(JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }
};
