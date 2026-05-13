// RPOW2 Multi-Account Miner Dashboard (Rust-Powered)
// Spawns independent child processes per account, each using native Rust solver
// Renders a live-updating table showing all accounts' status

const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── Load Accounts ──────────────────────────────────────────────────────────────

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
if (!fs.existsSync(ACCOUNTS_FILE)) {
  console.error('✗ accounts.json not found. Create it with your account cookies.');
  console.error('  Format: [{"name": "acc-1", "cookie": "your_session_cookie"}, ...]');
  process.exit(1);
}

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
if (!accounts.length) {
  console.error('✗ accounts.json is empty.');
  process.exit(1);
}

// Config
// For Rust solver, threads per account = total cores / num accounts (auto-balanced)
const TOTAL_THREADS = parseInt(process.env.RPOW_TOTAL_THREADS || '56', 10);
const THREADS_PER_ACCOUNT = Math.max(1, Math.floor(TOTAL_THREADS / accounts.length));
const API_BASE = process.env.RPOW_API_BASE || 'https://api.rpow2.com';
const LOOP_DELAY_MS = process.env.RPOW_DELAY || '100';
const SOLVER_BIN = process.env.RPOW_SOLVER_BIN ||
  path.join(__dirname, 'solver', 'target', 'release', 'rpow2-solver');

// Verify solver binary
if (!fs.existsSync(SOLVER_BIN)) {
  console.error(`✗ Solver binary not found: ${SOLVER_BIN}`);
  console.error('  Build it: cd solver && cargo build --release');
  process.exit(1);
}

// ─── State Tracking ─────────────────────────────────────────────────────────────

const state = {};
for (const acc of accounts) {
  state[acc.name] = {
    email: '...',
    balance: 0,
    minted: 0,
    hashrate: 0,
    lastSolveTime: 0,
    tokPerHr: 0,
    difficulty: 0,
    status: 'starting',
    error: '',
    elapsed: 0,
  };
}

const startTime = Date.now();

// ─── Table Rendering ────────────────────────────────────────────────────────────

function formatHashrate(hps) {
  if (!hps || hps === 0) return '---';
  if (hps >= 1e9) return `${(hps / 1e9).toFixed(1)} GH/s`;
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(1)} MH/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(0)} KH/s`;
  return `${hps.toFixed(0)} H/s`;
}

function formatTime(ms) {
  if (!ms || ms === 0) return '---';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatElapsed(ms) {
  if (!ms) ms = Date.now() - startTime;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function statusIcon(status) {
  switch (status) {
    case 'mining': return '⛏️ ';
    case 'submitting': return '📤';
    case 'fetching': return '📥';
    case 'ready': return '✅';
    case 'error': return '❌';
    case 'starting': return '🔄';
    default: return '  ';
  }
}

function pad(str, len, align = 'left') {
  str = String(str);
  if (str.length >= len) return str.slice(0, len);
  const diff = len - str.length;
  if (align === 'right') return ' '.repeat(diff) + str;
  if (align === 'center') return ' '.repeat(Math.floor(diff / 2)) + str + ' '.repeat(Math.ceil(diff / 2));
  return str + ' '.repeat(diff);
}

function renderTable() {
  const names = Object.keys(state);
  const totalMinted = names.reduce((sum, n) => sum + state[n].minted, 0);
  const totalTokHr = names.reduce((sum, n) => sum + (state[n].tokPerHr || 0), 0);
  const totalHashrate = names.reduce((sum, n) => sum + (state[n].hashrate || 0), 0);
  const elapsed = formatElapsed(Date.now() - startTime);

  // Clear screen and move cursor to top
  process.stdout.write('\x1B[2J\x1B[H');

  // Header
  console.log('╔══════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║           RPOW2 Multi-Account Miner Dashboard (RUST ENGINE)                            ║');
  console.log(`║  Accounts: ${accounts.length} | Threads/acc: ${THREADS_PER_ACCOUNT} | Total: ${TOTAL_THREADS} cores | Uptime: ${pad(elapsed, 8)}                ║`);
  console.log(`║  Total Mined: ${pad(String(totalMinted), 6)} | Rate: ${pad(totalTokHr.toFixed(1) + ' tok/hr', 14)} | Hashrate: ${pad(formatHashrate(totalHashrate), 12)}    ║`);
  console.log('╠══════════════════════════════════════════════════════════════════════════════════════════╣');

  // Table header
  console.log('║ ' + pad('ST', 2) + ' │ ' + pad('Account', 12) + ' │ ' + pad('Email', 22) + ' │ ' + pad('Mined', 5, 'right') + ' │ ' + pad('Bal', 6, 'right') + ' │ ' + pad('Rate', 10, 'right') + ' │ ' + pad('Solve', 6, 'right') + ' │ ' + pad('tok/hr', 7, 'right') + ' ║');
  console.log('╟────┼──────────────┼────────────────────────┼───────┼────────┼────────────┼────────┼─────────╢');

  // Rows
  for (const name of names) {
    const s = state[name];
    const icon = statusIcon(s.status);
    const emailShort = s.email.length > 22 ? s.email.slice(0, 19) + '...' : s.email;
    const row = '║ ' +
      pad(icon, 2) + ' │ ' +
      pad(name, 12) + ' │ ' +
      pad(emailShort, 22) + ' │ ' +
      pad(String(s.minted), 5, 'right') + ' │ ' +
      pad(String(s.balance), 6, 'right') + ' │ ' +
      pad(formatHashrate(s.hashrate), 10, 'right') + ' │ ' +
      pad(formatTime(s.lastSolveTime), 6, 'right') + ' │ ' +
      pad(s.tokPerHr ? s.tokPerHr.toFixed(1) : '---', 7, 'right') + ' ║';
    console.log(row);
  }

  console.log('╚══════════════════════════════════════════════════════════════════════════════════════════╝');

  // Error log
  const errors = names.filter(n => state[n].error);
  if (errors.length > 0) {
    console.log('');
    console.log('Recent errors:');
    for (const n of errors) {
      console.log(`  [${n}] ${state[n].error}`);
    }
  }
}

// ─── Spawn Miner Processes ──────────────────────────────────────────────────────

const processes = [];

for (const acc of accounts) {
  const child = fork(path.join(__dirname, 'miner-process-rust.js'), [], {
    env: {
      ...process.env,
      MINER_COOKIE: acc.cookie,
      MINER_NAME: acc.name,
      MINER_WORKERS: String(THREADS_PER_ACCOUNT),
      MINER_API_BASE: API_BASE,
      MINER_DELAY: LOOP_DELAY_MS,
      RPOW_SOLVER_BIN: SOLVER_BIN,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  child.on('message', (msg) => {
    if (msg.type === 'stats') {
      const s = state[msg.account];
      if (!s) return;
      if (msg.email) s.email = msg.email;
      if (msg.balance !== undefined) s.balance = msg.balance;
      if (msg.mined !== undefined) s.mined = msg.mined;
      if (msg.hashrate !== undefined) s.hashrate = msg.hashrate;
      if (msg.lastSolveTime !== undefined) s.lastSolveTime = msg.lastSolveTime;
      if (msg.tokPerHr !== undefined) s.tokPerHr = msg.tokPerHr;
      if (msg.difficulty !== undefined) s.difficulty = msg.difficulty;
      if (msg.status) s.status = msg.status;
      if (msg.elapsed) s.elapsed = msg.elapsed;
      if (msg.error) s.error = msg.error;
      else s.error = '';
    } else if (msg.type === 'status') {
      const s = state[msg.account];
      if (!s) return;
      s.status = msg.status;
      if (msg.message) s.error = msg.message;
    }
  });

  child.on('exit', (code) => {
    const s = state[acc.name];
    if (s) {
      s.status = 'error';
      s.error = `Process exited (code ${code})`;
    }
  });

  child.stderr.on('data', (data) => {
    const s = state[acc.name];
    if (s) s.error = data.toString().trim().slice(0, 80);
  });

  processes.push({ name: acc.name, child });
}

// ─── Dashboard Refresh Loop ─────────────────────────────────────────────────────

const REFRESH_INTERVAL = 1000;

setInterval(renderTable, REFRESH_INTERVAL);
setTimeout(renderTable, 500);

// ─── Graceful Shutdown ──────────────────────────────────────────────────────────

function shutdown() {
  console.log('\n\nShutting down all miners...');
  for (const p of processes) {
    try { p.child.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    for (const p of processes) {
      try { p.child.kill('SIGKILL'); } catch {}
    }
    process.exit(0);
  }, 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
