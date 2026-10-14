const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const db = require('./database/db');
const waManager = require('./services/whatsappManager');
const { requireAuth, requireAdmin, requireApiKey } = require('./middleware/auth');
const { normalizePhoneNumber } = require('./utils/phoneFormatter');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Trust proxy for accurate client IP detection
app.set('trust proxy', true);

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files & body parsers
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session setup
app.use(session({
    secret: process.env.SESSION_SECRET || 'wa-gateway-session-secret-key-9821371',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
}));

// Global view variables (active user)
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================
app.get('/login', (req, res) => {
    if (req.session && req.session.user) {
        return res.redirect('/devices');
    }
    res.render('login', { title: 'Sign In - WA Gateway', error: req.query.error || null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.render('login', { title: 'Sign In - WA Gateway', error: 'Please enter both username and password' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.render('login', { title: 'Sign In - WA Gateway', error: 'Invalid username or password' });
    }

    if (user.is_active === 0) {
        return res.render('login', { 
            title: 'Sign In - WA Gateway', 
            error: 'Akun Anda telah dinonaktifkan oleh Administrator. Silakan hubungi admin.' 
        });
    }

    req.session.user = { id: user.id, username: user.username, role: user.role || 'admin' };
    res.redirect('/devices');
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// ==========================================
// DASHBOARD VIEWS (Protected)
// ==========================================
app.get('/', (req, res) => {
    res.redirect('/devices');
});

// Dashboard 1: Device Management
app.get('/devices', requireAuth, (req, res) => {
    const devices = waManager.getAllDevices();
    res.render('devices', {
        title: 'Devices - WA Gateway',
        activePage: 'devices',
        devices
    });
});

// Dashboard 2: Message & Activity Logs
app.get('/logs', requireAuth, (req, res) => {
    const logs = db.prepare(`
        SELECT l.*, k.name as api_key_name 
        FROM message_logs l
        LEFT JOIN api_keys k ON l.api_key_id = k.id
        ORDER BY l.id DESC
        LIMIT 150
    `).all();

    const stats = {
        total: db.prepare('SELECT COUNT(*) as count FROM message_logs').get().count,
        success: db.prepare("SELECT COUNT(*) as count FROM message_logs WHERE status = 'SUCCESS'").get().count,
        failed: db.prepare("SELECT COUNT(*) as count FROM message_logs WHERE status = 'FAILED'").get().count
    };

    res.render('logs', {
        title: 'Logs - WA Gateway',
        activePage: 'logs',
        logs,
        stats
    });
});

// API Keys Management View
app.get('/api-keys', requireAuth, (req, res) => {
    const keys = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all();
    res.render('api_keys', {
        title: 'API Keys - WA Gateway',
        activePage: 'api-keys',
        keys
    });
});

// User Management View (Admin Only)
app.get('/users', requireAuth, requireAdmin, (req, res) => {
    const users = db.prepare('SELECT id, username, role, is_active, created_at FROM users ORDER BY id ASC').all();
    res.render('users', {
        title: 'User Management - WA Gateway',
        activePage: 'users',
        users
    });
});

// ==========================================
// USER MANAGEMENT ACTIONS (Admin Only)
// ==========================================
app.post('/api/users/create', requireAuth, requireAdmin, (req, res) => {
    try {
        const { username, password, role } = req.body;
        if (!username || !password) {
            return res.status(400).json({ status: false, message: 'Username dan password wajib diisi.' });
        }

        const cleanUsername = username.trim().toLowerCase();
        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
        if (existing) {
            return res.status(400).json({ status: false, message: 'Username sudah digunakan, silakan pilih username lain.' });
        }

        const validRole = role === 'admin' ? 'admin' : 'operator';
        const hash = bcrypt.hashSync(password, 10);
        const info = db.prepare('INSERT INTO users (username, password_hash, role, is_active) VALUES (?, ?, ?, 1)')
            .run(cleanUsername, hash, validRole);

        res.json({ status: true, userId: info.lastInsertRowid, message: 'User berhasil dibuat.' });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

app.post('/api/users/:id/toggle', requireAuth, requireAdmin, (req, res) => {
    try {
        const targetId = parseInt(req.params.id);
        if (targetId === req.session.user.id) {
            return res.status(400).json({ status: false, message: 'Anda tidak dapat menonaktifkan akun Anda sendiri.' });
        }

        const user = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(targetId);
        if (!user) {
            return res.status(404).json({ status: false, message: 'User tidak ditemukan.' });
        }

        const newStatus = user.is_active === 1 ? 0 : 1;
        db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(newStatus, targetId);

        res.json({ status: true, message: 'Status user berhasil diperbarui.' });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    try {
        const targetId = parseInt(req.params.id);
        if (targetId === req.session.user.id) {
            return res.status(400).json({ status: false, message: 'Anda tidak dapat menghapus akun Anda sendiri.' });
        }

        db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
        res.json({ status: true, message: 'User berhasil dihapus.' });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// Change own username / password
app.post('/api/users/change-password', requireAuth, (req, res) => {
    try {
        const { currentPassword, newPassword, newUsername } = req.body;
        const userId = req.session.user.id;

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ status: false, message: 'User tidak ditemukan.' });
        }

        if (currentPassword) {
            const isMatch = bcrypt.compareSync(currentPassword, user.password_hash);
            if (!isMatch) {
                return res.status(400).json({ status: false, message: 'Password lama / saat ini salah.' });
            }
        }

        let cleanUsername = user.username;
        if (newUsername && newUsername.trim() !== '') {
            cleanUsername = newUsername.trim().toLowerCase();
            if (cleanUsername !== user.username) {
                const exist = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(cleanUsername, userId);
                if (exist) {
                    return res.status(400).json({ status: false, message: 'Username sudah digunakan oleh akun lain.' });
                }
            }
        }

        if (newPassword && newPassword.trim() !== '') {
            if (newPassword.trim().length < 5) {
                return res.status(400).json({ status: false, message: 'Password baru minimal 5 karakter.' });
            }
            const newHash = bcrypt.hashSync(newPassword.trim(), 10);
            db.prepare('UPDATE users SET username = ?, password_hash = ? WHERE id = ?').run(cleanUsername, newHash, userId);
        } else {
            db.prepare('UPDATE users SET username = ? WHERE id = ?').run(cleanUsername, userId);
        }

        req.session.user.username = cleanUsername;
        res.json({ status: true, message: 'Akun berhasil diperbarui.' });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// Admin resets another user's password
app.post('/api/users/:id/reset-password', requireAuth, requireAdmin, (req, res) => {
    try {
        const targetId = parseInt(req.params.id);
        const { newPassword } = req.body;

        if (!newPassword || newPassword.trim().length < 5) {
            return res.status(400).json({ status: false, message: 'Password baru minimal 5 karakter.' });
        }

        const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId);
        if (!user) {
            return res.status(404).json({ status: false, message: 'User tidak ditemukan.' });
        }

        const newHash = bcrypt.hashSync(newPassword.trim(), 10);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, targetId);

        res.json({ status: true, message: `Password untuk user ${user.username} berhasil diperbarui.` });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// ==========================================
// DASHBOARD INTERNAL ACTIONS (Protected)
// ==========================================

// Create new device
app.post('/api/devices/create', requireAuth, async (req, res) => {
    try {
        const { name } = req.body;
        let { deviceId } = req.body;

        if (!name) {
            return res.status(400).json({ status: false, message: 'Device name is required' });
        }

        if (!deviceId || deviceId.trim() === '') {
            deviceId = 'dev_' + crypto.randomBytes(4).toString('hex');
        } else {
            deviceId = deviceId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        }

        // Start session
        await waManager.startSession(deviceId, name);
        res.json({ status: true, deviceId, message: 'Device created and session initialized' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: false, message: err.message });
    }
});

// Restart device session
app.post('/api/devices/:id/restart', requireAuth, async (req, res) => {
    try {
        const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
        if (!device) return res.status(404).json({ status: false, message: 'Device not found' });

        await waManager.startSession(device.id, device.name);
        res.json({ status: true, message: 'Session restart initiated' });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// Logout device
app.post('/api/devices/:id/logout', requireAuth, async (req, res) => {
    try {
        await waManager.stopSession(req.params.id);
        res.json({ status: true, message: 'Device logged out successfully' });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// Delete device
app.delete('/api/devices/:id', requireAuth, async (req, res) => {
    try {
        await waManager.deleteDevice(req.params.id);
        res.json({ status: true, message: 'Device removed successfully' });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// Create API Key
app.post('/api/api-keys/create', requireAuth, (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ status: false, message: 'Key label/name is required' });

        const key = 'wa_' + crypto.randomBytes(16).toString('hex');
        db.prepare('INSERT INTO api_keys (name, key) VALUES (?, ?)').run(name, key);
        res.json({ status: true, key, message: 'API Key generated successfully' });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// Toggle API Key status
app.post('/api/api-keys/:id/toggle', requireAuth, (req, res) => {
    try {
        const key = db.prepare('SELECT is_active FROM api_keys WHERE id = ?').get(req.params.id);
        if (!key) return res.status(404).json({ status: false, message: 'Key not found' });

        const newStatus = key.is_active ? 0 : 1;
        db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ?').run(newStatus, req.params.id);
        res.json({ status: true, message: 'Key status updated' });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// Delete API Key
app.delete('/api/api-keys/:id', requireAuth, (req, res) => {
    try {
        db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
        res.json({ status: true, message: 'API key deleted' });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// ==========================================
// EXTERNAL / PUBLIC API v1 (API Key Protected)
// ==========================================

// Send Message Endpoint with IP & Status Logging
const handleSendMessage = async (req, res) => {
    const clientIp = (req.headers['x-forwarded-for']?.split(',')[0].trim()) || 
                     req.socket.remoteAddress || 
                     req.ip || 
                     '127.0.0.1';

    const { deviceId, number, message } = req.body;
    const apiKeyId = req.apiKey?.id || null;
    const targetNumber = normalizePhoneNumber(number);

    if (!targetNumber || !message) {
        // Record failed attempt
        try {
            db.prepare(`
                INSERT INTO message_logs (device_id, device_name, sender_number, api_key_id, recipient, message, ip_address, status, error_message)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(deviceId || null, null, null, apiKeyId, targetNumber || number || 'N/A', message || '', clientIp, 'FAILED', 'Nomor tujuan atau pesan tidak boleh kosong');
        } catch(e) {}

        return res.status(400).json({ 
            status: false, 
            message: 'Nomor tujuan (misal: 0812... atau 628...) dan pesan wajib diisi.' 
        });
    }

    try {
        const result = await waManager.sendMessage(deviceId || null, targetNumber, message);

        // Record SUCCESS in message_logs with device_id, device_name, and sender_number
        db.prepare(`
            INSERT INTO message_logs (device_id, device_name, sender_number, api_key_id, recipient, message, ip_address, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(result.deviceId, result.deviceName, result.senderNumber, apiKeyId, targetNumber, message, clientIp, 'SUCCESS');

        res.json({
            status: true,
            message: 'Message dispatched successfully',
            data: {
                recipient: targetNumber,
                senderNumber: result.senderNumber,
                deviceId: result.deviceId,
                deviceName: result.deviceName,
                fallbackUsed: result.fallbackUsed,
                messageId: result.messageId
            }
        });
    } catch (err) {
        console.error('[API Send Error]', err.message);

        // Record FAILED in message_logs
        db.prepare(`
            INSERT INTO message_logs (device_id, device_name, sender_number, api_key_id, recipient, message, ip_address, status, error_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(deviceId || null, null, null, apiKeyId, targetNumber || number, message, clientIp, 'FAILED', err.message);

        const statusCode = err.isNotRegistered ? 400 : 500;
        res.status(statusCode).json({
            status: false,
            message: err.message
        });
    }
};

app.post('/api/v1/send', requireApiKey, handleSendMessage);
app.post('/api/send', requireApiKey, handleSendMessage); // Backward compatibility

// Check Number Endpoint
app.post('/api/v1/check-number', requireApiKey, async (req, res) => {
    try {
        const { deviceId, number } = req.body;
        if (!number) return res.status(400).json({ status: false, message: 'Harap sertakan parameter number' });

        const result = await waManager.checkNumber(deviceId || null, number);
        if (result && result.exists) {
            res.json({ 
                status: true, 
                exists: true, 
                jid: result.jid, 
                senderNumber: result.senderNumber,
                deviceId: result.deviceId,
                deviceName: result.deviceName,
                message: 'Number is registered on WhatsApp' 
            });
        } else {
            res.json({ 
                status: true, 
                exists: false, 
                senderNumber: result?.senderNumber || null,
                deviceId: result?.deviceId || null,
                deviceName: result?.deviceName || null,
                message: 'Number is NOT registered on WhatsApp' 
            });
        }
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// List Devices Endpoint
app.get('/api/v1/devices', requireApiKey, (req, res) => {
    const devices = waManager.getAllDevices();
    res.json({ status: true, data: devices });
});

// ==========================================
// SOCKET.IO & INITIALIZATION
// ==========================================
io.on('connection', (socket) => {
    // Send current status of all devices on connection
    const devices = waManager.getAllDevices();
    devices.forEach(device => {
        socket.emit('device_status', {
            deviceId: device.id,
            name: device.name,
            status: device.status,
            qr: device.qr,
            phoneNumber: device.phoneNumber
        });
    });
});

// Initialize WhatsApp Manager with socket.io
waManager.init(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n=================================================`);
    console.log(`[WA Gateway Server] Running at: http://localhost:${PORT}`);
    console.log(`[Default Admin] Username: "admin" | Password: "admin123"`);
    console.log(`=================================================\n`);
});
