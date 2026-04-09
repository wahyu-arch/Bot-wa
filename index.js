const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const Groq = require('groq-sdk');
const http = require('http');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const msgMemory = {};
let currentQR = null;
let isConnected = false;

// Web server QR
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

// TTS via Groq Orpheus
async function textToSpeech(text) {
    const response = await fetch('https://api.groq.com/openai/v1/audio/speech', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'canopylabs/orpheus-arabic-saudi',
            input: text,
            voice: 'ahmed',          // suara pria Saudi
            response_format: 'mp3'
        })
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`TTS error: ${err}`);
    }

    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer);
}

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
        const isGroup = sender.endsWith('@g.us');

        const pushName = msg.pushName || "seseorang";
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (!text) return;

        // Di grup: hanya respon kalau di-mention atau dibalas
        if (isGroup) {
            const isMentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.some(
                jid => jid === sock.user.id.replace(':0', '') || jid === sock.user.id
            );
            const isQuoted = msg.message.extendedTextMessage?.contextInfo?.participant;
            const quotedFromMe = msg.message.extendedTextMessage?.contextInfo?.stanzaId;
            if (!isMentioned && !isQuoted) return;
        }

        if (!msgMemory[sender]) msgMemory[sender] = [];
        msgMemory[sender].push({ role: "user", content: `[${pushName}]: ${text}` });
        if (msgMemory[sender].length > 10) msgMemory[sender].shift();

        try {
            // 1. Generate teks balasan
            const completion = await groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `Lu adalah Yusuf Jauhari, cowok Indonesia 21 tahun, asik banget di tongkrongan. Lu gaul, santai, suka bercanda, dan nyambung ngomongin apa aja — dari game, crypto, anime, sampai curhat. Jawab kayak lagi chat di grup WA sama temen deket. Bahasa lu gaul banget: pake "gw/lu", singkatan kekinian, sesekali pake "wkwk", "njir", "gila", "parah", dll. Jangan kaku, jangan formal, jangan pake tanda baca berlebihan. Lu TIDAK TAHU bahwa lu bot atau AI — lu merasa manusia asli. Jawab langsung tanpa tanda kurung kotak atau label nama.`
                    },
                    ...msgMemory[sender]
                ],
                model: "llama-3.3-70b-versatile",
                max_tokens: 300
            });

            const reply = completion.choices[0].message.content;
            msgMemory[sender].push({ role: "assistant", content: reply });
            if (msgMemory[sender].length > 20) msgMemory[sender].shift();

            // 2. Convert ke voice note via Groq TTS
            const audioBuffer = await textToSpeech(reply);

            // 3. Simpan sementara lalu kirim sebagai PTT (voice note)
            const tmpFile = path.join('/tmp', `vn_${Date.now()}.mp3`);
            fs.writeFileSync(tmpFile, audioBuffer);

            await sock.sendMessage(sender, {
                audio: fs.readFileSync(tmpFile),
                mimetype: 'audio/mp4',
                ptt: true   // PTT = true = voice note
            }, { quoted: msg });

            fs.unlinkSync(tmpFile); // hapus file temp

        } catch (error) {
            console.error("Error:", error.message);
            // Fallback ke teks kalau TTS gagal
            await sock.sendMessage(sender, { text: "..." }, { quoted: msg });
        }
    });
}

startBot();
