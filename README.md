# WhatsApp Gateway & Multi-Device Dashboard

A modern, fast, and multi-device WhatsApp Gateway built with **Node.js**, **Express**, **Socket.io**, **SQLite**, and **@whiskeysockets/baileys**. Featuring a sleek Tailwind CSS dashboard with Sonner-style toasts and role-based access control.

---

## 🚀 Key Features

* **Multi-Device Support**: Manage multiple WhatsApp accounts concurrently with live QR code pairing and status syncing.
* **Smart Automatic Fallback**: If the primary WhatsApp account fails or disconnects, messages automatically fallback to active backup devices.
* **Clean & Simple API**: Dispatch messages with just `{ key, number, message }`. `deviceId` is completely optional!
* **Real-time WhatsApp Number Validation**: Automatically checks whether recipient numbers exist on WhatsApp before sending, preventing false successes and saving resources.
* **Flexible Phone Formatting**: Seamlessly accepts formats like `08...`, `+62...`, or `628...`.
* **Complete Audit Trail**: Records recipient, sender WhatsApp number, device used, client IP, status (`SUCCESS` / `FAILED`), and error details in SQLite.
* **Role & User Management**: Dedicated `admin` and `operator` roles. Admins can deactivate accounts with immediate login revocation.
* **Modern UI / UX**: Built with modern Tailwind CSS, shadcn-style floating Sonner toast notifications, and AlertDialogs (no SweetAlert / alert popups).

---

## 📦 Deployment via Docker (Recommended for VPS)

### 1. Prerequisites
Ensure Docker and Docker Compose are installed on your VPS (Ubuntu 22.04 / 24.04):
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
```

### 2. Clone & Run
```bash
git clone <YOUR_GITHUB_REPO_URL> wa-gateway
cd wa-gateway

# Start the gateway in background
docker compose up -d --build
```

### 3. Check Logs & Status
```bash
docker compose logs -f
```

The gateway dashboard will be live at: `http://YOUR_SERVER_IP:3000`

---

## 🛠️ Deployment via PM2 (Manual Setup)

If you prefer running directly on Ubuntu with PM2:
```bash
# 1. Install Node.js v20+ and PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

# 2. Clone repo and install dependencies
git clone <YOUR_GITHUB_REPO_URL> wa-gateway
cd wa-gateway
npm install

# 3. Build Tailwind CSS
npm run build:css

# 4. Start with PM2
pm2 start src/server.js --name "wa-gateway"
pm2 startup
pm2 save
```

---

## 🔑 Default Credentials

* **URL**: `http://localhost:3000/login`
* **Username**: `admin`
* **Password**: `admin123`

*(Change the password or create new operators in the User Management menu after logging in).*

---

## 📡 REST API Reference

All requests must include your API Key via JSON body (`"key": "..."`), query string (`?key=...`), or header (`X-API-Key: ...`).

### 1. Send Message
* **Endpoint**: `POST /api/v1/send`
* **Headers**: `Content-Type: application/json`
* **Body**:
```json
{
  "key": "YOUR_API_KEY",
  "number": "081234567890",
  "message": "Halo! Pesan ini dikirim otomatis via WhatsApp Gateway."
}
```
* **Success Response (HTTP 200)**:
```json
{
  "status": true,
  "message": "Message dispatched successfully",
  "data": {
    "recipient": "6281234567890",
    "senderNumber": "6285183115097",
    "deviceId": "dev_default",
    "deviceName": "Device Utama",
    "fallbackUsed": false,
    "messageId": "3EB015B71BFEABB09DC2BD"
  }
}
```

### 2. Check WhatsApp Registration
* **Endpoint**: `POST /api/v1/check-number`
* **Body**:
```json
{
  "key": "YOUR_API_KEY",
  "number": "085607025368"
}
```
* **Response (HTTP 200)**:
```json
{
  "status": true,
  "exists": true,
  "jid": "6285607025368@s.whatsapp.net",
  "senderNumber": "6285183115097",
  "deviceId": "dev_default",
  "deviceName": "Device Utama",
  "message": "Number is registered on WhatsApp"
}
```

---

## 🔒 Security & Persistence
* **Sessions**: Stored in `./sessions/` (protected in `.gitignore`).
* **Database**: SQLite WAL database stored in `./data/data.db` or `./data.db`.
