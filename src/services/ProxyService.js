const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

class ProxyService {
  constructor() {
    this.proxies = [];
    this.currentIndex = 0;
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
    if (this.proxies.length === 0) {
      return null;
    }

    const proxy = this.proxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    return proxy;
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
    const { httpAgent, httpsAgent } = this.getAgents();
    
    // Add proxy agents to fetch options if proxies are configured
    if (httpAgent || httpsAgent) {
      options = {
        ...options,
        agent: (parsedUrl) => {
          return parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent;
        },
      };
    }

    return fetch(url, options);
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
    if (this.proxies.length === 0) {
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
    return {
      totalProxies: this.proxies.length,
      currentRotationIndex: this.currentIndex,
      proxiesConfigured: this.proxies.length > 0,
    };
  }
}

module.exports = new ProxyService();
