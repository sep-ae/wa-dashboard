const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}
const db = new Database(dbPath);

// Enable WAL mode for high concurrency
db.pragma('journal_mode = WAL');

// Initialize tables
function initDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'admin',
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            key TEXT UNIQUE NOT NULL,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            phone_number TEXT,
            status TEXT DEFAULT 'disconnected',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS message_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT,
            device_name TEXT,
            sender_number TEXT,
            api_key_id INTEGER,
            recipient TEXT NOT NULL,
            message TEXT NOT NULL,
            ip_address TEXT NOT NULL,
            status TEXT NOT NULL,
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Migration check for message_logs table
    const logCols = db.pragma('table_info(message_logs)').map(c => c.name);
    if (!logCols.includes('sender_number')) {
        db.exec("ALTER TABLE message_logs ADD COLUMN sender_number TEXT;");
    }
    if (!logCols.includes('device_name')) {
        db.exec("ALTER TABLE message_logs ADD COLUMN device_name TEXT;");
    }

    // Migration check for existing users table
    const userCols = db.pragma('table_info(users)').map(c => c.name);
    if (!userCols.includes('role')) {
        db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin';");
    }
    if (!userCols.includes('is_active')) {
        db.exec("ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1;");
    }

    // Check if default admin user exists
    const adminCheck = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    if (!adminCheck) {
        const defaultHash = bcrypt.hashSync('admin123', 10);
        db.prepare('INSERT INTO users (username, password_hash, role, is_active) VALUES (?, ?, ?, ?)').run('admin', defaultHash, 'admin', 1);
        console.log('[DB] Default admin created: username="admin", password="admin123"');
    } else {
        db.prepare("UPDATE users SET role = 'admin', is_active = 1 WHERE username = 'admin'").run();
    }

    // Check if default API key exists
    const apiKeyCheck = db.prepare('SELECT id FROM api_keys LIMIT 1').get();
    if (!apiKeyCheck) {
        const defaultKey = 'wa_' + require('crypto').randomBytes(16).toString('hex');
        db.prepare('INSERT INTO api_keys (name, key) VALUES (?, ?)').run('Default Key', defaultKey);
        console.log(`[DB] Default API Key created: ${defaultKey}`);
    }
}

initDb();

module.exports = db;
