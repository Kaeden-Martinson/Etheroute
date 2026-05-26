/**
 * SideshiftAccountService - Manages proxy/account rotation for Sideshift API requests.
 *
 * Each entry in data/accounts.json pairs a Sideshift affiliate account (affiliateId +
 * secret) with a dedicated proxy. This service round-robins across accounts and enforces
 * per-account rate limits in memory so the app never exceeds Sideshift's thresholds:
 *   - Quotes  (/v2/quotes):            20 per minute per account
 *   - Shifts  (/v2/shifts/variable):    5 per minute per account
 */

const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

const ACCOUNTS_FILE = path.join(__dirname, '../../data/accounts.json');

// Per-account rate limits (requests per 60-second window)
const RATE_LIMITS = {
  quote: 20,
  shift: 5,
};

class SideshiftAccountService {
  constructor() {
    this.accounts = [];
    this.currentIndex = 0;

    // In-memory rate-limit tracker: { [accountId]: { shifts: [timestamp], quotes: [timestamp] } }
    this.usageTracker = {};

    // Cache HttpsProxyAgent instances so we don't recreate them on every request
    this.agentCache = {};

    this._load();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  _load() {
    try {
      if (fs.existsSync(ACCOUNTS_FILE)) {
        const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
        this.accounts = JSON.parse(raw).accounts || [];
        console.log(`[SideshiftAccountService] Loaded ${this.accounts.length} account(s)`);
      } else {
        console.warn('[SideshiftAccountService] accounts.json not found — no accounts loaded');
        this.accounts = [];
      }
    } catch (err) {
      console.error('[SideshiftAccountService] Failed to load accounts:', err.message);
      this.accounts = [];
    }
  }

  _save() {
    try {
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts: this.accounts }, null, 2), 'utf-8');
    } catch (err) {
      console.error('[SideshiftAccountService] Failed to save accounts:', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Agent caching
  // ---------------------------------------------------------------------------

  _getAgent(proxyUrl) {
    if (!this.agentCache[proxyUrl]) {
      this.agentCache[proxyUrl] = new HttpsProxyAgent(proxyUrl);
    }
    return this.agentCache[proxyUrl];
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Return the next account that has not exceeded its rate limit for the given
   * request type, advancing the round-robin index.
   *
   * @param {'quote'|'shift'} type
   * @returns {{ account: Object, agent: HttpsProxyAgent, affiliateId: string, secret: string }}
   * @throws {Error} when all accounts are currently rate-limited
   */
  getAccount(type = 'quote') {
    const limit = RATE_LIMITS[type] ?? 20;
    const windowMs = 60 * 1000;
    const now = Date.now();

    const active = this.accounts.filter(a => a.active !== false);
    if (active.length === 0) {
      throw new Error('[SideshiftAccountService] No active Sideshift accounts configured in data/accounts.json');
    }

    for (let i = 0; i < active.length; i++) {
      const idx = (this.currentIndex + i) % active.length;
      const account = active[idx];

      const tracker = this.usageTracker[account.id] || { shifts: [], quotes: [] };
      const key = type === 'shift' ? 'shifts' : 'quotes';
      const recent = tracker[key].filter(t => now - t < windowMs).length;

      if (recent < limit) {
        // Advance the round-robin pointer for the next call
        this.currentIndex = (idx + 1) % active.length;

        console.log(
          `[SideshiftAccountService] Account "${account.id}" selected for ${type} ` +
          `(${recent}/${limit} in last 60 s)`
        );

        return {
          account,
          agent: this._getAgent(account.proxyUrl),
          affiliateId: account.affiliateId,
          secret: account.secret,
        };
      }
    }

    throw new Error(
      `[SideshiftAccountService] All accounts are rate-limited for "${type}" requests. ` +
      'Add more accounts/proxies to data/accounts.json or wait for the window to reset.'
    );
  }

  /**
   * Record a completed request against an account so rate-limit tracking stays accurate.
   *
   * @param {string} accountId
   * @param {'quote'|'shift'} type
   */
  recordUsage(accountId, type) {
    const now = Date.now();
    const windowMs = 60 * 1000;

    if (!this.usageTracker[accountId]) {
      this.usageTracker[accountId] = { shifts: [], quotes: [] };
    }

    const key = type === 'shift' ? 'shifts' : 'quotes';
    this.usageTracker[accountId][key].push(now);

    // Prune timestamps outside the rolling window
    this.usageTracker[accountId][key] = this.usageTracker[accountId][key].filter(
      t => now - t < windowMs
    );

    // Persist updated stats (total lifetime count + lastUsed)
    const account = this.accounts.find(a => a.id === accountId);
    if (account) {
      account.requestCount = (account.requestCount || 0) + 1;
      account.lastUsed = new Date().toISOString();
      this._save();
    }
  }

  /**
   * Add a new account entry (e.g. called programmatically when provisioning a new proxy).
   *
   * @param {{ affiliateId: string, secret: string, proxyUrl: string }} params
   * @returns {Object} The created account record
   */
  addAccount({ affiliateId, secret, proxyUrl }) {
    const account = {
      id: `account_${Date.now()}`,
      affiliateId,
      secret,
      proxyUrl,
      active: true,
      requestCount: 0,
      lastUsed: null,
      createdAt: new Date().toISOString(),
    };
    this.accounts.push(account);
    this._save();
    console.log(`[SideshiftAccountService] Added new account: ${account.id}`);
    return account;
  }

  /**
   * Return a snapshot of all accounts with their current in-window usage.
   */
  getStatus() {
    const now = Date.now();
    const windowMs = 60 * 1000;
    return this.accounts.map(a => {
      const tracker = this.usageTracker[a.id] || { shifts: [], quotes: [] };
      return {
        id: a.id,
        affiliateId: a.affiliateId,
        proxyUrl: a.proxyUrl,
        active: a.active,
        requestCount: a.requestCount,
        lastUsed: a.lastUsed,
        windowUsage: {
          quotes: tracker.quotes.filter(t => now - t < windowMs).length,
          shifts: tracker.shifts.filter(t => now - t < windowMs).length,
        },
      };
    });
  }
}

// Export as a singleton so the rotation state is shared across all callers
module.exports = new SideshiftAccountService();
