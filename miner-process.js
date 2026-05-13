// RPOW2 Single-Account Miner Process
// Spawned by multi.js - communicates stats via IPC (process.send)
// Each instance runs independently with its own worker pool
//
// T40 fork changes:
//   - apiRequest now respects 429 `retry_after` (server cooldown) automatically
//   - 429 backoff does NOT count toward MAX_RETRIES (only real errors do)

const { Worker } = require('worker_threads');
const path = require('path');

const WORKER_PATH = path.join(__dirname, 'worker.js');

// Receive config from parent via env
const SESSION_COOKIE = process.env.MINER_COOKIE;
const ACCOUNT_NAME = process.env.MINER_NAME || 'unknown';
const NUM_WORKERS = parseInt(process.env.MINER_WORKERS || '50', 10);
const API_BASE = process.env.MINER_API_BASE || 'https://api.rpow2.com';
const LOOP_DELAY_MS = parseInt(process.env.MINER_DELAY || '100', 10);
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

if (!SESSION_COOKIE || SESSION_COOKIE === 'PASTE_SESSION_COOKIE_HERE') {
  sendStatus('error', 'No session cookie configured');
  process.exit(1);
}

// ─── IPC Communication ──────────────────────────────────────────────────────────

function sendStatus(status, message = '') {
  if (process.send) {
    process.send({ type: 'status', account: ACCOUNT_NAME, status, message });
  }
}

function sendStats(stats) {
  if (process.send) {
    process.send({ type: 'stats', account: ACCOUNT_NAME, ...stats });
  }
}

// ─── API Helpers ────────────────────────────────────────────────────────────────

async function apiRequest(endpoint, method = 'GET', body = null, retries = 3) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Cookie': `rpow_session=${SESSION_COOKIE}`,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
  };

  const opts = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  // 429 cooldown retries are unlimited and do NOT count toward `retries`.
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
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${method} ${endpoint} → ${res.status}: ${text}`);
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
        await new Promise(r => setTimeout(r, 1000 * netAttempt));
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

function solveChallenge(noncePrefixHex, difficultyBits) {
  return new Promise((resolve, reject) => {
    const workers = [];
    let resolved = false;
    let exitedCount = 0;

    const rangePerWorker = BigInt('1000000000000');

    for (let i = 0; i < NUM_WORKERS; i++) {
      const startNonce = (rangePerWorker * BigInt(i)).toString();
      const endNonce = (rangePerWorker * BigInt(i + 1)).toString();

      const worker = new Worker(WORKER_PATH, {
        workerData: { noncePrefixHex, difficultyBits, startNonce, endNonce },
      });

      worker.on('message', (msg) => {
        if (resolved) return;
        if (msg.found) {
          resolved = true;
          for (const w of workers) {
            try { w.terminate(); } catch {}
          }
          resolve({ nonce: msg.nonce, hashCount: msg.hashCount, workerId: i });
        }
      });

      worker.on('error', (err) => {
        if (!resolved) sendStatus('worker_error', err.message);
      });

      worker.on('exit', () => {
        exitedCount++;
        if (!resolved && exitedCount === NUM_WORKERS) {
          reject(new Error('All workers exhausted nonce range'));
        }
      });

      workers.push(worker);
    }
  });
}

// ─── Main Loop ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // Verify session
  let email = '?';
  let balance = 0;
  try {
    const me = await getMe();
    email = me.email || me.address || '?';
    balance = me.balance || 0;
    sendStats({ email, balance, minted: 0, hashrate: 0, lastSolveTime: 0, status: 'ready' });
  } catch (err) {
    sendStatus('error', `Session invalid: ${err.message}`);
    process.exit(1);
  }

  let totalMinted = 0;
  let totalHashes = 0;
  let retries = 0;
  const startTime = Date.now();

  let pendingChallenge = getChallenge().catch(e => ({ _error: e }));

  while (true) {
    try {
      sendStats({ email, balance, minted: totalMinted, hashrate: 0, lastSolveTime: 0, status: 'fetching' });

      const challenge = await pendingChallenge;
      if (challenge._error) throw challenge._error;

      const { challenge_id, nonce_prefix, difficulty_bits, expires_at } = challenge;

      sendStats({ email, balance, minted: totalMinted, difficulty: difficulty_bits, status: 'mining' });

      const solveStart = Date.now();
      const result = await solveChallenge(nonce_prefix, difficulty_bits);
      const solveTime = Date.now() - solveStart;

      const estimatedHashes = result.hashCount * NUM_WORKERS;
      totalHashes += estimatedHashes;
      const hashrate = estimatedHashes / (solveTime / 1000);

      sendStats({ email, balance, minted: totalMinted, hashrate, lastSolveTime: solveTime, difficulty: difficulty_bits, status: 'submitting' });

      // Submit mint
      const mintResult = await submitMint(challenge_id, result.nonce);

      // Pre-fetch next challenge (non-blocking, errors caught)
      if (LOOP_DELAY_MS > 0) await sleep(LOOP_DELAY_MS);
      pendingChallenge = getChallenge().catch(e => ({ _error: e }));

      totalMinted++;
      balance = mintResult.balance || balance + 1;
      retries = 0;

      const elapsed = Date.now() - startTime;
      const tokPerHr = totalMinted / (elapsed / 3600000);

      sendStats({
        email,
        balance,
        minted: totalMinted,
        hashrate,
        lastSolveTime: solveTime,
        tokPerHr,
        difficulty: difficulty_bits,
        status: 'mining',
        elapsed,
      });

    } catch (err) {
      retries++;
      sendStats({ email, balance, minted: totalMinted, status: 'error', error: err.message });

      if (retries >= MAX_RETRIES) {
        sendStatus('fatal', `Max retries reached: ${err.message}`);
        process.exit(1);
      }

      await sleep(RETRY_DELAY_MS);
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

      sendStatus('restarting', `Crash #${crashes}: ${err.message}`);
      await sleep(RESTART_DELAY_MS);
    }
  }

  if (crashes >= MAX_CRASHES) {
    sendStatus('fatal', `${MAX_CRASHES} crashes in rapid succession`);
    process.exit(1);
  }
}

runWithRestart();
