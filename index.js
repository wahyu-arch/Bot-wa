const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const Groq = require('groq-sdk');
const http = require('http');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
        res.end(`<html><head><meta http-equiv="refresh" content="15">
            <style>body{font-family:sans-serif;text-align:center;padding:30px}</style></head>
            <body><h2>Scan QR ini dengan WhatsApp</h2>
            <img src="${qrImage}" style="width:300px;height:300px"/>
            <p style="color:gray">Halaman otomatis refresh tiap 15 detik</p></body></html>`);
    } catch (e) {
        res.writeHead(500);
        res.end('Error generate QR');
    }
});

server.listen(process.env.PORT || 3000, () => {
    console.log('🌐 Web server aktif');
});

// TTS: teks → WAV → OGG Opus (format yang diterima WA)
async function textToVoiceNote(text) {
    let input = text.trim();
    if (input.length > 200) input = input.substring(0, 197) + '...';

    // 1. Groq TTS → WAV
    const ttsResponse = await groq.audio.speech.create({
        model: 'canopylabs/orpheus-arabic-saudi',
        input,
        voice: 'fahad',
        response_format: 'wav'
    });

    const wavBuffer = Buffer.from(await ttsResponse.arrayBuffer());
    const tmpWav = `/tmp/vn_${Date.now()}.wav`;
    const tmpOgg = tmpWav.replace('.wav', '.ogg');

    fs.writeFileSync(tmpWav, wavBuffer);

    // 2. Convert WAV → OGG Opus pakai ffmpeg
    execSync(`ffmpeg -y -i ${tmpWav} -c:a libopus -b:a 128k ${tmpOgg}`);

    const oggBuffer = fs.readFileSync(tmpOgg);

    // Cleanup
    fs.unlinkSync(tmpWav);
    fs.unlinkSync(tmpOgg);

    return oggBuffer;
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

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`📨 upsert type: ${type}, count: ${messages.length}`);
        const msg = messages[0];
        console.log(`📨 fromMe: ${msg.key.fromMe}, remoteJid: ${msg.key.remoteJid}`);
        console.log(`📨 msgType: ${JSON.stringify(Object.keys(msg.message || {}))}`);

        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        const pushName = msg.pushName || "seseorang";
        const text = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || "";

        console.log(`📨 isGroup: ${isGroup}, text: "${text}"`);

        if (!text) return;

        // Grup: hanya balas kalau di-mention atau reply ke bot
        if (isGroup) {
            const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const isMentioned = mentioned.includes(botJid);
            const isRepliedToBot = msg.message.extendedTextMessage?.contextInfo?.participant === botJid;
            if (!isMentioned && !isRepliedToBot) return;
        }

        console.log(`Pesan dari ${pushName} (${sender}): ${text}`);

        if (!msgMemory[sender]) msgMemory[sender] = [];
        msgMemory[sender].push({ role: "user", content: `[${pushName}]: ${text}` });
        if (msgMemory[sender].length > 10) msgMemory[sender].shift();

        try {
            // 1. Generate teks balasan
            const completion = await groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `Lu adalah Ucup, cowok Indonesia 22 tahun, asik banget di tongkrongan. Lu gaul, santai, suka bercanda, dan nyambung ngomongin apa aja — dari game, crypto, anime, sampai curhat. Bahasa lu gaul: pake gw/lu, singkatan kekinian, sesekali wkwk/njir/gila. Jangan kaku dan formal. PENTING: jawab singkat maksimal 2 kalimat pendek karena akan dijadikan voice note. Lu bukan bot, lu manusia asli. Jawab langsung tanpa label nama.`
                    },
                    ...msgMemory[sender]
                ],
                model: "llama-3.3-70b-versatile",
                max_tokens: 100
            });

            const reply = completion.choices[0].message.content.trim();
            msgMemory[sender].push({ role: "assistant", content: reply });
            if (msgMemory[sender].length > 20) msgMemory[sender].shift();

            console.log(`Balas: ${reply}`);

            // 2. TTS → OGG
            const oggBuffer = await textToVoiceNote(reply);

            // 3. Kirim voice note
            await sock.sendMessage(sender, {
                audio: oggBuffer,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            }, { quoted: msg });

            console.log('✅ Voice note terkirim');

        } catch (error) {
            console.error("❌ Error:", error.message);
        }
    });
}

startBot();
