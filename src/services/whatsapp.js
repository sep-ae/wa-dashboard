const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');

async function startWhatsApp(io) {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, '../../sessions'));

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    global.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection) {
            global.waStatus = { status: connection };
        }

        if (qr) {
            try {
                const qrDataURL = await qrcode.toDataURL(qr);
                global.waStatus = { status: 'qr', qr: qrDataURL };
                io.emit('wa_status', global.waStatus);
            } catch (err) {
                console.error('Failed to generate QR code', err);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to', lastDisconnect.error, ', reconnecting:', shouldReconnect);
            
            global.waStatus = { status: 'disconnected', reason: lastDisconnect.error?.message };
            io.emit('wa_status', global.waStatus);

            if (shouldReconnect) {
                startWhatsApp(io);
            } else {
                console.log('Logged out. Restarting WhatsApp to generate new QR...');
                // Delete session folder to ensure clean state
                try {
                    const fs = require('fs');
                    fs.rmSync(path.join(__dirname, '../../sessions'), { recursive: true, force: true });
                } catch(e) {}
                setTimeout(() => startWhatsApp(io), 2000);
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connected!');
            global.waStatus = { status: 'connected' };
            io.emit('wa_status', global.waStatus);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        console.log(JSON.stringify(m, undefined, 2));
        io.emit('wa_message', m);
    });
}

module.exports = { startWhatsApp };
