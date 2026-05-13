#!/bin/bash
# setup-gpuhub.sh - One-shot setup for rpo2-miner CUDA on gpuhub / autodl / similar
#
# Tested target: Ubuntu 22.04/24.04 with NVIDIA driver + CUDA Toolkit 12.8+
# pre-installed (gpuhub default PyTorch base image).
#
# Usage (on the gpuhub instance, after `git clone` + `cd rpo2-miner`):
#   chmod +x setup-gpuhub.sh
#   ./setup-gpuhub.sh
#
# Then edit `config.js` with your SESSION_COOKIE and run:
#   node index-cuda.js

# Detect whether sudo is available; gpuhub containers usually run as root
# without sudo installed.
if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
else
    echo "ERROR: not root and sudo not installed. Cannot install packages." >&2
    exit 1
fi

echo "================================================================"
echo "  rpo2-miner CUDA setup for gpuhub"
echo "  (root=$([ -z "$SUDO" ] && echo yes || echo no))"
echo "================================================================"
echo

# --- 0. Sanity checks --------------------------------------------------------
echo "[0/5] Sanity checks..."

if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "  FAIL: nvidia-smi not found. Is this actually a GPU instance?" >&2
    exit 1
fi
nvidia-smi -L
echo

if ! command -v nvcc >/dev/null 2>&1; then
    echo "  nvcc not in PATH. Searching /usr/local/cuda*/bin..."
    FOUND_NVCC=""
    for cdir in /usr/local/cuda-13.* /usr/local/cuda-12.* /usr/local/cuda /usr/local/cuda-12 /usr/local/cuda-13; do
        if [ -x "$cdir/bin/nvcc" ]; then
            FOUND_NVCC="$cdir"
            break
        fi
    done

    if [ -n "$FOUND_NVCC" ]; then
        echo "  OK: Found CUDA toolkit at: $FOUND_NVCC"
        export PATH="$FOUND_NVCC/bin:$PATH"
        export LD_LIBRARY_PATH="$FOUND_NVCC/lib64:${LD_LIBRARY_PATH:-}"

        if ! grep -q "$FOUND_NVCC/bin" ~/.bashrc 2>/dev/null; then
            {
                echo ""
                echo "# Added by rpo2-miner setup-gpuhub.sh"
                echo "export PATH=\"$FOUND_NVCC/bin:\$PATH\""
                echo "export LD_LIBRARY_PATH=\"$FOUND_NVCC/lib64:\${LD_LIBRARY_PATH:-}\""
            } >> ~/.bashrc
            echo "  OK: Persisted CUDA path to ~/.bashrc"
        fi
    else
        echo "  WARN: No /usr/local/cuda*/bin/nvcc found. Attempting apt install..."
        $SUDO apt-get update
        $SUDO apt-get install -y nvidia-cuda-toolkit
    fi
fi

if ! command -v nvcc >/dev/null 2>&1; then
    echo "  FAIL: nvcc still not available after setup. Aborting." >&2
    exit 1
fi
echo "  nvcc: $(nvcc --version | grep release)"
echo

# --- 1. Node.js --------------------------------------------------------------
echo "[1/5] Installing Node.js (if missing)..."
if command -v node >/dev/null 2>&1 && [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -ge 18 ]; then
    echo "  OK: $(node --version) already installed"
else
    echo "  Adding NodeSource repo..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
    $SUDO apt-get install -y nodejs
fi
echo "  node: $(node --version)"
echo "  npm:  $(npm --version)"
echo

# --- 2. Build CUDA solver ----------------------------------------------------
echo "[2/5] Building CUDA solver..."
cd "$(dirname "$0")/solver-cuda"
./build.sh
cd ..
echo

# --- 3. config.js scaffold ---------------------------------------------------
echo "[3/5] Setting up config.js..."
if [ ! -f config.js ]; then
    cp config.example.js config.js
    echo "  OK: Created config.js"
    echo
    echo "  ACTION REQUIRED: Edit config.js NOW and paste your SESSION_COOKIE."
    echo "    nano config.js"
    echo
else
    echo "  OK: config.js already exists (skipping)"
    echo
fi

# --- 4. Install screen for background sessions -------------------------------
echo "[4/5] Installing screen (for background sessions)..."
if ! command -v screen >/dev/null 2>&1; then
    $SUDO apt-get install -y screen >/dev/null 2>&1 || true
fi
command -v screen >/dev/null 2>&1 && echo "  OK: screen installed" || echo "  WARN: screen not installed (optional)"
echo

# --- 5. Run instructions -----------------------------------------------------
echo "[5/5] Done. To start mining:"
echo "  nano config.js               # paste SESSION_COOKIE first!"
echo "  node index-cuda.js           # foreground"
echo
echo "  Background (recommended for SSH):"
echo "    screen -S rpow"
echo "    node index-cuda.js"
echo "    # detach: Ctrl+A then D"
echo "    # re-attach: screen -r rpow"
echo
echo "================================================================"
echo "  RISK REMINDERS"
echo "================================================================"
echo "  - GPU mining = high tok/hr -> high anti-bot risk on rpow2.com"
echo "  - Many GPU cloud providers (gpuhub/autodl/vast.ai) FORBID crypto"
echo "    mining in their ToS. Your instance may be suspended."
echo "  - RPOW2 tokens have no monetary value (educational project)."
echo "  - Run short sessions only, monitor for ban."
echo "================================================================"
