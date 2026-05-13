// RPOW2 SHA-256 Brute-Force Worker - Phase 1 Optimized
// Eliminates BigInt from hot loop, uses manual LE increment on Buffer
// Uses crypto.hash() (Node 21.7+) when available for zero-alloc hashing

const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');

const { noncePrefixHex, difficultyBits, startNonce, endNonce } = workerData;

// Convert hex nonce_prefix to Buffer
const noncePrefix = Buffer.from(noncePrefixHex, 'hex');

// Detect crypto.hash availability (Node 21.7+ / 22+)
const HAS_CRYPTO_HASH = typeof crypto.hash === 'function';

// Pre-allocate input buffer: noncePrefix + 8 bytes for nonce (LE64)
const inputBuf = Buffer.alloc(noncePrefix.length + 8);
noncePrefix.copy(inputBuf, 0);
const NONCE_OFFSET = noncePrefix.length;

// Pre-allocate output buffer for crypto.hash (reusable)
const hashOutBuf = Buffer.alloc(32);

// Initialize nonce bytes from startNonce (as BigInt → write once, then manual increment)
const startBig = BigInt(startNonce);
inputBuf.writeBigUInt64LE(startBig, NONCE_OFFSET);

// End nonce for range check (compare as two 32-bit LE values for speed)
const endBig = BigInt(endNonce);
const endLo = Number(endBig & 0xFFFFFFFFn);
const endHi = Number((endBig >> 32n) & 0xFFFFFFFFn);

/**
 * Inline manual LE64 increment on buffer at NONCE_OFFSET.
 * Avoids BigInt entirely in the hot loop.
 * Returns false if we've overflowed past endNonce.
 */
function incrementNonce() {
  // Increment as two 32-bit LE integers
  let lo = inputBuf.readUInt32LE(NONCE_OFFSET);
  lo = (lo + 1) >>> 0; // unsigned 32-bit add
  inputBuf.writeUInt32LE(lo, NONCE_OFFSET);
  if (lo !== 0) return true; // no carry

  // Carry to high 32 bits
  let hi = inputBuf.readUInt32LE(NONCE_OFFSET + 4);
  hi = (hi + 1) >>> 0;
  inputBuf.writeUInt32LE(hi, NONCE_OFFSET + 4);

  // Check if past end
  if (hi > endHi || (hi === endHi && lo >= endLo)) return false;
  return true;
}

/**
 * Check trailing zero bits - optimized with early exit.
 * Checks last byte first (most likely to fail), exits immediately.
 */
function checkTrailingZeroBits(hash, required) {
  let count = 0;
  for (let i = 31; i >= 0; i--) {
    const byte = hash[i];
    if (byte === 0) {
      count += 8;
      if (count >= required) return true;
    } else {
      // Count trailing zeros in this byte using lookup
      // (byte & -byte) isolates lowest set bit
      const tz = TRAILING_ZEROS_TABLE[byte];
      count += tz;
      return count >= required;
    }
  }
  return count >= required;
}

// Precomputed trailing zeros for each byte value (0-255)
const TRAILING_ZEROS_TABLE = new Uint8Array(256);
TRAILING_ZEROS_TABLE[0] = 8;
for (let i = 1; i < 256; i++) {
  let tz = 0;
  let v = i;
  while ((v & 1) === 0) { tz++; v >>= 1; }
  TRAILING_ZEROS_TABLE[i] = tz;
}

/**
 * Read current nonce from buffer as decimal string (for reporting solution)
 */
function readNonceAsString() {
  const big = inputBuf.readBigUInt64LE(NONCE_OFFSET);
  return big.toString();
}

// ─── Mining Loop ────────────────────────────────────────────────────────────────

let hashCount = 0;
const REPORT_INTERVAL = 2_000_000; // report progress every 2M hashes

if (HAS_CRYPTO_HASH) {
  // Fast path: crypto.hash() - no object allocation per hash
  while (true) {
    const hash = crypto.hash('sha256', inputBuf, 'buffer');

    if (checkTrailingZeroBits(hash, difficultyBits)) {
      parentPort.postMessage({
        found: true,
        nonce: readNonceAsString(),
        hashCount,
      });
      process.exit(0);
    }

    hashCount++;
    if (!incrementNonce()) break;

    // Periodic progress (allows parent terminate to take effect)
    if (hashCount % REPORT_INTERVAL === 0) {
      // Yield to event loop briefly every 2M hashes for terminate signal
    }
  }
} else {
  // Fallback: crypto.createHash() - Node < 21.7
  while (true) {
    const hash = crypto.createHash('sha256').update(inputBuf).digest();

    if (checkTrailingZeroBits(hash, difficultyBits)) {
      parentPort.postMessage({
        found: true,
        nonce: readNonceAsString(),
        hashCount,
      });
      process.exit(0);
    }

    hashCount++;
    if (!incrementNonce()) break;
  }
}

// Exhausted range without finding solution
parentPort.postMessage({ found: false, hashCount });
