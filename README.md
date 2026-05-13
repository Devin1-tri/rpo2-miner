# rpo2-miner (T40 fork)

SHA-256 PoW miner untuk [rpow2.com](https://rpow2.com), **dituning untuk Dell PowerEdge T40** (Intel Xeon E-2224G, 4 core / 4 thread @ 3.5 GHz, 8 GB RAM).

Fork dari [happy-cuan-og/rpow2-miner](https://github.com/happy-cuan-og/rpow2-miner) dengan dua perbaikan utama:

1. **Bug fix HTTP 429 COOLDOWN.** `apiRequest` sekarang membaca field `retry_after` dari response server dan menunggu durasi yang diminta. 429 tidak lagi dihitung sebagai retry attempt, jadi log tidak akan dipenuhi `[Error]` palsu.
2. **Default config dituning untuk T40.** `NUM_WORKERS=3`, `LOOP_DELAY_MS=5500` — kombinasi ini menghindari 429 sama sekali dan menyisakan 1 core untuk OS.

> **Disclaimer dari upstream:** _"RPOW2 tokens have no monetary value (educational project)."_ Ini bukan crypto bernilai — anggap sebagai mainan SHA-256 PoW.

---

## Spesifikasi Target: Dell PowerEdge T40

| Komponen | Nilai |
|---|---|
| CPU | Intel Xeon E-2224G (4C/4T, 3.5 GHz base, 4.7 GHz turbo) |
| RAM | 8 GB DDR4 ECC |
| Instruksi vektor | AVX2 ✓ &nbsp;&nbsp; AVX-512 ✗ &nbsp;&nbsp; SHA-NI ✗ |
| Estimasi hash rate | ~12–20 MH/s (dengan `NUM_WORKERS=3`) |
| Token/jam (difficulty 33) | ~6–12 tok/hr realistis |

Karena E-2224G **tidak punya SHA-NI maupun AVX-512**, Rust solver akan jatuh ke jalur SHA-256 software biasa (lebih lambat daripada Xeon Gold/Ice Lake yang punya SHA-NI). Tetap lebih cepat ~5x daripada fallback Node.js murni.

---

## Quick Start — Windows (PowerShell)

T40 Anda jalan Windows. Ikuti langkah ini di **PowerShell** (bukan CMD).

```powershell
# 1. Clone
git clone https://github.com/Devin1-tri/rpo2-miner.git
cd rpo2-miner

# 2. Install Node.js 20+ (kalau belum)
#    Download dari https://nodejs.org/ (LTS), install pakai default options.
node --version   # verifikasi: harus >= 18

# 3. Install Rust toolchain (untuk solver native)
#    Download rustup-init.exe dari https://rustup.rs/ dan jalankan.
#    Saat installer tanya, pilih default (option 1).
#    Setelah selesai, buka PowerShell BARU agar PATH ter-refresh.
cargo --version   # verifikasi

# 4. Build Rust solver (~1–3 menit pertama kali)
cd solver
.\build.ps1
cd ..

# 5. Configure
copy config.example.js config.js
notepad config.js          # paste SESSION_COOKIE dari browser

# 6. Run (Rust solver, single account)
node index-rust.js
```

### Catatan Windows
- Binary Rust di Windows = `rpow2-solver.exe` (sudah otomatis di-detect oleh script).
- Kalau `cargo build` complain butuh "Visual Studio Build Tools", install dari:
  https://visualstudio.microsoft.com/visual-cpp-build-tools/ → centang **"Desktop development with C++"**.
- Defender / antivirus kadang flag binary mining sebagai suspicious — itu false positive, tambah folder repo ke whitelist kalau perlu.

## Quick Start — Linux (Bash)

```bash
# 1. Clone
git clone https://github.com/Devin1-tri/rpo2-miner.git
cd rpo2-miner

# 2. Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential

# 3. Install Rust (untuk solver native)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# 4. Build Rust solver (~1–2 menit di T40)
cd solver
chmod +x build.sh
./build.sh
cd ..

# 5. Configure
cp config.example.js config.js
nano config.js            # paste SESSION_COOKIE dari browser

# 6. Run (Rust solver, single account)
node index-rust.js
```

### Cara dapat `SESSION_COOKIE`

1. Login ke https://rpow2.com
2. Buka **DevTools** (F12) → tab **Application** → **Cookies** → `https://rpow2.com`
3. Copy nilai cookie `rpow_session` (string panjang)
4. Paste ke `config.js` field `SESSION_COOKIE`

Cookie kadaluwarsa setiap **30 hari**. Kalau miner crash dengan _"Session invalid"_, login ulang dan update cookie.

---

## Konfigurasi T40 (Per-Mode)

### Single account (paling umum)

```bash
node index-rust.js
# atau dengan env override:
RPOW_THREADS=3 RPOW_DELAY=5500 node index-rust.js
```

### Multi account (kalau punya beberapa akun rpow2.com)

```bash
# 1. Buat accounts.json (lihat accounts.example.json)
cp accounts.example.json accounts.json
nano accounts.json

# 2. Bagi rata 3 thread ke N akun
RPOW_TOTAL_THREADS=3 node multi-rust.js
```

> ⚠️ Multi-account bisa melanggar ToS rpow2.com. Risiko akun di-banned ditanggung sendiri.

### Tanpa Rust (fallback Node.js murni)

Kalau gagal install Rust:
```bash
node index.js
```
Lebih lambat ~3–5x, tapi tetap jalan.

---

## Environment Variables

| Variable | Default | Keterangan |
|---|---|---|
| `RPOW_SESSION` | (config.js) | Override session cookie |
| `RPOW_API_BASE` | `https://api.rpow2.com` | API endpoint |
| `RPOW_THREADS` | `3` (T40 default) | Thread untuk Rust solver, single account |
| `RPOW_TOTAL_THREADS` | `3` (T40 default) | Total thread, auto-split antar akun |
| `RPOW_WORKERS` | `3` | Worker untuk Node.js fallback |
| `RPOW_DELAY` | `5500` | Delay (ms) antar mint → next challenge |
| `RPOW_SOLVER_BIN` | `./solver/target/release/rpow2-solver` | Path ke Rust binary |

---

## Run 24/7 di T40

### Windows — Opsi A: PM2 (recommended)

PM2 jalan native di Windows + auto-restart on crash + bisa autostart on boot.

```powershell
npm install -g pm2
pm2 start index-rust.js --name rpo2
pm2 logs rpo2                      # lihat log real-time
pm2 save

# Autostart on Windows boot (pakai pm2-windows-startup):
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```

### Windows — Opsi B: Task Scheduler (built-in)

1. Buka **Task Scheduler** (taskschd.msc)
2. **Create Task** → tab General: centang "Run whether user is logged on or not"
3. Tab Triggers: At startup
4. Tab Actions:
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `index-rust.js`
   - Start in: `C:\Users\AZ\Pictures\bot\rpo2-miner`
5. Tab Settings: centang "If the task fails, restart every: 1 minute, attempt 999 times"

### Windows — Opsi C: NSSM (jalan sebagai Windows Service)

Untuk yang mau professional setup:
```powershell
# Download NSSM dari https://nssm.cc/download
.\nssm.exe install rpo2-miner "C:\Program Files\nodejs\node.exe" "index-rust.js"
.\nssm.exe set rpo2-miner AppDirectory "C:\Users\AZ\Pictures\bot\rpo2-miner"
.\nssm.exe set rpo2-miner AppEnvironmentExtra "RPOW_SESSION=YOUR_COOKIE_HERE"
.\nssm.exe start rpo2-miner
```

### Linux — Opsi A: Screen

```bash
screen -S rpow
node index-rust.js
# Ctrl+A lalu D untuk detach
# screen -r rpow untuk re-attach
```

### Linux — Opsi B: systemd (auto-restart on boot)

```bash
# 1. Edit unit file: ganti USER, WORKDIR, dan SESSION_COOKIE
sudo cp systemd/rpo2-miner.service /etc/systemd/system/
sudo nano /etc/systemd/system/rpo2-miner.service

# 2. Enable + start
sudo systemctl daemon-reload
sudo systemctl enable --now rpo2-miner

# 3. Cek status & log
systemctl status rpo2-miner
journalctl -u rpo2-miner -f
```

### Linux — Opsi C: PM2

```bash
sudo npm install -g pm2
pm2 start index-rust.js --name rpo2
pm2 startup        # ikuti instruksi yang ditampilkan
pm2 save
pm2 logs rpo2
```

---

## Monitoring Konsumsi Resource

T40 dengan 4-core 100% load:
- **CPU**: ~71W TDP × 75% load ≈ **55W tambahan** di atas idle ~40W → total ~95–110W
- **RAM**: ~200–500 MB
- **Disk**: hampir 0 (cuma log)
- **Network**: <1 KB/detik (cuma POST kecil ke API)

Pantau dengan:
```bash
htop                          # CPU usage
sensors                       # suhu CPU (apt install lm-sensors)
journalctl -u rpo2-miner -f   # log miner
```

T40 PSU 290W aman jauh untuk beban ini.

---

## Ekspektasi Pendapatan

Pada hash rate **~16 MH/s** (estimasi T40 dengan 3 worker) dan difficulty 33:
- Avg solve time ≈ **9 menit per token**
- ~6–7 token/jam ≈ ~150 token/hari
- Difficulty bisa naik (epoch-based di server) — token/hari bisa turun seiring waktu

**Sekali lagi**: token RPOW2 **tidak punya nilai uang**. Ini hanya proyek edukasi.

---

## Troubleshooting

### Masih lihat `[Error] API POST /challenge → 429`
Update sudah otomatis handle 429, jadi log harusnya `[cooldown] /challenge → wait 5250ms` (bukan `[Error]`). Kalau masih muncul "[Error]" untuk 429, pastikan Anda di branch yang benar:
```bash
git pull && git log -1 --oneline
```

### `Solver binary not found`
Build dulu:
- **Windows (PowerShell):** `cd solver; .\build.ps1` (atau `cargo build --release`)
- **Linux:** `cd solver && ./build.sh`

Catatan Windows: binary asli bernama `rpow2-solver.exe`. Versi terbaru script sudah auto-detect, tapi kalau Anda clone repo lama, pull dulu (`git pull`).

### `Session invalid or expired`
Cookie kadaluwarsa atau salah copy. Login ulang ke rpow2.com → copy cookie baru → update `config.js`.

### CPU temperature tinggi (>85°C)
T40 cooler standar cukup untuk Xeon E-2224G. Kalau panas:
- Bersihkan debu intake/heatsink
- Kurangi `NUM_WORKERS` ke 2 (estimasi 12 MH/s, masih lumayan)
- Pastikan air flow case OK

### Network lag/disconnect sering
Default `MAX_RETRIES=10` sudah cukup tolerant. Kalau koneksi sangat tidak stabil, naikan di `config.js`.

---

## Perbedaan dari Upstream `happy-cuan-og/rpow2-miner`

| Hal | Upstream | T40 fork |
|---|---|---|
| 429 handling | Diabaikan, retry 3s fix | Baca `retry_after`, transparent |
| 429 vs MAX_RETRIES | Dihitung sebagai retry | Tidak dihitung |
| `NUM_WORKERS` default | 56 (Xeon Gold 56-core) | 3 (T40 4-core) |
| `LOOP_DELAY_MS` default | 100 | 5500 |
| `MAX_RETRIES` default | 5 | 10 |
| systemd unit | — | Disediakan |
| README | English, generic | Bahasa Indonesia, T40-specific |

File yang dimodifikasi:
- `index-rust.js`, `index.js`, `miner-process-rust.js`, `miner-process.js` (429 fix)
- `config.example.js` (T40 defaults)
- `systemd/rpo2-miner.service` (baru)
- `README.md` (re-written)

---

## License

MIT (warisan dari upstream)
