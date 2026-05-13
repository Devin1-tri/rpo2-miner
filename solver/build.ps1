# build.ps1 — Build RPOW2 Rust solver on Windows (PowerShell)
# Usage:  .\build.ps1
# Equivalent of solver/build.sh for Linux/macOS.

$ErrorActionPreference = 'Stop'

Write-Host '═══════════════════════════════════════════════════'
Write-Host '  Building rpow2-solver (Rust native, Windows)'
Write-Host '  RUSTFLAGS: -C target-cpu=native (from .cargo/config.toml)'
Write-Host '═══════════════════════════════════════════════════'
Write-Host ''

# Build release binary with native CPU optimizations.
cargo build --release
if ($LASTEXITCODE -ne 0) {
    Write-Host 'cargo build failed' -ForegroundColor Red
    exit 1
}

$binary = Join-Path $PSScriptRoot 'target\release\rpow2-solver.exe'
if (-not (Test-Path $binary)) {
    Write-Host "Build finished but binary not found at $binary" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host "✓ Build complete: $binary"
Get-Item $binary | Format-List Name, Length, LastWriteTime
Write-Host ''

# Quick benchmark (difficulty 20 is fast — ~1 sec on most CPUs).
Write-Host 'Running benchmark (difficulty=20)...'
Write-Host '─────────────────────────────────────────────────'
& $binary 'deadbeefcafebabe1234567890abcdef' 20
Write-Host ''

Write-Host '═══════════════════════════════════════════════════'
Write-Host '  ✓ Solver ready! Run with:'
Write-Host '    node index-rust.js        (single account)'
Write-Host '    node multi-rust.js        (multi account)'
Write-Host '═══════════════════════════════════════════════════'
