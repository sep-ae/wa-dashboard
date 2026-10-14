const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const db = require('../database/db');
const { normalizePhoneNumber, toWhatsAppJid } = require('../utils/phoneFormatter');

const SESSIONS_BASE_DIR = process.env.SESSION_DIR || path.join(__dirname, '../../sessions');

class WhatsAppManager {
    constructor() {
        this.sessions = new Map(); // deviceId -> { sock, status, qr, name, phoneNumber }
        this.io = null;
    }

    init(io) {
        this.io = io;
        const devices = db.prepare('SELECT * FROM devices').all();
        console.log(`[WA Manager] Found ${devices.length} registered devices in DB. Initializing...`);
        for (const device of devices) {
            this.startSession(device.id, device.name).catch(err => {
                console.error(`[WA Manager] Failed to init device ${device.id}:`, err);
            });
        }
    }

    getDevice(deviceId) {
        return this.sessions.get(deviceId);
    }

    getAllDevices() {
        const dbDevices = db.prepare('SELECT * FROM devices ORDER BY created_at DESC').all();
        return dbDevices.map(d => {
            const live = this.sessions.get(d.id);
            return {
                id: d.id,
                name: d.name,
                phoneNumber: live?.phoneNumber || d.phone_number || null,
                status: live?.status || d.status || 'disconnected',
                qr: live?.qr || null,
                createdAt: d.created_at
            };
        });
    }

    async startSession(deviceId, name = 'WhatsApp Device') {
        if (this.sessions.has(deviceId)) {
            const current = this.sessions.get(deviceId);
            if (current.status === 'connected' || current.status === 'connecting') {
                return current;
            }
        }

        const sessionDir = path.join(SESSIONS_BASE_DIR, deviceId);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        // Upsert into DB
        const existing = db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId);
        if (!existing) {
            db.prepare('INSERT INTO devices (id, name, status) VALUES (?, ?, ?)').run(deviceId, name, 'connecting');
        } else {
            db.prepare('UPDATE devices SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('connecting', deviceId);
        }

        const sessionData = {
            sock: null,
            status: 'connecting',
            qr: null,
            name: name,
            phoneNumber: null
        };
        this.sessions.set(deviceId, sessionData);
        this.emitStatus(deviceId);

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' })
        });

        sessionData.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    const qrDataURL = await qrcode.toDataURL(qr);
                    sessionData.qr = qrDataURL;
                    sessionData.status = 'qr';
                    this.updateDbStatus(deviceId, 'qr');
                    this.emitStatus(deviceId);
                } catch (err) {
                    console.error(`[WA Manager] QR generation error for ${deviceId}:`, err);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[WA Manager] Device ${deviceId} closed. Code: ${statusCode}, Reconnect: ${shouldReconnect}`);

                sessionData.qr = null;
                sessionData.status = 'disconnected';
                this.updateDbStatus(deviceId, 'disconnected');
                this.emitStatus(deviceId);

                if (shouldReconnect) {
                    setTimeout(() => {
                        this.startSession(deviceId, name).catch(console.error);
                    }, 4000);
                } else {
                    console.log(`[WA Manager] Device ${deviceId} logged out. Cleaning up session.`);
                    this.sessions.delete(deviceId);
                    try {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    } catch (e) {}
                    this.emitStatus(deviceId, { deleted: true });
                }
            } else if (connection === 'open') {
                console.log(`[WA Manager] Device ${deviceId} CONNECTED successfully!`);
                const rawId = sock.user?.id || '';
                const phone = rawId.split(':')[0] || rawId.split('@')[0] || '';

                sessionData.status = 'connected';
                sessionData.qr = null;
                sessionData.phoneNumber = phone;

                db.prepare('UPDATE devices SET status = ?, phone_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run('connected', phone, deviceId);

                this.emitStatus(deviceId);
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify' && m.messages && m.messages.length > 0) {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe) {
                        const sender = msg.key.remoteJid ? msg.key.remoteJid.replace('@s.whatsapp.net', '') : '';
                        const text = msg.message?.conversation || 
                                     msg.message?.extendedTextMessage?.text || 
                                     (msg.message?.imageMessage ? '[Image]' : '[Other Media]');

                        if (this.io) {
                            this.io.emit('device_message', {
                                deviceId,
                                deviceName: sessionData.name,
                                sender,
                                text,
                                timestamp: new Date(msg.messageTimestamp * 1000).toLocaleTimeString()
                            });
                        }
                    }
                }
            }
        });

        return sessionData;
    }

    async stopSession(deviceId) {
        const session = this.sessions.get(deviceId);
        if (session && session.sock) {
            try {
                await session.sock.logout();
            } catch (err) {
                try {
                    session.sock.end();
                } catch(e) {}
            }
        }
        this.sessions.delete(deviceId);
        const sessionDir = path.join(SESSIONS_BASE_DIR, deviceId);
        try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) {}

        db.prepare('UPDATE devices SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run('disconnected', deviceId);

        this.emitStatus(deviceId);
    }

    async deleteDevice(deviceId) {
        await this.stopSession(deviceId);
        db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
        if (this.io) {
            this.io.emit('device_deleted', { deviceId });
        }
    }

    getAvailableConnectedDevices(preferredDeviceId = null) {
        const candidates = [];
        
        // If preferredDeviceId is specified and connected, put it first
        if (preferredDeviceId && preferredDeviceId !== 'auto') {
            const pref = this.sessions.get(preferredDeviceId);
            if (pref && pref.status === 'connected' && pref.sock) {
                candidates.push({ id: preferredDeviceId, session: pref });
            }
        }

        // Add all other connected devices
        for (const [id, sess] of this.sessions.entries()) {
            if (id !== preferredDeviceId && sess.status === 'connected' && sess.sock) {
                candidates.push({ id, session: sess });
            }
        }

        return candidates;
    }

    async sendMessage(arg1, arg2, arg3) {
        let preferredDeviceId = null;
        let number = null;
        let message = null;

        if (arg3 !== undefined) {
            preferredDeviceId = arg1;
            number = arg2;
            message = arg3;
        } else {
            number = arg1;
            message = arg2;
        }

        const cleanNumber = normalizePhoneNumber(number);
        if (!cleanNumber) {
            throw new Error('Format nomor tujuan tidak valid. Gunakan format 08..., +62..., atau 628...');
        }
        const jid = toWhatsAppJid(cleanNumber);

        const candidates = this.getAvailableConnectedDevices(preferredDeviceId);
        if (candidates.length === 0) {
            throw new Error('Tidak ada perangkat WhatsApp yang aktif/terhubung saat ini. Silakan hubungkan perangkat terlebih dahulu.');
        }

        const attempts = [];
        let lastError = null;

        for (const candidate of candidates) {
            try {
                // Verify recipient is actually registered on WhatsApp
                let targetJid = jid;
                try {
                    const [waCheck] = await candidate.session.sock.onWhatsApp(cleanNumber);
                    if (!waCheck || !waCheck.exists) {
                        const notRegErr = new Error(`Nomor tujuan (+${cleanNumber}) tidak terdaftar di WhatsApp.`);
                        notRegErr.isNotRegistered = true;
                        throw notRegErr;
                    }
                    if (waCheck.jid) {
                        targetJid = waCheck.jid;
                    }
                } catch (chkErr) {
                    if (chkErr.isNotRegistered) {
                        throw chkErr; // Do not fallback for non-existent WA numbers
                    }
                    console.warn(`[WA Manager] onWhatsApp check error on ${candidate.id}:`, chkErr.message);
                    throw chkErr;
                }

                console.log(`[WA Manager] Sending WhatsApp message to ${cleanNumber} via "${candidate.session.name}" (${candidate.id})...`);
                const res = await candidate.session.sock.sendMessage(targetJid, { text: message });
                
                return {
                    deviceId: candidate.id,
                    deviceName: candidate.session.name || candidate.id,
                    senderNumber: candidate.session.phoneNumber || null,
                    messageId: res?.key?.id,
                    recipient: cleanNumber,
                    status: 'sent',
                    fallbackUsed: attempts.length > 0,
                    attemptedCount: attempts.length + 1
                };
            } catch (err) {
                if (err.isNotRegistered) {
                    throw err; // Number does not exist on WhatsApp at all, stop immediately
                }
                console.warn(`[WA Manager] Device ${candidate.id} failed to send: ${err.message}. Fallback triggered...`);
                attempts.push({ deviceId: candidate.id, error: err.message });
                lastError = err;
            }
        }

        throw new Error(`Semua perangkat WhatsApp (${candidates.length}) gagal mengirim pesan. Error: ${lastError?.message || 'Unknown error'}`);
    }

    async checkNumber(arg1, arg2) {
        let preferredDeviceId = null;
        let number = null;

        if (arg2 !== undefined) {
            preferredDeviceId = arg1;
            number = arg2;
        } else {
            number = arg1;
        }

        const cleanNumber = normalizePhoneNumber(number);
        if (!cleanNumber) {
            throw new Error('Format nomor telepon tidak valid');
        }

        const candidates = this.getAvailableConnectedDevices(preferredDeviceId);
        if (candidates.length === 0) {
            throw new Error('Tidak ada perangkat WhatsApp yang aktif/terhubung untuk memeriksa nomor.');
        }

        const attempts = [];
        let lastError = null;

        for (const candidate of candidates) {
            try {
                const [result] = await candidate.session.sock.onWhatsApp(cleanNumber);
                return {
                    ...(result || { exists: false }),
                    deviceId: candidate.id,
                    deviceName: candidate.session.name || candidate.id,
                    senderNumber: candidate.session.phoneNumber || null
                };
            } catch (err) {
                console.warn(`[WA Manager] Check number failed on ${candidate.id}: ${err.message}. Trying next device...`);
                attempts.push({ deviceId: candidate.id, error: err.message });
                lastError = err;
            }
        }

        throw new Error(`Gagal memeriksa nomor pada semua perangkat (${candidates.length}): ${lastError?.message || 'Unknown error'}`);
    }

    updateDbStatus(deviceId, status) {
        try {
            db.prepare('UPDATE devices SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(status, deviceId);
        } catch (e) {
            console.error(`[DB] Error updating status for ${deviceId}:`, e);
        }
    }

    emitStatus(deviceId, extra = {}) {
        if (!this.io) return;
        const session = this.sessions.get(deviceId);
        const payload = {
            deviceId,
            name: session?.name || '',
            status: session?.status || 'disconnected',
            qr: session?.qr || null,
            phoneNumber: session?.phoneNumber || null,
            ...extra
        };
        this.io.emit('device_status', payload);
    }
}

const manager = new WhatsAppManager();
module.exports = manager;
