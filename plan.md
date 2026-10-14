# WhatsApp Gateway Project Plan & Architecture

## Tech Stack
*   **Backend:** Express.js 5 (Node.js)
*   **WA Multi-Device Engine:** Baileys (`@whiskeysockets/baileys`)
*   **Realtime Communication:** Socket.IO
*   **Frontend:** EJS Templating + Tailwind CSS v4
*   **Database:** SQLite (`better-sqlite3`) with WAL Mode
*   **Authentication & Security:** `express-session`, `bcryptjs`, API Key Verification

---

## Status Fitur (Completed)

### 1. Database SQLite (`data.db`)
*   `users`: Autentikasi admin dashboard (username + password hash bcrypt).
*   `api_keys`: Manajemen secret key untuk akses REST API eksternal.
*   `devices`: Penyimpanan status multi-device WhatsApp, nomor HP, dan sesi.
*   `message_logs`: Audit trail request (nomor tujuan, IP request, status SUCCESS/FAILED, error message, waktu, device ID).

### 2. Multi-Device WhatsApp Manager (`src/services/whatsappManager.js`)
*   Mendukung banyak akun/nomor WhatsApp sekaligus.
*   Penyimpanan sesi terisolasi per device di `sessions/<deviceId>/`.
*   Auto-reconnect, dynamic QR Code per device, dan live status broadcast via Socket.IO.
*   Pengiriman pesan fleksibel (bisa pilih `deviceId` spesifik atau auto-select).

### 3. Autentikasi & Keamanan (`src/middleware/auth.js`)
*   Halaman Login `/login` dengan validasi bcrypt.
*   Middleware `requireAuth` untuk melindungi dashboard web.
*   Middleware `requireApiKey` untuk melindungi endpoint REST API (`X-API-Key` atau `Bearer`).

### 4. Dua Dashboard Terpisah
1.  **Dashboard 1 - Manajemen Device (`/devices`):**
    *   Statistik jumlah device, status online, dan offline/QR.
    *   Kartu device dengan badge status interaktif.
    *   Tambah device baru, scan QR code, modal test kirim pesan langsung, restart, logout, dan hapus device.
2.  **Dashboard 2 - Message & Activity Logs (`/logs`):**
    *   Statistik total request, success rate, delivered, dan failed.
    *   Tabel audit log lengkap (Waktu, No Tujuan, Status SUCCESS/FAILED, Device, Client IP, Pesan).
    *   Filter status (Semua, Success, Failed) dan search keyword nomor tujuan.
    *   Feed pesan WhatsApp masuk secara realtime via Socket.IO.
3.  **Halaman Manajemen API Key (`/api-keys`):**
    *   Pembuatan API Key baru, toggle status aktif/non-aktif, hapus key, dan dokumentasi cURL.

---

## Endpoint REST API v1
*   `POST /api/v1/send` (Header: `X-API-Key`) -> Mengirim pesan WhatsApp & mencatat audit IP + status.
*   `POST /api/v1/check-number` (Header: `X-API-Key`) -> Cek validitas nomor WhatsApp.
*   `GET /api/v1/devices` (Header: `X-API-Key`) -> List device WhatsApp aktif.
