// sha256_pow.cu — CUDA SHA-256 PoW solver for RPOW2
// Author: Devin (k.riptobisnis@gmail.com fork)
//
// Algorithm matches the existing CPU Rust solver (solver/src/main.rs) bit-for-bit:
//   - Input: nonce_prefix (raw bytes) || nonce (little-endian u64)
//   - Hash: single-block SHA-256 (so prefix + 8 must be <= 55 bytes)
//   - Difficulty: count trailing zero bits in hash treated as a 256-bit
//     little-endian integer (i.e. start from byte 31, count trailing zeros
//     from LSB within each byte, continue back to byte 0).
//
// Usage:
//   rpow2-cuda <nonce_prefix_hex> <difficulty_bits> [batch_size]
// Output:
//   stdout: <solution_nonce_decimal>
//   stderr: rate=XX.X MH/s hashes=N elapsed=N.NNs
//
// Build:
//   nvcc -O3 -arch=sm_120 sha256_pow.cu -o rpow2-cuda
//   (use sm_120 for RTX 5090 / Blackwell; fall back to compute_90 PTX for older)

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <chrono>
#include <cuda_runtime.h>

#define CHECK(call) do {                                                       \
    cudaError_t _e = (call);                                                   \
    if (_e != cudaSuccess) {                                                   \
        fprintf(stderr, "CUDA error %s:%d: %s\n",                              \
                __FILE__, __LINE__, cudaGetErrorString(_e));                   \
        exit(1);                                                               \
    }                                                                          \
} while (0)

// SHA-256 round constants.
__constant__ uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

#define ROTR32(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define CH(x,y,z)    (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x,y,z)   (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define BIGSIG0(x)   (ROTR32(x,2)  ^ ROTR32(x,13) ^ ROTR32(x,22))
#define BIGSIG1(x)   (ROTR32(x,6)  ^ ROTR32(x,11) ^ ROTR32(x,25))
#define SMSIG0(x)    (ROTR32(x,7)  ^ ROTR32(x,18) ^ ((x) >> 3))
#define SMSIG1(x)    (ROTR32(x,17) ^ ROTR32(x,19) ^ ((x) >> 10))

// Single-block SHA-256 (input must be exactly 64 bytes, already padded).
__device__ __forceinline__ void sha256_block(const uint8_t* __restrict__ block,
                                             uint8_t* __restrict__ digest_out) {
    uint32_t w[64];
    #pragma unroll
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t)block[i*4] << 24)
             | ((uint32_t)block[i*4+1] << 16)
             | ((uint32_t)block[i*4+2] << 8)
             | ((uint32_t)block[i*4+3]);
    }
    #pragma unroll
    for (int i = 16; i < 64; i++) {
        w[i] = SMSIG1(w[i-2]) + w[i-7] + SMSIG0(w[i-15]) + w[i-16];
    }

    uint32_t a = 0x6a09e667;
    uint32_t b = 0xbb67ae85;
    uint32_t c = 0x3c6ef372;
    uint32_t d = 0xa54ff53a;
    uint32_t e = 0x510e527f;
    uint32_t f = 0x9b05688c;
    uint32_t g = 0x1f83d9ab;
    uint32_t h = 0x5be0cd19;

    #pragma unroll
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = h + BIGSIG1(e) + CH(e, f, g) + K[i] + w[i];
        uint32_t t2 = BIGSIG0(a) + MAJ(a, b, c);
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }

    uint32_t H[8] = {
        0x6a09e667 + a, 0xbb67ae85 + b, 0x3c6ef372 + c, 0xa54ff53a + d,
        0x510e527f + e, 0x9b05688c + f, 0x1f83d9ab + g, 0x5be0cd19 + h
    };

    #pragma unroll
    for (int i = 0; i < 8; i++) {
        digest_out[i*4]     = (H[i] >> 24) & 0xff;
        digest_out[i*4 + 1] = (H[i] >> 16) & 0xff;
        digest_out[i*4 + 2] = (H[i] >>  8) & 0xff;
        digest_out[i*4 + 3] =  H[i]        & 0xff;
    }
}

// Count trailing zero bits matching server's LE-integer interpretation.
// Iterate byte 31 → byte 0; within each byte, count zeros from LSB.
__device__ __forceinline__ uint32_t trailing_zero_bits(const uint8_t* hash) {
    uint32_t count = 0;
    #pragma unroll
    for (int i = 31; i >= 0; i--) {
        uint8_t byte = hash[i];
        if (byte == 0) {
            count += 8;
        } else {
            // __ffs returns 1 + index of lowest set bit, or 0 if input is 0.
            count += __ffs((uint32_t)byte) - 1;
            return count;
        }
    }
    return count;
}

#define MAX_PREFIX 32

__global__ void mine_kernel(
    const uint8_t* __restrict__ d_prefix,
    int prefix_len,
    uint64_t base_nonce,
    uint32_t difficulty_bits,
    unsigned long long* __restrict__ d_result_nonce,
    int* __restrict__ d_result_found
) {
    if (*d_result_found) return;

    uint64_t tid = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    uint64_t nonce = base_nonce + tid;

    // Build the padded 64-byte block: prefix || nonce_le || 0x80 || zeros || bit_len_be.
    uint8_t block[64];
    #pragma unroll
    for (int i = 0; i < 64; i++) block[i] = 0;

    // Copy prefix (bounded loop; prefix_len <= MAX_PREFIX).
    for (int i = 0; i < prefix_len; i++) block[i] = d_prefix[i];

    // Nonce as little-endian u64.
    int off = prefix_len;
    block[off + 0] = (uint8_t)(nonce);
    block[off + 1] = (uint8_t)(nonce >>  8);
    block[off + 2] = (uint8_t)(nonce >> 16);
    block[off + 3] = (uint8_t)(nonce >> 24);
    block[off + 4] = (uint8_t)(nonce >> 32);
    block[off + 5] = (uint8_t)(nonce >> 40);
    block[off + 6] = (uint8_t)(nonce >> 48);
    block[off + 7] = (uint8_t)(nonce >> 56);

    int msg_len = prefix_len + 8;
    block[msg_len] = 0x80;

    // Bit length as big-endian u64 at bytes [56..64).
    uint64_t bit_len = (uint64_t)msg_len * 8ULL;
    block[56] = (uint8_t)(bit_len >> 56);
    block[57] = (uint8_t)(bit_len >> 48);
    block[58] = (uint8_t)(bit_len >> 40);
    block[59] = (uint8_t)(bit_len >> 32);
    block[60] = (uint8_t)(bit_len >> 24);
    block[61] = (uint8_t)(bit_len >> 16);
    block[62] = (uint8_t)(bit_len >>  8);
    block[63] = (uint8_t)(bit_len);

    uint8_t hash[32];
    sha256_block(block, hash);

    if (trailing_zero_bits(hash) >= difficulty_bits) {
        // First thread to find writes the result.
        if (atomicExch(d_result_found, 1) == 0) {
            *d_result_nonce = (unsigned long long)nonce;
        }
    }
}

int hex_digit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int main(int argc, char** argv) {
    if (argc < 3) {
        fprintf(stderr,
                "Usage: %s <nonce_prefix_hex> <difficulty_bits> [batch_size]\n"
                "  batch_size: number of nonces per kernel launch (default 16777216 = 16M)\n"
                "Output: <solution_nonce_decimal> on stdout when found\n",
                argv[0]);
        return 1;
    }

    const char* prefix_hex = argv[1];
    int difficulty = atoi(argv[2]);
    size_t batch_size = (argc > 3) ? (size_t)strtoull(argv[3], NULL, 10)
                                    : (1ULL << 24);  // 16M nonces / launch

    if (difficulty < 1 || difficulty > 256) {
        fprintf(stderr, "difficulty_bits out of range (1..256)\n");
        return 1;
    }

    size_t hex_len = strlen(prefix_hex);
    if (hex_len % 2 != 0) {
        fprintf(stderr, "nonce_prefix_hex has odd length\n");
        return 1;
    }
    int prefix_len = (int)(hex_len / 2);
    if (prefix_len > MAX_PREFIX) {
        fprintf(stderr, "prefix too long (max %d bytes)\n", MAX_PREFIX);
        return 1;
    }
    if (prefix_len + 8 > 55) {
        fprintf(stderr, "message too long for single SHA-256 block (max prefix %d bytes)\n", 55 - 8);
        return 1;
    }

    uint8_t prefix[MAX_PREFIX] = {0};
    for (int i = 0; i < prefix_len; i++) {
        int hi = hex_digit(prefix_hex[i*2]);
        int lo = hex_digit(prefix_hex[i*2 + 1]);
        if (hi < 0 || lo < 0) {
            fprintf(stderr, "invalid hex in prefix at offset %d\n", i*2);
            return 1;
        }
        prefix[i] = (uint8_t)((hi << 4) | lo);
    }

    // Print GPU info to stderr for visibility.
    int dev = 0;
    cudaDeviceProp props;
    CHECK(cudaGetDeviceProperties(&props, dev));
    fprintf(stderr,
            "  [cuda] device=%s sm=%d.%d cores~%d batch=%zu\n",
            props.name, props.major, props.minor,
            props.multiProcessorCount * 128 /* rough estimate */,
            batch_size);

    // Allocate device memory.
    uint8_t* d_prefix = nullptr;
    unsigned long long* d_result_nonce = nullptr;
    int* d_result_found = nullptr;
    CHECK(cudaMalloc(&d_prefix, MAX_PREFIX));
    CHECK(cudaMalloc(&d_result_nonce, sizeof(unsigned long long)));
    CHECK(cudaMalloc(&d_result_found, sizeof(int)));
    CHECK(cudaMemcpy(d_prefix, prefix, prefix_len, cudaMemcpyHostToDevice));
    int zero_i = 0;
    unsigned long long zero_ll = 0;
    CHECK(cudaMemcpy(d_result_found, &zero_i,  sizeof(int),                cudaMemcpyHostToDevice));
    CHECK(cudaMemcpy(d_result_nonce, &zero_ll, sizeof(unsigned long long), cudaMemcpyHostToDevice));

    const int threads_per_block = 256;
    size_t blocks_per_launch = (batch_size + threads_per_block - 1) / threads_per_block;
    if (blocks_per_launch > (size_t)INT32_MAX) {
        fprintf(stderr, "batch_size too large\n");
        return 1;
    }

    auto t_start = std::chrono::high_resolution_clock::now();
    uint64_t total_hashes = 0;
    uint64_t base = 0;
    int found = 0;
    uint64_t launch_count = 0;

    while (!found) {
        mine_kernel<<<(int)blocks_per_launch, threads_per_block>>>(
            d_prefix, prefix_len, base,
            (uint32_t)difficulty,
            d_result_nonce, d_result_found
        );
        CHECK(cudaDeviceSynchronize());
        CHECK(cudaMemcpy(&found, d_result_found, sizeof(int), cudaMemcpyDeviceToHost));

        total_hashes += batch_size;
        base         += batch_size;
        launch_count += 1;

        // Periodic stderr heartbeat (~ every 16 launches = ~256M hashes).
        if (!found && (launch_count % 16 == 0)) {
            auto now = std::chrono::high_resolution_clock::now();
            double elapsed = std::chrono::duration<double>(now - t_start).count();
            double rate_mhs = (double)total_hashes / elapsed / 1.0e6;
            fprintf(stderr, "  [cuda] hashes=%llu elapsed=%.2fs rate=%.1f MH/s\n",
                    (unsigned long long)total_hashes, elapsed, rate_mhs);
        }
    }

    unsigned long long solution = 0;
    CHECK(cudaMemcpy(&solution, d_result_nonce, sizeof(unsigned long long), cudaMemcpyDeviceToHost));

    auto t_end = std::chrono::high_resolution_clock::now();
    double elapsed = std::chrono::duration<double>(t_end - t_start).count();
    double rate_mhs = (double)total_hashes / elapsed / 1.0e6;
    fprintf(stderr,
            "[cuda] solved nonce=%llu hashes=%llu elapsed=%.3fs rate=%.1f MH/s\n",
            solution, (unsigned long long)total_hashes, elapsed, rate_mhs);

    // Single stdout line: just the nonce (matches Rust solver contract).
    printf("%llu\n", solution);
    fflush(stdout);

    cudaFree(d_prefix);
    cudaFree(d_result_nonce);
    cudaFree(d_result_found);
    return 0;
}
