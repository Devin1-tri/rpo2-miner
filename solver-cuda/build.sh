#!/bin/bash
# Build RPOW2 CUDA solver. Targets RTX 5090 (Blackwell, sm_120) by default,
# with PTX fallbacks for older GPUs.
#
# Usage:
#   ./build.sh                # build with default arch list
#   ARCH=sm_89 ./build.sh     # override (e.g. RTX 4090)
#   ./build.sh --quick        # build only for the host GPU's compute capability

set -e

cd "$(dirname "$0")"

if ! command -v nvcc >/dev/null 2>&1; then
    echo "✗ nvcc not found. Install CUDA Toolkit:" >&2
    echo "    sudo apt-get install -y nvidia-cuda-toolkit  (older Ubuntu)" >&2
    echo "    or follow https://developer.nvidia.com/cuda-downloads" >&2
    exit 1
fi

NVCC_VERSION=$(nvcc --version | grep -oP 'release \K[0-9]+\.[0-9]+' | head -n1)
echo "  nvcc version: ${NVCC_VERSION}"

# Default: build for Blackwell (sm_120, RTX 5090) plus a Hopper PTX fallback
# (compute_90) that the driver can JIT-compile on newer GPUs.
GENCODE_ARGS=(
    # RTX 5090 / Blackwell (CUDA >= 12.8)
    "-gencode=arch=compute_120,code=sm_120"
    # Hopper PTX fallback (JIT-compiled by driver for sm_120 if needed)
    "-gencode=arch=compute_90,code=compute_90"
)

if [ -n "$ARCH" ]; then
    GENCODE_ARGS=("-arch=$ARCH")
    echo "  override arch: $ARCH"
fi

echo "═══════════════════════════════════════════════════"
echo "  Building rpow2-cuda (CUDA SHA-256 PoW solver)"
echo "  Flags: -O3 ${GENCODE_ARGS[*]}"
echo "═══════════════════════════════════════════════════"

# Try the requested arch list; if it fails (e.g. nvcc too old for sm_120),
# fall back to a wider compatibility set.
if ! nvcc -O3 -std=c++17 "${GENCODE_ARGS[@]}" \
        sha256_pow.cu -o rpow2-cuda 2> nvcc.log; then
    cat nvcc.log
    echo ""
    echo "  ⚠ First build failed. Retrying with PTX-only fallback (slower JIT)..."
    nvcc -O3 -std=c++17 \
        -gencode=arch=compute_75,code=compute_75 \
        sha256_pow.cu -o rpow2-cuda
fi

rm -f nvcc.log
echo ""
echo "✓ Build complete: $(pwd)/rpow2-cuda"
ls -lh rpow2-cuda

echo ""
echo "Running self-test (difficulty=20)..."
echo "─────────────────────────────────────────────────"
./rpow2-cuda "deadbeefcafebabe1234567890abcdef" 20 || {
    echo "✗ Self-test failed" >&2
    exit 1
}

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ CUDA solver ready! Run from repo root:"
echo "    node index-cuda.js        (single account, GPU)"
echo "═══════════════════════════════════════════════════"
