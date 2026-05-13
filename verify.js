// Verify our miner's nonce encoding matches the server's verifySolution exactly
const crypto = require('crypto');

// Server's verifySolution logic (from pow.ts):
function serverVerify(noncePrefix, solutionNonce, difficultyBits) {
  const nonceBuf = Buffer.alloc(8);
  let x = solutionNonce; // BigInt
  for (let i = 0; i < 8; i++) { nonceBuf[i] = Number(x & 0xffn); x >>= 8n; }
  const h = crypto.createHash('sha256').update(noncePrefix).update(nonceBuf).digest();
  return { hash: h, trailing: serverTrailingZeroBits(h) };
}

// Server's trailingZeroBits (from difficulty.ts):
function serverTrailingZeroBits(buf) {
  let count = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    const b = buf[i];
    if (b === 0) { count += 8; continue; }
    let bit = 0;
    while ((b & (1 << bit)) === 0) bit++;
    return count + bit;
  }
  return count;
}

// Our miner's logic:
function ourMinerHash(noncePrefixHex, nonceDecimalString) {
  const noncePrefix = Buffer.from(noncePrefixHex, 'hex');
  const inputBuf = Buffer.alloc(noncePrefix.length + 8);
  noncePrefix.copy(inputBuf, 0);
  inputBuf.writeBigUInt64LE(BigInt(nonceDecimalString), noncePrefix.length);
  const h = crypto.createHash('sha256').update(inputBuf).digest();
  return { hash: h, trailing: ourTrailingZeroBits(h) };
}

// Our trailingZeroBits with lookup table:
const TZ_TABLE = new Uint8Array(256);
TZ_TABLE[0] = 8;
for (let i = 1; i < 256; i++) {
  let tz = 0, v = i;
  while ((v & 1) === 0) { tz++; v >>= 1; }
  TZ_TABLE[i] = tz;
}

function ourTrailingZeroBits(hash) {
  let count = 0;
  for (let i = 31; i >= 0; i--) {
    const byte = hash[i];
    if (byte === 0) { count += 8; continue; }
    return count + TZ_TABLE[byte];
  }
  return count;
}

// ─── Test Cases ─────────────────────────────────────────────────────────────────

console.log('=== Verifying nonce encoding matches server ===\n');

const testPrefix = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 16 bytes hex
const prefixBuf = Buffer.from(testPrefix, 'hex');

const testNonces = [0n, 1n, 255n, 256n, 65535n, 1000000n, 4294967295n, 4294967296n, 18446744073709551615n];

let allPass = true;
for (const nonce of testNonces) {
  const server = serverVerify(prefixBuf, nonce, 0);
  const ours = ourMinerHash(testPrefix, nonce.toString());

  const hashMatch = server.hash.equals(ours.hash);
  const trailingMatch = server.trailing === ours.trailing;
  const pass = hashMatch && trailingMatch;
  if (!pass) allPass = false;

  console.log(`nonce=${nonce.toString().padStart(20)} hash_match=${hashMatch} trailing=${server.trailing}/${ours.trailing} ${pass ? '✓' : '✗ MISMATCH!'}`);
}

// Test with manual increment (simulating our worker's incrementNonce)
console.log('\n=== Verifying manual increment produces same bytes as writeBigUInt64LE ===\n');

const buf1 = Buffer.alloc(8);
const buf2 = Buffer.alloc(8);

// Test: increment from 4294967294 (0xFFFFFFFE) to 4294967296 (carry to high word)
for (let start = 4294967294n; start <= 4294967298n; start++) {
  // Method 1: writeBigUInt64LE
  buf1.writeBigUInt64LE(start, 0);

  // Method 2: manual increment from start
  buf2.writeUInt32LE(Number(start & 0xFFFFFFFFn), 0);
  buf2.writeUInt32LE(Number((start >> 32n) & 0xFFFFFFFFn), 4);

  const match = buf1.equals(buf2);
  if (!match) allPass = false;
  console.log(`nonce=${start} buf1=${buf1.toString('hex')} buf2=${buf2.toString('hex')} ${match ? '✓' : '✗ MISMATCH!'}`);
}

// Test manual increment logic
console.log('\n=== Verifying incrementNonce carry logic ===\n');
const testBuf = Buffer.alloc(8);
testBuf.writeUInt32LE(0xFFFFFFFE, 0); // lo = max-1
testBuf.writeUInt32LE(0, 4);           // hi = 0

for (let i = 0; i < 4; i++) {
  const before = testBuf.readBigUInt64LE(0);
  // Simulate incrementNonce
  let lo = testBuf.readUInt32LE(0);
  lo = (lo + 1) >>> 0;
  testBuf.writeUInt32LE(lo, 0);
  if (lo === 0) {
    let hi = testBuf.readUInt32LE(4);
    hi = (hi + 1) >>> 0;
    testBuf.writeUInt32LE(hi, 4);
  }
  const after = testBuf.readBigUInt64LE(0);
  const expected = before + 1n;
  const pass = after === expected;
  if (!pass) allPass = false;
  console.log(`${before} → ${after} (expected ${expected}) ${pass ? '✓' : '✗ MISMATCH!'}`);
}

// Test solution_nonce format matches regex /^\d{1,20}$/
console.log('\n=== Verifying solution_nonce format ===\n');
const maxU64 = '18446744073709551615'; // 20 digits
console.log(`Max u64 string: "${maxU64}" length=${maxU64.length} matches /^\\d{1,20}$/: ${/^\d{1,20}$/.test(maxU64) ? '✓' : '✗'}`);
console.log(`Zero: "0" matches: ${/^\d{1,20}$/.test('0') ? '✓' : '✗'}`);
console.log(`Typical nonce: "123456789" matches: ${/^\d{1,20}$/.test('123456789') ? '✓' : '✗'}`);

console.log(`\n${'═'.repeat(50)}`);
console.log(allPass ? '✓ ALL TESTS PASSED - Miner matches server exactly' : '✗ SOME TESTS FAILED - CHECK ABOVE');
console.log('═'.repeat(50));
