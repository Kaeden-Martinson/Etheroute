const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Node's built-in fetch (undici) ignores the `agent` option entirely, so the
// proxies configured here were never used - every explorer and RPC call left
// from the server's own address, and shared that address's rate limit.
// node-fetch honours agents, so proxied requests go through it.
const nodeFetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// How long a proxy is skipped after it fails to connect or refuses our
// credentials. Long enough not to hammer a dead one; short enough to pick it
// back up when it recovers.
const PROXY_COOLDOWN_MS = 10 * 60 * 1000;

// Per-attempt timeout through a proxy. A proxy that is slow is a proxy that
// is not helping.
const PROXY_TIMEOUT_MS = 15_000;

// Set PROXY_MODE=off to bypass the proxy list entirely without deleting it.
const PROXIES_ENABLED = (process.env.PROXY_MODE || 'on').toLowerCase() !== 'off';

/** A message with any API key in a quoted URL's query string blanked. */
function redactKeys(text) {
  return String(text).replace(/([?&](?:apikey|api_key|key|token)=)[^&\s]+/gi, '$1[redacted]');
}

class ProxyService {
  constructor() {
    this.proxies = [];
    this.currentIndex = 0;
    // proxy "ip:port" -> timestamp it may be tried again
    this.cooldowns = new Map();
    this.agentCache = new Map();
    this.loadProxies();
  }

  /**
   * Load proxies from proxies.json file
   */
  loadProxies() {
    try {
      const proxiesPath = path.join(__dirname, '../../proxies/proxies.json');
      if (!fs.existsSync(proxiesPath)) {
        console.warn('Proxies file not found, continuing without proxy support');
        return;
      }

      const data = fs.readFileSync(proxiesPath, 'utf8');
      this.proxies = JSON.parse(data);
      
      // Validate proxy structure
      this.proxies.forEach((proxy, index) => {
        if (!proxy.ip || !proxy.port) {
          throw new Error(`Proxy ${index} missing required fields (ip, port)`);
        }
      });

      console.log(`Loaded ${this.proxies.length} proxies from proxies.json`);
    } catch (error) {
      console.error('Error loading proxies:', error.message);
      this.proxies = [];
    }
  }

  /**
   * Get next proxy in rotation
   * @returns {Object|null} Proxy object or null if no proxies configured
   */
  getNextProxy() {
    if (!PROXIES_ENABLED || this.proxies.length === 0) {
      return null;
    }

    // Skip proxies that recently failed. If every one is cooling down, go
    // direct rather than wait.
    const now = Date.now();
    for (let i = 0; i < this.proxies.length; i++) {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;

      const until = this.cooldowns.get(this.proxyKey(proxy)) || 0;
      if (until <= now) return proxy;
    }
    return null;
  }

  proxyKey(proxy) {
    return `${proxy.ip}:${proxy.port}`;
  }

  markBad(proxy, reason) {
    this.cooldowns.set(this.proxyKey(proxy), Date.now() + PROXY_COOLDOWN_MS);
    // The reason quotes the URL; a key in its query string stays out of the logs.
    console.warn(`[ProxyService] Proxy ${this.proxyKey(proxy)} sidelined for ${PROXY_COOLDOWN_MS / 60000} min: ${redactKeys(reason)}`);
  }

  agentsFor(proxy) {
    const key = this.proxyKey(proxy);
    if (!this.agentCache.has(key)) {
      const url = this.buildProxyUrl(proxy);
      this.agentCache.set(key, {
        httpAgent: new HttpProxyAgent(url),
        httpsAgent: new HttpsProxyAgent(url),
      });
    }
    return this.agentCache.get(key);
  }

  /**
   * Build proxy URL from proxy object
   * @param {Object} proxy - Proxy configuration
   * @returns {string} Proxy URL
   */
  buildProxyUrl(proxy) {
    if (!proxy) return null;
    
    const { ip, port, username, password } = proxy;
    
    if (username && password) {
      return `http://${username}:${password}@${ip}:${port}`;
    }
    return `http://${ip}:${port}`;
  }

  /**
   * Get HTTP/HTTPS agents for the next proxy
   * @returns {Object} { httpAgent, httpsAgent } or { httpAgent: null, httpsAgent: null }
   */
  getAgents() {
    const proxy = this.getNextProxy();
    
    if (!proxy) {
      return { httpAgent: null, httpsAgent: null };
    }

    const proxyUrl = this.buildProxyUrl(proxy);
    
    return {
      httpAgent: new HttpProxyAgent(proxyUrl),
      httpsAgent: new HttpsProxyAgent(proxyUrl),
    };
  }

  /**
   * Fetch with proxy support
   * @param {string} url - URL to fetch
   * @param {Object} options - Fetch options (method, headers, body, etc.)
   * @returns {Promise<Response>} Response object
   */
  async fetch(url, options = {}) {
    const proxy = this.getNextProxy();
    if (!proxy) {
      return fetch(url, options);
    }

    const { httpAgent, httpsAgent } = this.agentsFor(proxy);
    const proxied = {
      ...options,
      agent: (parsedUrl) => (parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent),
      signal: options.signal || AbortSignal.timeout(PROXY_TIMEOUT_MS),
    };

    try {
      const response = await nodeFetch(url, proxied);

      // 407 is the proxy refusing us, not the target refusing the request.
      if (response.status === 407) {
        this.markBad(proxy, 'proxy authentication failed');
        return fetch(url, options);
      }

      return response;
    } catch (error) {
      // Could not get through the proxy at all. Sideline it and go direct so
      // one dead proxy does not fail the balance check or broadcast behind it.
      this.markBad(proxy, error.message);
      return fetch(url, options);
    }
  }

  /**
   * Parse Retry-After header to determine wait time
   * @param {Response} response - Fetch response object
   * @returns {number|null} Milliseconds to wait, or null if no Retry-After header
   */
  parseRetryAfter(response) {
    const retryAfter = response.headers.get('Retry-After');
    
    if (!retryAfter) {
      return null;
    }

    // Check if it's a number (seconds) or a date
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000; // Convert to milliseconds
    }

    // Try parsing as HTTP date
    const retryDate = new Date(retryAfter);
    if (!isNaN(retryDate.getTime())) {
      const now = new Date();
      const waitMs = retryDate.getTime() - now.getTime();
      return Math.max(0, waitMs);
    }

    return null;
  }

  /**
   * Check if response is rate limited
   * @param {Response} response - Fetch response object
   * @returns {boolean} True if rate limited (429)
   */
  isRateLimited(response) {
    return response.status === 429;
  }

  /**
   * Get current proxy info (for debugging/logging)
   * @returns {string} Proxy info or 'No proxy'
   */
  getCurrentProxyInfo() {
    if (!PROXIES_ENABLED || this.proxies.length === 0) {
      return 'No proxy configured';
    }

    const lastIndex = (this.currentIndex - 1 + this.proxies.length) % this.proxies.length;
    const proxy = this.proxies[lastIndex];
    return `${proxy.ip}:${proxy.port}`;
  }

  /**
   * Get proxy statistics
   * @returns {Object} Stats object
   */
  getStats() {
    const now = Date.now();
    const coolingDown = [...this.cooldowns.values()].filter((until) => until > now).length;
    return {
      enabled: PROXIES_ENABLED,
      totalProxies: this.proxies.length,
      coolingDown,
      currentRotationIndex: this.currentIndex,
      proxiesConfigured: PROXIES_ENABLED && this.proxies.length > 0,
    };
  }
}

module.exports = new ProxyService();
