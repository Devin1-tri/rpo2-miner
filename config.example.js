// RPOW2 Miner Configuration — Tuned for Dell PowerEdge T40
// (Intel Xeon E-2224G, 4 cores / 4 threads @ 3.5 GHz, 8 GB RAM)
//
// Copy this file to `config.js` and edit SESSION_COOKIE.
//
// Why these defaults differ from upstream:
//   - NUM_WORKERS = 3     → leave 1 core for OS (T40 has no HT, only 4 threads total)
//   - LOOP_DELAY_MS = 5500 → matches server cooldown so we never hit HTTP 429
//   - MAX_RETRIES   = 10   → tolerant to transient network blips (residential ISP)
//   - RETRY_DELAY_MS = 3000 → only used for non-429 errors
//
// All values can be overridden via env vars (see README.md).

module.exports = {
  // ─── Required ────────────────────────────────────────────────────────────
  // Your rpow_session cookie value. Login at rpow2.com,
  // open DevTools > Application > Cookies > rpow_session > copy "Value".
  // The cookie expires after ~30 days.
  SESSION_COOKIE: process.env.RPOW_SESSION || 'PASTE_YOUR_SESSION_COOKIE_HERE',

  // ─── API endpoint ────────────────────────────────────────────────────────
  API_BASE: process.env.RPOW_API_BASE || 'https://api.rpow2.com',

  // ─── CPU concurrency (T40 = 4 cores / 4 threads) ─────────────────────────
  // Recommended: 3 (mining) + 1 (OS) on Xeon E-2224G.
  // If T40 is fully dedicated and you don't need the GUI/SSH responsive,
  // you may set this to 4 — but expect higher latency on other tasks.
  NUM_WORKERS: parseInt(process.env.RPOW_WORKERS || '3', 10),

  // Nonce range per worker (Node.js fallback only — Rust solver ignores this).
  BATCH_SIZE: 1_000_000,

  // ─── Anti-429 throttle ───────────────────────────────────────────────────
  // Delay between a successful mint and the next /challenge request, in ms.
  // The rpow2.com API enforces a ~5 second cooldown — we wait 5.5s to be safe.
  // Lower this only if upstream changes the cooldown.
  LOOP_DELAY_MS: parseInt(process.env.RPOW_DELAY || '5500', 10),

  // ─── Retry policy (for real errors, NOT 429) ─────────────────────────────
  // 429 responses are handled transparently inside apiRequest and never
  // count toward MAX_RETRIES.
  MAX_RETRIES: 10,
  RETRY_DELAY_MS: 3000,
};
