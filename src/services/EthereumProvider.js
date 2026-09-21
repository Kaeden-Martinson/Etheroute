/**
 * EVM RPC providers with failover, one pool per chain.
 *
 * Each pool owns its chain's endpoint list (from the registry, or the chain's
 * `*_RPC_URLS` override), probes for one that actually answers, caches it,
 * and moves on to the next when the current one starts failing.
 *
 * The module-level functions (`getProvider`, `withProvider`, ...) are the
 * Ethereum pool, so the code written when ETH was the only EVM chain keeps
 * working. Everything else goes through `forChain(code)`.
 */
const { ethers } = require('ethers');
const logger = require('./logger');
const chains = require('../config/chains');

const PROBE_TIMEOUT_MS = 6000;

// How long a chosen endpoint is trusted before it is re-probed. Short enough
// that recovery is quick, long enough that we are not probing every call.
const HEALTHY_TTL_MS = 60 * 1000;

// Endpoints that failed a probe are skipped for this long. Without it the
// first URL in the list was re-probed on every re-selection - one wasted call
// and one warning per minute for an endpoint that is over its daily quota.
const ENDPOINT_COOLDOWN_MS = 10 * 60 * 1000;

const TRANSPORT_FAILURE =
    /failed to detect network|could not detect network|SERVER_ERROR|TIMEOUT|ECONNREFUSED|ENOTFOUND|EPROTO|fetch failed|socket hang up|altnames|certificate|usage limit|rate limit|429/i;

// How an endpoint says it will not serve eth_getLogs (bsc-dataseed answers
// "limit exceeded" to every query, however narrow; others cap the range or
// lack the method). Not a transport failure: the endpoint is fine for
// everything else and is kept for it.
const LOGS_REFUSED = /limit exceeded|not supported|method not found|-32005|-32601|block range|too many|exceeds/i;
// The endpoint chosen for logs is kept this long before being tried afresh.
const LOGS_TTL_MS = 30 * 60 * 1000;

class RpcPool {
    constructor(chain) {
        this.chain = chain;
        this.tag = `[EthereumProvider:${chain.code}]`;
        // Stated up front so ethers never has to detect it: no eth_chainId
        // round trip, and no "failed to detect network ... retry in 1s" loop
        // when an endpoint answers the first call with an error.
        this.network = ethers.Network.from(chain.chainId);
        this.current = null;   // { provider, url, checkedAt }
        this.logs = null;      // { provider, url, checkedAt } - the one that serves eth_getLogs
        this.inFlight = null;  // de-duplicates concurrent selections
        this.cooldowns = new Map();
    }

    endpoints() {
        return chains.rpcUrls(this.chain.code);
    }

    /**
     * Confirm an endpoint actually answers, with the calls this application
     * makes - some endpoints answer blockNumber while refusing getBalance.
     */
    async probe(url) {
        const provider = new ethers.JsonRpcProvider(url, this.network, {
            staticNetwork: this.network,
            batchMaxCount: 1,      // some public endpoints reject batched calls
        });

        const timeout = (promise) => Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS)
            ),
        ]);

        try {
            const blockNumber = await timeout(provider.getBlockNumber());
            if (!Number.isFinite(blockNumber) || blockNumber <= 0) {
                throw new Error(`implausible block number: ${blockNumber}`);
            }
            await timeout(provider.getBalance('0x0000000000000000000000000000000000000000'));
            await timeout(provider.getFeeData());
            return provider;
        } catch (error) {
            // Release the endpoint's sockets and timers; a provider that failed
            // its probe is never used again.
            provider.destroy();
            throw error;
        }
    }

    async select() {
        const failures = [];
        const now = Date.now();
        const candidates = this.endpoints();
        const ready = candidates.filter((url) => (this.cooldowns.get(url) || 0) <= now);
        // If every endpoint is cooling down, try them all anyway rather than
        // refuse outright - one of them may have recovered.
        const order = ready.length > 0 ? ready : candidates;

        for (const url of order) {
            try {
                const provider = await this.probe(url);
                this.cooldowns.delete(url);
                this.current = { provider, url, checkedAt: Date.now() };
                logger.info(`${this.tag} Using ${url}`);
                return provider;
            } catch (error) {
                this.cooldowns.set(url, Date.now() + ENDPOINT_COOLDOWN_MS);
                failures.push(`${url}: ${error.message}`);
                logger.warn(`${this.tag} ${url} unreachable - ${error.message} (skipped for ${ENDPOINT_COOLDOWN_MS / 60000} min)`);
            }
        }

        this.current = null;

        // A DNS filter that hijacks these hostnames produces a TLS certificate
        // for the block page rather than the endpoint.
        const hijacked = failures.some((f) => /altnames|certificate|ERR_TLS_CERT_ALTNAME_INVALID/i.test(f));
        const hint = hijacked
            ? '\n\nThe certificate errors above mean something on this network is ' +
              'intercepting these hostnames - typically router-level DNS filtering, ' +
              'which resolves them to a block page. Fix it on the network, or set ' +
              `${this.chain.rpcEnv} to an endpoint that is not filtered.`
            : `\n\nSet ${this.chain.rpcEnv} to a working endpoint.`;

        throw new Error(`No ${this.chain.name} RPC endpoint is reachable. Tried:\n  ${failures.join('\n  ')}${hint}`);
    }

    /** A provider that has answered recently. */
    async getProvider() {
        if (this.current && Date.now() - this.current.checkedAt < HEALTHY_TTL_MS) {
            return this.current.provider;
        }
        if (!this.inFlight) {
            this.inFlight = this.select().finally(() => { this.inFlight = null; });
        }
        return this.inFlight;
    }

    /** Drop the cached endpoint so the next call re-selects. */
    markUnhealthy(reason) {
        if (this.current) {
            logger.warn(`${this.tag} Dropping ${this.current.url}: ${reason}`);
            try { this.current.provider.destroy(); } catch { /* already gone */ }
            this.current = null;
        }
    }

    /**
     * Run an RPC call, retrying once on a different endpoint if the first
     * attempt fails for a connection-shaped reason. A reverted transaction or
     * a bad address is not retried - only transport failures.
     */
    async withProvider(operation) {
        const provider = await this.getProvider();
        try {
            return await operation(provider);
        } catch (error) {
            const message = String(error && error.message);
            if (!TRANSPORT_FAILURE.test(message)) throw error;
            this.markUnhealthy(message.slice(0, 80));
            const replacement = await this.getProvider();
            return operation(replacement);
        }
    }

    activeUrl() {
        return this.current ? this.current.url : null;
    }

    /**
     * Run an operation that reads logs. The main endpoint is tried first;
     * one that refuses eth_getLogs is not dropped (it serves everything
     * else), the chain's other endpoints are tried in turn, and the first
     * that answers is remembered for a while. Any other error is the
     * operation's own and is thrown as it is.
     */
    async withLogs(operation) {
        const refusal = (error) => {
            const message = String(error && error.message);
            return LOGS_REFUSED.test(message) || TRANSPORT_FAILURE.test(message);
        };

        if (this.logs && Date.now() - this.logs.checkedAt < LOGS_TTL_MS) {
            try {
                return await operation(this.logs.provider);
            } catch (error) {
                if (!refusal(error)) throw error;
                if (this.logs.provider !== (this.current && this.current.provider)) {
                    try { this.logs.provider.destroy(); } catch { /* already gone */ }
                }
                this.logs = null;
            }
        }

        const main = await this.getProvider();
        const mainUrl = this.activeUrl();
        const urls = [mainUrl, ...this.endpoints().filter((url) => url !== mainUrl)];
        const failures = [];
        for (const url of urls) {
            const provider = url === mainUrl
                ? main
                : new ethers.JsonRpcProvider(url, this.network, { staticNetwork: this.network, batchMaxCount: 1 });
            try {
                const result = await operation(provider);
                if (url !== mainUrl) logger.info(`${this.tag} Reading logs from ${url}`);
                this.logs = { provider, url, checkedAt: Date.now() };
                return result;
            } catch (error) {
                if (!refusal(error)) {
                    if (provider !== main) provider.destroy();
                    throw error;
                }
                failures.push(`${url}: ${String(error.message).slice(0, 80)}`);
                if (provider !== main) provider.destroy();
            }
        }
        throw new Error(`No ${this.chain.name} RPC endpoint serves eth_getLogs. Tried:\n  ${failures.join('\n  ')}`);
    }
}

const pools = new Map();

/** The pool for an EVM chain, created on first use. */
function forChain(code) {
    const chain = chains.get(code);
    if (chain.family !== 'evm') {
        throw new Error(`${chain.code} is not an EVM chain`);
    }
    if (!pools.has(chain.code)) {
        pools.set(chain.code, new RpcPool(chain));
    }
    return pools.get(chain.code);
}

// ── Ethereum-bound API, kept for the code written before other EVM chains ──

const eth = () => forChain('ETH');

async function getProvider() {
    return eth().getProvider();
}

function markUnhealthy(reason) {
    return eth().markUnhealthy(reason);
}

async function withProvider(operation) {
    // Resolved through the exported object so callers (and tests) that
    // replace `getProvider` are honoured.
    const provider = await api.getProvider();
    try {
        return await operation(provider);
    } catch (error) {
        const message = String(error && error.message);
        if (!TRANSPORT_FAILURE.test(message)) throw error;
        api.markUnhealthy(message.slice(0, 80));
        const replacement = await api.getProvider();
        return operation(replacement);
    }
}

function activeUrl() {
    return eth().activeUrl();
}

function endpoints() {
    return chains.rpcUrls('ETH');
}

const api = { getProvider, withProvider, markUnhealthy, activeUrl, endpoints, forChain, RpcPool };

module.exports = api;
