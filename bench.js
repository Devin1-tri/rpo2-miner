// Benchmark: Compare old vs new worker performance
const crypto = require('crypto');

const HAS_CRYPTO_HASH = typeof crypto.hash === 'function';
console.log(`Node ${process.versions.node} | crypto.hash: ${HAS_CRYPTO_HASH ? 'YES' : 'NO'}`);

const noncePrefix = Buffer.from('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', 'hex'); // 16 bytes
const inputBuf = Buffer.alloc(noncePrefix.length + 8);
noncePrefix.copy(inputBuf, 0);
const NONCE_OFFSET = noncePrefix.length;

// Trailing zeros table
const TZ_TABLE = new Uint8Array(256);
TZ_TABLE[0] = 8;
for (let i = 1; i < 256; i++) {
  let tz = 0, v = i;
  while ((v & 1) === 0) { tz++; v >>= 1; }
  TZ_TABLE[i] = tz;
}

// ─── Old method: BigInt + createHash ────────────────────────────────────────────
function benchOld(iterations) {
  let nonce = 0n;
  let found = 0;
  const start = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    inputBuf.writeBigUInt64LE(nonce, NONCE_OFFSET);
    const hash = crypto.createHash('sha256').update(inputBuf).digest();
    // Check last byte (simulate trailing zero check)
    if (hash[31] === 0) found++;
    nonce++;
  }

  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  return { elapsed, rate: iterations / (elapsed / 1000), found };
}

// ─── New method: Manual increment + crypto.hash (or createHash fallback) ────────
function benchNew(iterations) {
  // Reset nonce bytes
  inputBuf.writeUInt32LE(0, NONCE_OFFSET);
  inputBuf.writeUInt32LE(0, NONCE_OFFSET + 4);

  let found = 0;
  const start = process.hrtime.bigint();

  if (HAS_CRYPTO_HASH) {
    for (let i = 0; i < iterations; i++) {
      const hash = crypto.hash('sha256', inputBuf, 'buffer');
      if (hash[31] === 0) found++;
      // Manual LE increment
      let lo = inputBuf.readUInt32LE(NONCE_OFFSET);
      lo = (lo + 1) >>> 0;
      inputBuf.writeUInt32LE(lo, NONCE_OFFSET);
      if (lo === 0) {
        let hi = inputBuf.readUInt32LE(NONCE_OFFSET + 4);
        inputBuf.writeUInt32LE((hi + 1) >>> 0, NONCE_OFFSET + 4);
      }
    }
  } else {
    for (let i = 0; i < iterations; i++) {
      const hash = crypto.createHash('sha256').update(inputBuf).digest();
      if (hash[31] === 0) found++;
      // Manual LE increment
      let lo = inputBuf.readUInt32LE(NONCE_OFFSET);
      lo = (lo + 1) >>> 0;
      inputBuf.writeUInt32LE(lo, NONCE_OFFSET);
      if (lo === 0) {
        let hi = inputBuf.readUInt32LE(NONCE_OFFSET + 4);
        inputBuf.writeUInt32LE((hi + 1) >>> 0, NONCE_OFFSET + 4);
      }
    }
  }

  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  return { elapsed, rate: iterations / (elapsed / 1000), found };
}

// ─── Run benchmarks ─────────────────────────────────────────────────────────────
const ITERS = 2_000_000;

console.log(`\nBenchmarking ${(ITERS / 1e6).toFixed(0)}M hashes...\n`);

// Warmup
benchOld(100_000);
benchNew(100_000);

// Real run
const oldResult = benchOld(ITERS);
console.log(`OLD (BigInt + createHash): ${(oldResult.rate / 1e6).toFixed(3)} MH/s (${oldResult.elapsed.toFixed(0)}ms)`);

const newResult = benchNew(ITERS);
console.log(`NEW (manual incr + ${HAS_CRYPTO_HASH ? 'crypto.hash' : 'createHash'}): ${(newResult.rate / 1e6).toFixed(3)} MH/s (${newResult.elapsed.toFixed(0)}ms)`);

const speedup = newResult.rate / oldResult.rate;
console.log(`\nSpeedup: ${speedup.toFixed(2)}x`);
console.log(`Projected 56-core total: ${((newResult.rate * 56) / 1e6).toFixed(1)} MH/s`);

// Estimate solve time at difficulty 25
const d25 = Math.pow(2, 25);
const solveTime25 = d25 / (newResult.rate * 56);
console.log(`Est. solve time (diff=25, 56 cores): ${solveTime25.toFixed(3)}s`);

const d28 = Math.pow(2, 28);
const solveTime28 = d28 / (newResult.rate * 56);
console.log(`Est. solve time (diff=28, 56 cores): ${solveTime28.toFixed(3)}s`);
