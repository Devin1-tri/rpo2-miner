use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::env;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Count trailing zero bits in a hash (matching RPOW2 server exactly).
/// Server code (packages/shared/src/difficulty.ts):
///   Iterates from LAST byte (index 31) to first (index 0).
///   Within each byte, counts from LSB.
/// This is equivalent to treating the 32-byte hash as a little-endian 256-bit integer.
#[inline(always)]
fn trailing_zero_bits(hash: &[u8; 32]) -> u32 {
    let mut count = 0u32;
    for i in (0..32).rev() {
        let byte = hash[i];
        if byte == 0 {
            count += 8;
        } else {
            count += byte.trailing_zeros();
            return count;
        }
    }
    count
}

/// Write u64 as little-endian 8 bytes into buffer at offset.
/// Matches server's verifySolution: manual LE write identical to writeBigUInt64LE.
#[inline(always)]
fn write_le64(buf: &mut [u8], offset: usize, val: u64) {
    buf[offset..offset + 8].copy_from_slice(&val.to_le_bytes());
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 3 {
        eprintln!("Usage: rpow2-solver <nonce_prefix_hex> <difficulty_bits> [num_threads]");
        eprintln!("Output: <solution_nonce_decimal> on stdout when found");
        std::process::exit(1);
    }

    let nonce_prefix_hex = &args[1];
    let difficulty_bits: u32 = args[2].parse().expect("difficulty_bits must be a number");
    let num_threads: usize = if args.len() > 3 {
        args[3].parse().expect("num_threads must be a number")
    } else {
        num_cpus::get()
    };

    // Decode hex prefix
    let nonce_prefix = hex::decode(nonce_prefix_hex).expect("Invalid hex for nonce_prefix");
    let prefix_len = nonce_prefix.len();

    // Configure rayon thread pool
    rayon::ThreadPoolBuilder::new()
        .num_threads(num_threads)
        .build_global()
        .unwrap();

    let found = Arc::new(AtomicBool::new(false));
    let solution = Arc::new(AtomicU64::new(0));
    let total_hashes = Arc::new(AtomicU64::new(0));

    let start = Instant::now();

    // Stride-based partitioning: thread i checks nonces i, i+stride, i+2*stride, ...
    // Better than range partitioning for cache locality and early-exit fairness.
    let stride = num_threads as u64;

    (0..num_threads).into_par_iter().for_each(|thread_id| {
        let found = Arc::clone(&found);
        let solution = Arc::clone(&solution);
        let total_hashes = Arc::clone(&total_hashes);

        // Pre-allocate input buffer: prefix + 8 bytes for nonce
        let mut input = vec![0u8; prefix_len + 8];
        input[..prefix_len].copy_from_slice(&nonce_prefix);

        let mut nonce: u64 = thread_id as u64;
        let mut local_count: u64 = 0;
        let batch_report: u64 = 100_000;

        loop {
            if found.load(Ordering::Relaxed) {
                break;
            }

            // Write nonce as LE64
            write_le64(&mut input, prefix_len, nonce);

            // SHA-256 hash
            let hash: [u8; 32] = Sha256::digest(&input).into();

            if trailing_zero_bits(&hash) >= difficulty_bits {
                if !found.swap(true, Ordering::SeqCst) {
                    solution.store(nonce, Ordering::SeqCst);
                }
                total_hashes.fetch_add(local_count, Ordering::Relaxed);
                return;
            }

            nonce = nonce.wrapping_add(stride);
            local_count += 1;

            // Wrap-around check (practically impossible for difficulty < 64)
            if nonce < stride && thread_id > 0 {
                total_hashes.fetch_add(local_count, Ordering::Relaxed);
                return;
            }

            // Periodic stats update (reduces atomic contention)
            if local_count % batch_report == 0 {
                total_hashes.fetch_add(batch_report, Ordering::Relaxed);
                local_count = 0;

                // Re-check found flag after batch
                if found.load(Ordering::Relaxed) {
                    return;
                }
            }
        }

        total_hashes.fetch_add(local_count, Ordering::Relaxed);
    });

    let elapsed = start.elapsed();
    let total = total_hashes.load(Ordering::Relaxed);
    let hashrate = if elapsed.as_secs_f64() > 0.0 {
        total as f64 / elapsed.as_secs_f64()
    } else {
        0.0
    };

    if found.load(Ordering::Relaxed) {
        let sol = solution.load(Ordering::Relaxed);
        // Output solution as decimal string on stdout (Node.js reads this)
        // Server expects: /^\d{1,20}$/ regex match
        println!("{}", sol);
        // Stats on stderr (doesn't interfere with stdout parsing)
        eprintln!(
            "SOLVED: nonce={} time={:.3}s hashes={} rate={:.2} MH/s",
            sol,
            elapsed.as_secs_f64(),
            total,
            hashrate / 1_000_000.0
        );
    } else {
        eprintln!("EXHAUSTED: no solution found in search space");
        std::process::exit(1);
    }

    io::stdout().flush().unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trailing_zero_bits_basic() {
        // Last byte = 0x00 → 8 trailing zeros
        let mut hash = [0xFFu8; 32];
        hash[31] = 0x00;
        assert_eq!(trailing_zero_bits(&hash), 8);

        // Last byte = 0x04 (00000100) → 2 trailing zeros
        hash[31] = 0x04;
        assert_eq!(trailing_zero_bits(&hash), 2);

        // Last 2 bytes zero, next = 0x80 (10000000) → 16 + 7 = 23
        let mut hash2 = [0xFFu8; 32];
        hash2[31] = 0x00;
        hash2[30] = 0x00;
        hash2[29] = 0x80;
        assert_eq!(trailing_zero_bits(&hash2), 23);

        // All zeros = 256
        let hash3 = [0x00u8; 32];
        assert_eq!(trailing_zero_bits(&hash3), 256);
    }

    #[test]
    fn test_nonce_le64_encoding() {
        let prefix = hex::decode("deadbeefcafebabe").unwrap();
        let nonce: u64 = 12345;

        let mut input = vec![0u8; prefix.len() + 8];
        input[..prefix.len()].copy_from_slice(&prefix);
        write_le64(&mut input, prefix.len(), nonce);

        // 12345 = 0x3039 → LE: [0x39, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        assert_eq!(
            &input[prefix.len()..],
            &[0x39, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        );
    }

    #[test]
    fn test_nonce_zero() {
        let prefix = hex::decode("aabbccdd").unwrap();
        let mut input = vec![0u8; prefix.len() + 8];
        input[..prefix.len()].copy_from_slice(&prefix);
        write_le64(&mut input, prefix.len(), 0);

        assert_eq!(&input[prefix.len()..], &[0u8; 8]);
    }

    #[test]
    fn test_nonce_max_u32() {
        let prefix = hex::decode("aabbccdd").unwrap();
        let nonce: u64 = 0xFFFFFFFF;
        let mut input = vec![0u8; prefix.len() + 8];
        input[..prefix.len()].copy_from_slice(&prefix);
        write_le64(&mut input, prefix.len(), nonce);

        assert_eq!(
            &input[prefix.len()..],
            &[0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00]
        );
    }
}
