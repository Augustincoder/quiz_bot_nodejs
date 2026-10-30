/**
 * Cloudflare Worker: Ultra-Fast Secure Reverse Proxy Mirror for TsUE EduPage
 *
 * Deploy this free Cloudflare Worker to bypass university firewall / datacenter IP blocks.
 *
 * HOW TO DEPLOY (takes 1 minute, completely free):
 * 1. Log in to https://dash.cloudflare.com/
 * 2. Click on "Workers & Pages" -> "Create application" -> "Create Worker".
 * 3. Give it a name (e.g., `tsue-edupage-mirror`) and click "Deploy".
 * 4. Click "Edit code", replace all code with this file, and click "Save and Deploy".
 * 5. Copy the worker's URL (e.g. `https://tsue-edupage-mirror.<your-subdomain>.workers.dev`).
 * 6. In your bot's environment variables (Northflank, Render, Docker .env), add:
 *    EDUPAGE_BASE_URL=https://tsue-edupage-mirror.<your-subdomain>.workers.dev
 *
 * The bot will automatically route all EduPage requests through Cloudflare's global edge network!
 */

export default {
  async fetch(request, env, ctx) {
    const originUrl = new URL(request.url);

    // Forward path and search params to tsue.edupage.org
    const targetUrl = new URL(originUrl.pathname + originUrl.search, 'https://tsue.edupage.org');

    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.set('Host', 'tsue.edupage.org');
    forwardHeaders.set('Origin', 'https://tsue.edupage.org');
    forwardHeaders.set('Referer', 'https://tsue.edupage.org/timetable/');

    const init = {
      method: request.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'follow',
    };

    const response = await fetch(targetUrl.toString(), init);

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
