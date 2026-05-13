// Test: Verify trailingZeroBits matches RPOW2 server implementation
const crypto = require('crypto');

/**
 * trailingZeroBits - must match server's apps/server/src/pow.ts
 * Counts trailing zero bits from END of hash byte array
 */
function trailingZeroBits(hash) {
  let count = 0;
  for (let i = hash.length - 1; i >= 0; i--) {
    const byte = hash[i];
    if (byte === 0) {
      count += 8;
    } else {
      for (let bit = 0; bit < 8; bit++) {
        if ((byte >> bit) & 1) break;
        count++;
      }
      break;
    }
  }
  return count;
}

// Test cases
console.log('Testing trailingZeroBits...\n');

// Test 1: Known hash with trailing zeros
const buf1 = Buffer.alloc(32, 0xFF);
buf1[31] = 0x00; // last byte = 0 → 8 trailing zero bits
console.assert(trailingZeroBits(buf1) === 8, 'Test 1 failed');
console.log('✓ Test 1: last byte 0x00 → 8 bits');

// Test 2: Last 2 bytes zero
const buf2 = Buffer.alloc(32, 0xFF);
buf2[31] = 0x00;
buf2[30] = 0x00;
console.assert(trailingZeroBits(buf2) === 16, 'Test 2 failed');
console.log('✓ Test 2: last 2 bytes 0x00 → 16 bits');

// Test 3: Last byte = 0b11110000 (4 trailing zeros in LSB)
const buf3 = Buffer.alloc(32, 0xFF);
buf3[31] = 0xF0; // binary: 11110000 → 4 trailing zeros
console.assert(trailingZeroBits(buf3) === 4, 'Test 3 failed');
console.log('✓ Test 3: last byte 0xF0 → 4 bits');

// Test 4: Last byte = 0b00001000 (3 trailing zeros)
const buf4 = Buffer.alloc(32, 0xFF);
buf4[31] = 0x08; // binary: 00001000 → 3 trailing zeros
console.assert(trailingZeroBits(buf4) === 3, 'Test 4 failed');
console.log('✓ Test 4: last byte 0x08 → 3 bits');

// Test 5: No trailing zeros
const buf5 = Buffer.alloc(32, 0xFF);
buf5[31] = 0x01; // binary: 00000001 → 0 trailing zeros
console.assert(trailingZeroBits(buf5) === 0, 'Test 5 failed');
console.log('✓ Test 5: last byte 0x01 → 0 bits');

// Test 6: All zeros = 256 trailing zero bits
const buf6 = Buffer.alloc(32, 0x00);
console.assert(trailingZeroBits(buf6) === 256, 'Test 6 failed');
console.log('✓ Test 6: all zeros → 256 bits');

// Test 7: Simulate actual mining
console.log('\nSimulating mining with difficulty 20...\n');

const noncePrefix = crypto.randomBytes(16);
let nonce = BigInt(0);
const inputBuf = Buffer.alloc(noncePrefix.length + 8);
noncePrefix.copy(inputBuf, 0);

const start = Date.now();
let found = false;

while (!found) {
  inputBuf.writeBigUInt64LE(nonce, noncePrefix.length);
  const hash = crypto.createHash('sha256').update(inputBuf).digest();

  if (trailingZeroBits(hash) >= 20) {
    const elapsed = Date.now() - start;
    console.log(`✓ Found solution!`);
    console.log(`  Nonce: ${nonce}`);
    console.log(`  Hash: ${hash.toString('hex')}`);
    console.log(`  Trailing zero bits: ${trailingZeroBits(hash)}`);
    console.log(`  Hashes tried: ${nonce.toString()}`);
    console.log(`  Time: ${elapsed}ms`);
    console.log(`  Rate: ${(Number(nonce) / (elapsed / 1000)).toFixed(0)} H/s per core`);
    found = true;
  }
  nonce++;
}

console.log('\n✓ All tests passed!');
