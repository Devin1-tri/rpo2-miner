// RPOW2 Multi-Thread Miner - Phase 1 Optimized
// 1 account, N cores brute-forcing each challenge in parallel
// Optimizations: pipeline overlap, zero-BigInt workers, crypto.hash()
//
// T40 fork changes:
//   - apiRequest now respects 429 `retry_after` (server cooldown) automatically
//   - 429 backoff does NOT count toward MAX_RETRIES (only real errors do)
//   - Default LOOP_DELAY_MS bumped to 5500ms so we proactively avoid 429

const { Worker } = require('worker_threads');
const path = require('path');
const config = require('./config');

const WORKER_PATH = path.join(__dirname, 'worker.js');

// ─── API Helpers ────────────────────────────────────────────────────────────────

async function apiRequest(endpoint, method = 'GET', body = null, retries = 3) {
  const url = `${config.API_BASE}${endpoint}`;
  const headers = {
    'Cookie': `rpow_session=${config.SESSION_COOKIE}`,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
  };

  const opts = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  // 429 cooldown retries are unlimited and do NOT count toward `retries`.
  // Network errors still get exactly `retries` chances with linear backoff.
  let netAttempt = 0;
  while (true) {
    try {
      const res = await fetch(url, opts);

      // 429 → respect server's retry_after, then transparently retry.
      if (res.status === 429) {
        const text = await res.text();
        let waitMs = 5500;
        try {
          const json = JSON.parse(text);
          if (typeof json.retry_after === 'number') {
            waitMs = Math.max(500, Math.round(json.retry_after * 1000) + 250);
          }
        } catch (_) { /* keep default */ }
        process.stdout.write(`  [cooldown] ${endpoint} → wait ${waitMs}ms\n`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${method} ${endpoint} → ${res.status}: ${text}`);
      }

      return await res.json();
    } catch (err) {
      const isNetworkError = err.cause?.code === 'ECONNRESET' ||
        err.cause?.code === 'ECONNREFUSED' ||
        err.cause?.code === 'ETIMEDOUT' ||
        err.cause?.code === 'UND_ERR_SOCKET' ||
        err.message === 'fetch failed';

      if (isNetworkError && netAttempt < retries) {
        netAttempt++;
        const delay = 1000 * netAttempt;
        console.log(`  [net] ${endpoint} attempt ${netAttempt}/${retries} failed (${err.cause?.code || 'fetch failed'}), retry in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

async function getChallenge() {
  return apiRequest('/challenge', 'POST');
}

async function submitMint(challengeId, solutionNonce) {
  return apiRequest('/mint', 'POST', {
    challenge_id: challengeId,
    solution_nonce: solutionNonce,
  });
}

async function getMe() {
  return apiRequest('/me');
}

// ─── Worker Management ──────────────────────────────────────────────────────────

function solveChallenge(noncePrefixHex, difficultyBits, numWorkers) {
  return new Promise((resolve, reject) => {
    const workers = [];
    let resolved = false;
    let exitedCount = 0;

    // Each worker gets 1 trillion nonces - more than enough for any difficulty
    const rangePerWorker = BigInt('1000000000000');

    for (let i = 0; i < numWorkers; i++) {
      const startNonce = (rangePerWorker * BigInt(i)).toString();
      const endNonce = (rangePerWorker * BigInt(i + 1)).toString();

      const worker = new Worker(WORKER_PATH, {
        workerData: {
          noncePrefixHex,
          difficultyBits,
          startNonce,
          endNonce,
        },
      });

      worker.on('message', (msg) => {
        if (resolved) return;
        if (msg.found) {
          resolved = true;
          // Terminate all workers immediately
          for (const w of workers) {
            try { w.terminate(); } catch {}
          }
          resolve({ nonce: msg.nonce, hashCount: msg.hashCount, workerId: i });
        }
      });

      worker.on('error', (err) => {
        if (!resolved) {
          console.error(`  Worker ${i} error:`, err.message);
        }
      });

      worker.on('exit', () => {
        exitedCount++;
        if (!resolved && exitedCount === numWorkers) {
          reject(new Error('All workers exhausted nonce range without solution'));
        }
      });

      workers.push(worker);
    }
  });
}

// ─── Main Loop with Pipeline Overlap ────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}m`;
}

function formatHashrate(hps) {
  if (hps >= 1e9) return `${(hps / 1e9).toFixed(2)} GH/s`;
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(2)} MH/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(2)} KH/s`;
  return `${hps.toFixed(0)} H/s`;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  RPOW2 Multi-Thread Miner v2 (Phase 1 Optimized)');
  console.log(`  Workers: ${config.NUM_WORKERS} threads`);
  console.log(`  API: ${config.API_BASE}`);
  console.log(`  Optimizations: zero-BigInt loop, crypto.hash(), pipeline`);
  console.log('═══════════════════════════════════════════════════');
  console.log();

  // Check Node version for crypto.hash support
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 22) {
    console.log(`  ✓ Node ${process.versions.node} - using crypto.hash() (fast path)`);
  } else if (major >= 21) {
    console.log(`  ✓ Node ${process.versions.node} - crypto.hash() may be available`);
  } else {
    console.log(`  ⚠ Node ${process.versions.node} - using crypto.createHash() (upgrade to 22+ for 2x speed)`);
  }
  console.log();

  // Verify session
  try {
    const me = await getMe();
    console.log(`✓ Logged in as: ${me.email || me.address || JSON.stringify(me)}`);
    if (me.balance !== undefined) console.log(`  Balance: ${me.balance} RPOW`);
    console.log();
  } catch (err) {
    console.error('✗ Session invalid or expired. Update SESSION_COOKIE in config.js');
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }

  let totalMinted = 0;
  let totalHashes = 0;
  let retries = 0;
  const startTime = Date.now();

  // Pipeline: pre-fetch first challenge (with .catch to prevent unhandled rejection)
  let pendingChallenge = getChallenge().catch(e => ({ _error: e }));

  while (true) {
    try {
      // 1. Await current challenge (already pre-fetched)
      const challenge = await pendingChallenge;

      // Handle pre-fetch failure gracefully
      if (challenge._error) {
        throw challenge._error;
      }

      const { challenge_id, nonce_prefix, difficulty_bits, expires_at } = challenge;

      console.log(`[Challenge] id=${challenge_id.slice(0, 8)}... difficulty=${difficulty_bits} expires=${new Date(expires_at).toLocaleTimeString()}`);

      // 2. Solve with all workers
      const solveStart = Date.now();
      const result = await solveChallenge(nonce_prefix, difficulty_bits, config.NUM_WORKERS);
      const solveTime = Date.now() - solveStart;

      // Estimate total hashes (worker reports its own count, multiply by workers for approx)
      const estimatedHashes = result.hashCount * config.NUM_WORKERS;
      totalHashes += estimatedHashes;
      const hashrate = estimatedHashes / (solveTime / 1000);

      console.log(`[Solved] nonce=${result.nonce} worker=${result.workerId} time=${formatDuration(solveTime)} rate=${formatHashrate(hashrate)}`);

      // 3. Submit mint AND pre-fetch next challenge in parallel (pipeline overlap)
      const mintResult = await submitMint(challenge_id, result.nonce);

      // Pre-fetch next challenge (non-blocking, errors caught)
      if (config.LOOP_DELAY_MS > 0) await sleep(config.LOOP_DELAY_MS);
      pendingChallenge = getChallenge().catch(e => ({ _error: e }));

      totalMinted++;
      retries = 0;

      const elapsed = Date.now() - startTime;
      const rate = totalMinted / (elapsed / 3600000);
      const avgHashrate = totalHashes / (elapsed / 1000);

      console.log(`[Minted] ✓ #${totalMinted} | ${rate.toFixed(1)} tok/hr | avg ${formatHashrate(avgHashrate)} | elapsed ${formatDuration(elapsed)}`);
      console.log();

    } catch (err) {
      retries++;
      console.error(`[Error] ${err.message}`);

      if (retries >= config.MAX_RETRIES) {
        console.error(`Max retries (${config.MAX_RETRIES}) reached. Exiting.`);
        process.exit(1);
      }

      console.log(`  Retrying in ${config.RETRY_DELAY_MS}ms... (${retries}/${config.MAX_RETRIES})`);
      await sleep(config.RETRY_DELAY_MS);
      // Re-fetch challenge on retry (with error catch)
      pendingChallenge = getChallenge().catch(e => ({ _error: e }));
    }
  }
}

// ─── Auto-Restart Wrapper ───────────────────────────────────────────────────────

const MAX_CRASHES = 50;       // max restarts before giving up
const RESTART_DELAY_MS = 5000; // 5s between restarts
const CRASH_WINDOW_MS = 60000; // reset crash counter if stable for 1 min

async function runWithRestart() {
  let crashes = 0;
  let lastCrashTime = 0;

  while (crashes < MAX_CRASHES) {
    try {
      await main();
      // main() only exits on MAX_RETRIES, treat as crash
      break;
    } catch (err) {
      const now = Date.now();

      // Reset crash counter if we've been stable for a while
      if (now - lastCrashTime > CRASH_WINDOW_MS) {
        crashes = 0;
      }

      crashes++;
      lastCrashTime = now;

      console.error(`\n[CRASH #${crashes}/${MAX_CRASHES}] ${err.message}`);
      console.error(`  Restarting in ${RESTART_DELAY_MS / 1000}s...\n`);
      await sleep(RESTART_DELAY_MS);
    }
  }

  if (crashes >= MAX_CRASHES) {
    console.error(`\n[FATAL] ${MAX_CRASHES} crashes within ${CRASH_WINDOW_MS / 1000}s window. Giving up.`);
    process.exit(1);
  }
}

runWithRestart();
