'use strict';

const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');
const util = require('util');
const gunzipAsync = util.promisify(zlib.gunzip);
const inflateAsync = util.promisify(zlib.inflate);
const logger = require('../../core/logger');

// Keep-alive agent to reuse TCP/TLS sockets and minimize connection latency
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  maxFreeSockets: 2,
  keepAliveMsecs: 1000,
  timeout: 30000,
  family: 4, // Strict IPv4 socket creation to bypass container IPv6 blackhole drops
});

httpsAgent.on('free', (socket) => {
  const idleTimer = setTimeout(() => {
    socket.destroy();
  }, 6000);
  socket.once('agentRemove', () => clearTimeout(idleTimer));
  socket.once('close', () => clearTimeout(idleTimer));
});

// Modern Browser Headers & Anti-Bot Fingerprint (Chrome 131+)
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BROWSER_SEC_CH_UA = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';

const DEFAULT_HEADERS = {
  'User-Agent': BROWSER_USER_AGENT,
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'uz,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Origin': 'https://tsue.edupage.org',
  'Referer': 'https://tsue.edupage.org/timetable/',
  'Sec-Ch-Ua': BROWSER_SEC_CH_UA,
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-Requested-With': 'XMLHttpRequest',
  'Connection': 'keep-alive',
};

const customProxyAgents = new Map();
let activeTransportName = 'direct';

function getConfiguredProxies() {
  const raw = process.env.EDUPAGE_PROXIES || process.env.EDUPAGE_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (!raw.trim()) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function resolveBaseUrl(endpointPath = '') {
  const customBase = process.env.EDUPAGE_BASE_URL || process.env.EDUPAGE_MIRROR_URL;
  if (customBase && customBase.trim()) {
    const trimmed = customBase.trim().replace(/\/+$/, '');
    return `${trimmed}${endpointPath.startsWith('/') ? endpointPath : '/' + endpointPath}`;
  }
  return `https://tsue.edupage.org${endpointPath.startsWith('/') ? endpointPath : '/' + endpointPath}`;
}

function createProxyAgent(proxyUrlString, targetHostname = 'tsue.edupage.org') {
  if (customProxyAgents.has(proxyUrlString)) {
    return customProxyAgents.get(proxyUrlString);
  }
  try {
    const parsed = new url.URL(proxyUrlString);
    const isProxyHttps = parsed.protocol === 'https:';
    const proxyTransport = isProxyHttps ? https : http;
    const proxyPort = parseInt(parsed.port, 10) || (isProxyHttps ? 443 : 8080);

    const agent = new https.Agent({
      keepAlive: false,
      family: 4,
      createConnection: (options, callback) => {
        const connectReq = proxyTransport.request({
          host: parsed.hostname,
          port: proxyPort,
          method: 'CONNECT',
          path: `${options.hostname || targetHostname}:${options.port || 443}`,
          headers: {
            Host: `${options.hostname || targetHostname}:${options.port || 443}`,
            'User-Agent': BROWSER_USER_AGENT,
            ...(parsed.username ? {
              'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password || '')}`).toString('base64')}`
            } : {})
          }
        });

        connectReq.on('connect', (res, socket) => {
          if (res.statusCode === 200) {
            const tlsSocket = https.connect({
              socket,
              servername: options.hostname || targetHostname,
            }, () => callback(null, tlsSocket));
            tlsSocket.on('error', (err) => callback(err));
          } else {
            callback(new Error(`Proxy CONNECT to ${parsed.hostname} rejected with status ${res.statusCode}`));
          }
        });

        connectReq.on('error', (err) => callback(err));
        connectReq.setTimeout(10000, () => {
          connectReq.destroy(new Error(`Proxy CONNECT to ${parsed.hostname} timed out after 10s`));
        });
        connectReq.end();
      }
    });

    customProxyAgents.set(proxyUrlString, agent);
    return agent;
  } catch (err) {
    logger.error('Failed to configure proxy agent', { proxy: proxyUrlString, error: err.message });
    return null;
  }
}

function getActiveEduPageAgent(targetHostname = 'tsue.edupage.org', preferredTransport = null) {
  const customBase = process.env.EDUPAGE_BASE_URL || process.env.EDUPAGE_MIRROR_URL;
  if (customBase && !preferredTransport) {
    activeTransportName = 'mirror';
    return httpsAgent;
  }

  const transport = preferredTransport || activeTransportName;
  if (transport === 'proxy') {
    const proxies = getConfiguredProxies();
    if (proxies.length > 0) {
      const agent = createProxyAgent(proxies[0], targetHostname);
      if (agent) return agent;
    }
  }

  activeTransportName = customBase ? 'mirror' : 'direct';
  return httpsAgent;
}

class EduPageSessionManager {
  constructor() {
    this.cookie = null;
    this.cookieExpiresAt = 0;
    this.refreshPromise = null;
  }

  async getSessionCookie(force = false) {
    const now = Date.now();
    if (!force && this.cookie && now < this.cookieExpiresAt) {
      return this.cookie;
    }
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this._fetchSessionCookie()
      .catch((err) => {
        logger.debug('Session cookie fetch deferred, using cached or empty session', { error: err.message });
        return this.cookie || '';
      })
      .finally(() => {
        this.refreshPromise = null;
      });

    return this.refreshPromise;
  }

  async _fetchSessionCookie() {
    return new Promise((resolve) => {
      const baseUrlStr = resolveBaseUrl('/timetable/');
      let parsed;
      try {
        parsed = new url.URL(baseUrlStr);
      } catch {
        parsed = new url.URL('https://tsue.edupage.org/timetable/');
      }
      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;
      const agent = getActiveEduPageAgent(parsed.hostname);

      const req = transport.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: 'GET',
        agent,
        family: 4,
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'uz,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'Sec-Ch-Ua': BROWSER_SEC_CH_UA,
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Connection': 'close',
        },
      }, (res) => {
        const setCookies = res.headers['set-cookie'] || [];
        const cookies = Array.isArray(setCookies)
          ? setCookies.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ')
          : '';
        res.resume();
        if (cookies) {
          this.cookie = cookies;
          this.cookieExpiresAt = Date.now() + (30 * 60 * 1000);
          logger.debug('Acquired fresh EduPage session cookie', { length: cookies.length });
          resolve(cookies);
        } else {
          resolve(this.cookie || '');
        }
      });

      const timer = setTimeout(() => {
        req.destroy(new Error('Session cookie GET timed out'));
        resolve(this.cookie || '');
      }, 5000);

      req.on('error', () => {
        clearTimeout(timer);
        resolve(this.cookie || '');
      });

      req.end();
    });
  }

  setCookie(cookieStr) {
    if (typeof cookieStr === 'string' && cookieStr.trim()) {
      this.cookie = cookieStr.trim();
      this.cookieExpiresAt = Date.now() + (30 * 60 * 1000);
    }
  }

  clear() {
    this.cookie = null;
    this.cookieExpiresAt = 0;
  }
}

const sessionManager = new EduPageSessionManager();

// EduPage Circuit Breaker
let circuitBreakerState = 'CLOSED'; // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
let consecutiveFailures = 0;
let nextCircuitRetryTime = 0;
let isHalfOpenProbeInFlight = false;
let probeInFlightStartedAt = 0;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_TIMEOUT_MS = 45000;
const PROBE_TIMEOUT_MS = 30000;

function isEduPageCircuitOpen() {
  if (circuitBreakerState === 'CLOSED') return false;
  const now = Date.now();
  if (circuitBreakerState === 'OPEN') {
    return now < nextCircuitRetryTime;
  }
  if (circuitBreakerState === 'HALF_OPEN') {
    if (isHalfOpenProbeInFlight && (now - probeInFlightStartedAt < PROBE_TIMEOUT_MS)) {
      return true;
    }
    return false;
  }
  return false;
}

function recordEduPageFailure(err) {
  consecutiveFailures++;
  isHalfOpenProbeInFlight = false;
  probeInFlightStartedAt = 0;
  if (consecutiveFailures >= FAILURE_THRESHOLD || circuitBreakerState === 'HALF_OPEN') {
    circuitBreakerState = 'OPEN';
    const backoffMs = Math.min(300000, 30000 * Math.pow(1.5, Math.min(consecutiveFailures - 3, 5)));
    const jitter = Math.floor(Math.random() * 3000);
    const retryDelay = Math.max(CIRCUIT_RESET_TIMEOUT_MS, backoffMs) + jitter;
    nextCircuitRetryTime = Date.now() + retryDelay;
    logger.warn(`⚡ EduPage Circuit Breaker tripped to OPEN (${consecutiveFailures} consecutive failures, previous state: ${circuitBreakerState}). Fast-failing network calls for ${Math.round(retryDelay / 1000)}s.`, { error: err?.message });
  }
}

function recordEduPageSuccess() {
  if (circuitBreakerState !== 'CLOSED') {
    logger.info('✅ EduPage Circuit Breaker recovered and reset to CLOSED.');
  }
  circuitBreakerState = 'CLOSED';
  consecutiveFailures = 0;
  nextCircuitRetryTime = 0;
  isHalfOpenProbeInFlight = false;
  probeInFlightStartedAt = 0;
}

function canAttemptEduPageNetwork() {
  if (circuitBreakerState === 'CLOSED') return true;

  const now = Date.now();
  if (circuitBreakerState === 'OPEN') {
    if (now >= nextCircuitRetryTime) {
      circuitBreakerState = 'HALF_OPEN';
      isHalfOpenProbeInFlight = true;
      probeInFlightStartedAt = now;
      logger.info('🔄 EduPage Circuit Breaker testing recovery (HALF_OPEN probe request)...');
      return true;
    }
    return false;
  }

  if (circuitBreakerState === 'HALF_OPEN') {
    if (isHalfOpenProbeInFlight && (now - probeInFlightStartedAt >= PROBE_TIMEOUT_MS)) {
      logger.warn('⚠️ EduPage Circuit Breaker HALF_OPEN probe expired or abandoned (>30s). Re-allowing probe.');
      isHalfOpenProbeInFlight = false;
    }

    if (!isHalfOpenProbeInFlight) {
      isHalfOpenProbeInFlight = true;
      probeInFlightStartedAt = now;
      return true;
    }
    return false;
  }
  return true;
}

/**
 * Executes an HTTP POST request to EduPage with gzip/deflate decoding and cookie injection
 */
async function httpPost(endpoint, body, timeoutMs = 20000, options = {}) {
  const fullUrlStr = resolveBaseUrl(endpoint);
  let parsedUrl;
  try {
    parsedUrl = new url.URL(fullUrlStr);
  } catch (err) {
    throw new Error(`Invalid EduPage target URL: "${fullUrlStr}" - ${err.message}`);
  }

  const isHttps = parsedUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const postData = JSON.stringify(body);
  const agent = getActiveEduPageAgent(parsedUrl.hostname, options.preferredTransport);
  const cookie = await sessionManager.getSessionCookie();

  const reqHeaders = {
    ...DEFAULT_HEADERS,
    'Host': parsedUrl.host,
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Length': Buffer.byteLength(postData),
    ...(cookie ? { 'Cookie': cookie } : {}),
  };

  return new Promise((resolve, reject) => {
    let timer = null;
    let completed = false;

    const req = transport.request({
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: 'POST',
      agent,
      headers: reqHeaders,
      family: 4,
    }, (res) => {
      const setCookies = res.headers['set-cookie'];
      if (setCookies) {
        const freshCookies = Array.isArray(setCookies)
          ? setCookies.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ')
          : String(setCookies).split(';')[0].trim();
        if (freshCookies) sessionManager.setCookie(freshCookies);
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', async () => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);

        try {
          const buffer = Buffer.concat(chunks);
          const encoding = (res.headers['content-encoding'] || '').toLowerCase();
          let decodedBuf = buffer;

          if (encoding.includes('gzip')) {
            decodedBuf = await gunzipAsync(buffer);
          } else if (encoding.includes('deflate')) {
            decodedBuf = await inflateAsync(buffer);
          }

          const rawText = decodedBuf.toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`EduPage HTTP error: status ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.bodySnippet = rawText.slice(0, 300);
            return reject(err);
          }

          try {
            const parsed = JSON.parse(rawText);
            resolve(parsed);
          } catch (jsonErr) {
            const parseErr = new Error(`EduPage response JSON parse failed: ${jsonErr.message}`);
            parseErr.rawSnippet = rawText.slice(0, 300);
            reject(parseErr);
          }
        } catch (decompErr) {
          reject(new Error(`Failed decompressing EduPage stream: ${decompErr.message}`));
        }
      });
    });

    timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      req.destroy(new Error(`EduPage POST request timed out after ${timeoutMs}ms`));
      reject(new Error(`EduPage POST request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on('error', (err) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Ultra-fast lightweight health probe (332 bytes).
 */
async function probeEduPageHealth(timeoutMs = 6000) {
  try {
    const currentYear = new Date().getFullYear();
    const payload = { __args: [null, currentYear], __gsh: '00000000' };
    const res = await httpPost('/timetable/server/ttviewer.js?__func=getTTViewerData', payload, timeoutMs, { isProbe: true });
    const defaultNum = res?.r?.regular?.default_num;
    if (defaultNum && String(defaultNum).trim()) {
      recordEduPageSuccess();
      return { ok: true, defaultNum: String(defaultNum).trim(), timetables: res?.r?.regular?.timetables || [] };
    }
    return { ok: false, error: 'Empty default_num in probe response' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function testTransports() {
  const results = {};
  const t0 = Date.now();
  try {
    const payload = { __args: [null, new Date().getFullYear()], __gsh: '00000000' };
    const res = await httpPost('/timetable/server/ttviewer.js?__func=getTTViewerData', payload, 8000, { isProbe: true });
    results.direct = { ok: true, latencyMs: Date.now() - t0, defaultNum: res?.r?.regular?.default_num };
  } catch (err) {
    results.direct = { ok: false, latencyMs: Date.now() - t0, error: err.message };
  }
  return results;
}

module.exports = {
  httpsAgent,
  BROWSER_USER_AGENT,
  BROWSER_SEC_CH_UA,
  DEFAULT_HEADERS,
  resolveBaseUrl,
  getActiveEduPageAgent,
  sessionManager,
  isEduPageCircuitOpen,
  recordEduPageFailure,
  recordEduPageSuccess,
  canAttemptEduPageNetwork,
  probeEduPageHealth,
  httpPost,
  testTransports,
  getActiveTransportName: () => activeTransportName,
  getConfiguredProxies,
  _getCircuitBreakerState: () => ({
    state: circuitBreakerState,
    consecutiveFailures,
    nextCircuitRetryTime,
    isHalfOpenProbeInFlight,
  }),
  _setCircuitBreakerState: (state, nextRetry = 0, inFlight = false) => {
    circuitBreakerState = state;
    nextCircuitRetryTime = nextRetry;
    isHalfOpenProbeInFlight = inFlight;
  },
};
