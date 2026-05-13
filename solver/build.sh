#!/bin/bash
# Build RPOW2 Rust solver with maximum CPU-specific optimizations
# On Xeon Gold 6130: enables AVX-512 for general optimizations
# Note: Xeon Gold 6130 (Skylake-SP) does NOT have SHA-NI (that's Ice Lake+)
# But target-cpu=native still enables AVX-512F, AVX-512BW, etc.

set -e

echo "═══════════════════════════════════════════════════"
echo "  Building rpow2-solver (Rust native)"
echo "  RUSTFLAGS: -C target-cpu=native"
echo "═══════════════════════════════════════════════════"
echo ""

# Build with native CPU optimizations
# The .cargo/config.toml already sets target-cpu=native
cargo build --release

echo ""
echo "✓ Build complete: target/release/rpow2-solver"
ls -lh target/release/rpow2-solver
echo ""

# Quick benchmark (difficulty 20, all cores)
echo "Running benchmark (difficulty=20, all cores)..."
echo "─────────────────────────────────────────────────"
./target/release/rpow2-solver "deadbeefcafebabe1234567890abcdef" 20
echo ""

# Benchmark difficulty 25 (actual mining difficulty)
echo "Running benchmark (difficulty=25, all cores)..."
echo "─────────────────────────────────────────────────"
./target/release/rpow2-solver "aabbccddeeff00112233445566778899" 25
echo ""

echo "═══════════════════════════════════════════════════"
echo "  ✓ Solver ready! Run with:"
echo "    node index-rust.js        (single account)"
echo "    node multi-rust.js        (multi account)"
echo "═══════════════════════════════════════════════════"
