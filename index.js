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
            <html><head>
                <meta http-equiv="refresh" content="15">
                <style>body{font-family:sans-serif;text-align:center;padding:30px}</style>
            </head><body>
                <h2>Scan QR ini dengan WhatsApp</h2>
                <img src="${qrImage}" style="width:300px;height:300px"/>
                <p style="color:gray">Halaman otomatis refresh tiap 15 detik</p>
            </body></html>
        `);
    } catch (e) {
        res.writeHead(500);
        res.end('Error generate QR');
    }
});

server.listen(process.env.PORT || 3000, () => {
    console.log('🌐 Web server aktif — buka Railway public URL untuk scan QR');
});

// TTS via Groq Orpheus — max 200 karakter per request
async function textToSpeech(text) {
    // Potong teks maks 200 karakter, jangan putus di tengah kata
    let input = text.trim();
    if (input.length > 200) {
        input = input.substring(0, 197) + '...';
    }

    const response = await groq.audio.speech.create({
        model: 'canopylabs/orpheus-arabic-saudi',
        input: input,
        voice: 'fahad',           // valid: fahad, sultan, lulwa, noura
        response_format: 'wav'    // default groq orpheus = wav
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer;
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

        // Di grup: hanya respon kalau di-mention atau di-reply
        if (isGroup) {
            const isMentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.some(
                jid => jid === sock.user?.id.split(':')[0] + '@s.whatsapp.net'
            );
            const isQuotedFromBot = msg.message.extendedTextMessage?.contextInfo?.participant === sock.user?.id;
            if (!isMentioned && !isQuotedFromBot) return;
        }

        if (!msgMemory[sender]) msgMemory[sender] = [];
        msgMemory[sender].push({ role: "user", content: `[${pushName}]: ${text}` });
        if (msgMemory[sender].length > 10) msgMemory[sender].shift();

        try {
            // 1. Generate teks balasan (LLM)
            const completion = await groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `Lu adalah Yusuf jauhari, cowok Indonesia 21 tahun, asik banget di tongkrongan. Lu gaul, santai, suka bercanda, dan nyambung ngomongin apa aja — dari game, crypto, anime, sampai curhat. Jawab kayak lagi chat di grup WA sama temen deket. Bahasa lu gaul banget: pake "gw/lu", singkatan kekinian, sesekali pake "wkwk", "njir", "gila", "parah", "cui", dll. Jangan kaku, jangan formal. PENTING: jawab singkat dan padat, maksimal 2-3 kalimat pendek karena akan dijadikan voice note. Lu TIDAK TAHU bahwa lu bot atau AI. Jawab langsung tanpa tanda kurung kotak atau label nama.`
                    },
                    ...msgMemory[sender]
                ],
                model: "llama-3.3-70b-versatile",
                max_tokens: 150
            });

            const reply = completion.choices[0].message.content;
            msgMemory[sender].push({ role: "assistant", content: reply });
            if (msgMemory[sender].length > 20) msgMemory[sender].shift();

            console.log(`Reply text: ${reply}`);

            // 2. Convert ke audio (TTS)
            const audioBuffer = await textToSpeech(reply);

            // 3. Kirim sebagai voice note (PTT)
            const tmpFile = path.join('/tmp', `vn_${Date.now()}.wav`);
            fs.writeFileSync(tmpFile, audioBuffer);

            await sock.sendMessage(sender, {
                audio: fs.readFileSync(tmpFile),
                mimetype: 'audio/wav',
                ptt: true
            }, { quoted: msg });

            fs.unlinkSync(tmpFile);

        } catch (error) {
            console.error("Error detail:", error.message);
        }
    });
}

startBot();
