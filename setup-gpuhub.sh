#!/bin/bash
# setup-gpuhub.sh — One-shot setup for rpo2-miner CUDA on gpuhub / autodl / similar
#
# Tested target: Ubuntu 22.04/24.04 with NVIDIA driver + CUDA Toolkit 12.8+
# pre-installed (gpuhub default).
#
# Usage (on the gpuhub instance, after `git clone` + `cd rpo2-miner`):
#   chmod +x setup-gpuhub.sh
#   ./setup-gpuhub.sh
#
# Then edit `config.js` with your SESSION_COOKIE and run:
#   node index-cuda.js

set -e

echo "═══════════════════════════════════════════════════════════"
echo "  rpo2-miner CUDA setup for gpuhub"
echo "═══════════════════════════════════════════════════════════"
echo

# ─── 0. Sanity checks ────────────────────────────────────────────────────────
echo "[0/5] Sanity checks..."

if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "  ✗ nvidia-smi not found. Is this actually a GPU instance?" >&2
    exit 1
fi
nvidia-smi -L
echo

if ! command -v nvcc >/dev/null 2>&1; then
    echo "  ⚠ nvcc (CUDA toolkit) not found. Attempting install..."
    sudo apt-get update
    sudo apt-get install -y nvidia-cuda-toolkit
fi
echo "  nvcc: $(nvcc --version | grep release)"
echo

# ─── 1. Node.js ──────────────────────────────────────────────────────────────
echo "[1/5] Installing Node.js (if missing)..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 18 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo "  node: $(node -v)"
echo

# ─── 2. Build CUDA solver ────────────────────────────────────────────────────
echo "[2/5] Building CUDA solver..."
cd "$(dirname "$0")/solver-cuda"
./build.sh
cd ..
echo

# ─── 3. config.js scaffold ───────────────────────────────────────────────────
echo "[3/5] Setting up config.js..."
if [ ! -f config.js ]; then
    cp config.example.js config.js
    echo "  ✓ Created config.js"
    echo
    echo "  ⚠ EDIT config.js NOW and paste your SESSION_COOKIE."
    echo "    nano config.js"
    echo
else
    echo "  ✓ config.js already exists (skipping)"
    echo
fi

# ─── 4. Recommended tweaks for gpuhub ────────────────────────────────────────
echo "[4/5] Recommended config tweaks for gpuhub (Xeon Platinum + RTX 5090):"
echo "  - NUM_WORKERS: not used by CUDA path (GPU handles parallelism)"
echo "  - LOOP_DELAY_MS: 5500 (matches server cooldown)"
echo "  - RPOW_BATCH: 16777216 (16M nonces/launch, env var override)"
echo

# ─── 5. Run instructions ─────────────────────────────────────────────────────
echo "[5/5] Done. To start mining:"
echo "  nano config.js                  # paste SESSION_COOKIE first!"
echo "  node index-cuda.js              # foreground"
echo
echo "  Background (recommended for SSH sessions):"
echo "    sudo apt-get install -y screen"
echo "    screen -S rpow"
echo "    node index-cuda.js"
echo "    # detach: Ctrl+A then D"
echo "    # re-attach: screen -r rpow"
echo
echo "═══════════════════════════════════════════════════════════"
echo "  ⚠  RISK REMINDERS"
echo "═══════════════════════════════════════════════════════════"
echo "  - GPU mining = high tok/hr → high anti-bot risk on rpow2.com"
echo "  - Many GPU cloud providers (gpuhub/autodl/vast.ai) FORBID crypto"
echo "    mining in their ToS. Your instance may be suspended."
echo "  - RPOW2 tokens have no monetary value (educational project)."
echo "  - Run short sessions only, monitor for ban."
echo "═══════════════════════════════════════════════════════════"
