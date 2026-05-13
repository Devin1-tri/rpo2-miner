// RPOW2 Rust-Powered Miner - Single Account
// Uses native Rust binary for SHA-256 solving (5-10x faster than Node.js workers)
// Pipeline overlap: pre-fetch next challenge while submitting current
//
// T40 fork changes:
//   - apiRequest now respects 429 `retry_after` (server cooldown) automatically
//   - 429 backoff does NOT count toward MAX_RETRIES (only real errors do)
//   - Default LOOP_DELAY_MS bumped to 5500ms so we proactively avoid 429

const { execFile } = require('child_process');
const path = require('path');
const config = require('./config');

// Path to compiled Rust solver binary
const SOLVER_BIN = process.env.RPOW_SOLVER_BIN ||
  path.join(__dirname, 'solver', 'target', 'release', 'rpow2-solver');

const NUM_THREADS = parseInt(process.env.RPOW_THREADS || config.NUM_WORKERS || '56', 10);

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
        let waitMs = 5500; // safe default
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

// ─── Rust Solver ────────────────────────────────────────────────────────────────

function solveWithRust(noncePrefixHex, difficultyBits) {
  return new Promise((resolve, reject) => {
    const args = [noncePrefixHex, String(difficultyBits), String(NUM_THREADS)];

    const proc = execFile(SOLVER_BIN, args, {
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: 300_000, // 5 min max (should never hit this)
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Solver failed: ${error.message}\nstderr: ${stderr}`));
        return;
      }

      const solutionNonce = stdout.trim();
      if (!solutionNonce || !/^\d+$/.test(solutionNonce)) {
        reject(new Error(`Invalid solver output: "${stdout.trim()}"\nstderr: ${stderr}`));
        return;
      }

      // Parse stats from stderr
      let hashrate = 0;
      const rateMatch = stderr.match(/rate=([\d.]+)\s*MH\/s/);
      if (rateMatch) hashrate = parseFloat(rateMatch[1]) * 1_000_000;

      let hashCount = 0;
      const hashMatch = stderr.match(/hashes=(\d+)/);
      if (hashMatch) hashCount = parseInt(hashMatch[1], 10);

      resolve({ nonce: solutionNonce, hashrate, hashCount });
    });
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
  console.log('  RPOW2 Rust-Powered Miner v3');
  console.log(`  Solver: ${SOLVER_BIN}`);
  console.log(`  Threads: ${NUM_THREADS}`);
  console.log(`  API: ${config.API_BASE}`);
  console.log(`  Engine: Native Rust + Rayon + SHA-NI/AVX-512`);
  console.log('═══════════════════════════════════════════════════');
  console.log();

  // Verify solver binary exists
  try {
    const { accessSync } = require('fs');
    accessSync(SOLVER_BIN);
    console.log(`  ✓ Solver binary found`);
  } catch {
    console.error(`  ✗ Solver binary not found at: ${SOLVER_BIN}`);
    console.error(`  Run: cd solver && cargo build --release`);
    process.exit(1);
  }

  // Verify session
  try {
    const me = await getMe();
    console.log(`  ✓ Logged in as: ${me.email || me.address || JSON.stringify(me)}`);
    if (me.balance !== undefined) console.log(`  Balance: ${me.balance} RPOW`);
    console.log();
  } catch (err) {
    console.error('  ✗ Session invalid or expired. Update SESSION_COOKIE in config.js');
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }

  let totalMinted = 0;
  let totalHashes = 0;
  let retries = 0;
  const startTime = Date.now();

  // Pipeline: pre-fetch first challenge
  let pendingChallenge = getChallenge().catch(e => ({ _error: e }));

  while (true) {
    try {
      const challenge = await pendingChallenge;
      if (challenge._error) throw challenge._error;

      const { challenge_id, nonce_prefix, difficulty_bits } = challenge;

      console.log(`[Challenge] id=${challenge_id.slice(0, 8)}... difficulty=${difficulty_bits} prefix=${nonce_prefix.slice(0, 16)}...`);

      // Solve with Rust binary
      const solveStart = Date.now();
      const result = await solveWithRust(nonce_prefix, difficulty_bits);
      const solveTime = Date.now() - solveStart;

      totalHashes += result.hashCount;

      console.log(`[Solved] nonce=${result.nonce} time=${formatDuration(solveTime)} rate=${formatHashrate(result.hashrate)}`);

      // Submit mint AND pre-fetch next challenge in parallel
      const mintResult = await submitMint(challenge_id, result.nonce);

      if (config.LOOP_DELAY_MS > 0) await sleep(config.LOOP_DELAY_MS);
      pendingChallenge = getChallenge().catch(e => ({ _error: e }));

      totalMinted++;
      retries = 0;

      const elapsed = Date.now() - startTime;
      const rate = totalMinted / (elapsed / 3600000);

      console.log(`[Minted] ✓ #${totalMinted} | ${rate.toFixed(1)} tok/hr | elapsed ${formatDuration(elapsed)}`);
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
      pendingChallenge = getChallenge().catch(e => ({ _error: e }));
    }
  }
}

// ─── Auto-Restart Wrapper ───────────────────────────────────────────────────────

const MAX_CRASHES = 50;
const RESTART_DELAY_MS = 5000;
const CRASH_WINDOW_MS = 60000;

async function runWithRestart() {
  let crashes = 0;
  let lastCrashTime = 0;

  while (crashes < MAX_CRASHES) {
    try {
      await main();
      break;
    } catch (err) {
      const now = Date.now();
      if (now - lastCrashTime > CRASH_WINDOW_MS) crashes = 0;
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
