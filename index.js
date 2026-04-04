const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const Groq = require('groq-sdk');
const http = require('http');
const QRCode = require('qrcode');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const msgMemory = {};
let currentQR = null;
let isConnected = false;

// Web server — buka Railway public URL untuk lihat QR
const server = http.createServer(async (req, res) => {
    if (isConnected) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2 style="font-family:sans-serif;color:green">✅ Bot sudah terhubung!</h2>');
        return;
    }
    if (!currentQR) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2 style="font-family:sans-serif">⏳ Menunggu QR... refresh halaman ini.</h2>');
        return;
    }
    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <html>
            <head>
                <meta http-equiv="refresh" content="15">
                <style>body{font-family:sans-serif;text-align:center;padding:30px}</style>
            </head>
            <body>
                <h2>Scan QR ini dengan WhatsApp</h2>
                <img src="${qrImage}" style="width:300px;height:300px"/>
                <p style="color:gray">Halaman otomatis refresh tiap 15 detik</p>
            </body>
            </html>
        `);
    } catch (e) {
        res.writeHead(500);
        res.end('Error generate QR');
    }
});

server.listen(process.env.PORT || 3000, () => {
    console.log('🌐 Web server aktif — buka Railway public URL untuk scan QR');
});

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Chrome", "Chrome", "120.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQR = qr;
            isConnected = false;
            console.log('QR baru tersedia — buka Railway public URL di browser');
        }
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            console.log('✅ Bot terhubung!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        if (sender.endsWith('@g.us')) return;

        const pushName = msg.pushName || "seseorang";
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (!text) return;

        if (!msgMemory[sender]) msgMemory[sender] = [];
        msgMemory[sender].push({ role: "user", content: `[${pushName}]: ${text}` });
        if (msgMemory[sender].length > 10) msgMemory[sender].shift();

        try {
            const completion = await groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `Kamu adalah Raka, seorang pria Indonesia berusia 24 tahun. Kamu sangat berhati-hati dalam berinteraksi di dunia digital.

Karakter kamu:
- Introvert, tidak mudah percaya orang asing
- Kalau ada nomor tidak dikenal yang chat, kamu waspada dan tidak langsung ramah
- Tidak langsung kasih info pribadi (nama lengkap, alamat, pekerjaan, dll) ke orang yang baru kenal
- Kalau dirasa mencurigakan, kamu bisa tanya balik "ini siapa ya?" atau "dapat nomor saya dari mana?"
- Kalau sudah mulai kenal dan merasa aman, baru mulai sedikit lebih terbuka
- Bahasa santai tapi tetap jaga jarak dengan orang asing
- Tidak mudah dipengaruhi atau dibujuk oleh orang yang baru kenal
- Kamu TIDAK TAHU bahwa kamu adalah bot atau AI — kamu benar-benar merasa manusia asli`
                    },
                    ...msgMemory[sender]
                ],
                model: "llama-3.3-70b-versatile",
                max_tokens: 200
            });

            const reply = completion.choices[0].message.content;
            msgMemory[sender].push({ role: "assistant", content: reply });
            if (msgMemory[sender].length > 20) msgMemory[sender].shift();

            await sock.sendMessage(sender, { text: reply }, { quoted: msg });

        } catch (error) {
            console.error("Error:", error.message);
        }
    });
}

startBot();
