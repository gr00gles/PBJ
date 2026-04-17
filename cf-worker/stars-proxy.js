// Cloudflare Worker — proxies CMS Care Compare star ratings for gr00gles.github.io
// Deploy at: https://dash.cloudflare.com -> Workers & Pages -> Create Worker -> paste this
// Then set WORKER_URL in app.js to your deployed worker URL.

const CMS_URL = 'https://data.cms.gov/provider-data/api/1/datastore/query/4pq5-n9py/0';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://gr00gles.github.io',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const { searchParams } = new URL(request.url);
    const provnum = searchParams.get('provnum');
    if (!provnum || !/^\d{6}$/.test(provnum)) {
      return new Response('Bad request', { status: 400, headers: CORS_HEADERS });
    }

    const cmsParams = new URLSearchParams({
      'conditions[0][property]': 'PROVNUM',
      'conditions[0][value]': provnum,
      'conditions[0][operator]': '=',
      'limit': '1',
    });

    try {
      const res = await fetch(`${CMS_URL}?${cmsParams}`, {
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) {
        return new Response(`CMS error ${res.status}`, { status: 502, headers: CORS_HEADERS });
      }

      const body = await res.text();
      return new Response(body, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=21600', // 6 hours
        },
      });
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, { status: 502, headers: CORS_HEADERS });
    }
  },
};
