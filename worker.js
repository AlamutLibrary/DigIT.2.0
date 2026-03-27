export default {
  async fetch(request, env) {

    const corsHeaders = {
      'Access-Control-Allow-Origin':  'https://alamutlibrary.github.io',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Access-Control-Max-Age':       '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'Alamut Library Worker is running' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    const apiKey = (env.ANTHROPIC_API_KEY || '').trim() ||
                   (request.headers.get('X-API-Key') || '').trim();

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: 'No API key configured.' } }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let body;
    try { body = await request.json(); }
    catch(e) {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid JSON: ' + e.message } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    body.max_tokens = Math.min(body.max_tokens || 1000, 4000);

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
