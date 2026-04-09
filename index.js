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

async function textToVoiceNote(text) {
    let input = text.trim();
    if (input.length > 200) input = input.substring(0, 197) + '...';

    console.log(`🔊 TTS input: "${input}"`);

    // ElevenLabs TTS - voice "Putra"
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'putra'; // Set voice ID di env atau ganti manual

    const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
        method: 'POST',
        headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
            text: input,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75
            }
        })
    });

    if (!ttsResponse.ok) {
        const errText = await ttsResponse.text();
        throw new Error(`ElevenLabs TTS error: ${ttsResponse.status} - ${errText}`);
    }

    const mp3Buffer = Buffer.from(await ttsResponse.arrayBuffer());
    console.log(`🔊 MP3 size: ${mp3Buffer.length} bytes`);

    const tmpMp3 = `/tmp/vn_${Date.now()}.mp3`;
    const tmpOgg = tmpMp3.replace('.mp3', '.ogg');
    fs.writeFileSync(tmpMp3, mp3Buffer);

    // Check ffmpeg tersedia
    try {
        execSync('which ffmpeg');
    } catch(e) {
        console.error('❌ ffmpeg tidak ditemukan!');
        throw new Error('ffmpeg not found');
    }

    execSync(`ffmpeg -y -i ${tmpMp3} -c:a libopus -b:a 128k ${tmpOgg} 2>&1`);
    console.log(`🔊 OGG size: ${fs.statSync(tmpOgg).size} bytes`);

    const oggBuffer = fs.readFileSync(tmpOgg);
    fs.unlinkSync(tmpMp3);
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
            console.log('QR baru tersedia');
        }
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            console.log('✅ Bot terhubung! JID:', sock.user?.id);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        const pushName = msg.pushName || "seseorang";
        const text = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || "";

        if (!text) return;

        // Grup: balas kalau ada @mention angka bot di teks, atau reply ke bot
        if (isGroup) {
            const botNumber = sock.user?.id?.split(':')[0].split('@')[0]; // angka saja
            const isMentionedInText = botNumber && text.includes(botNumber);
            const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const isMentionedJid = mentionedJids.some(j => j.includes(botNumber));
            const isReply = !!msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

            console.log(`Grup check — botNumber: ${botNumber}, inText: ${isMentionedInText}, inJid: ${isMentionedJid}, isReply: ${isReply}`);

            if (!isMentionedInText && !isMentionedJid && !isReply) return;
        }

        console.log(`Pesan dari ${pushName}: ${text}`);

        if (!msgMemory[sender]) msgMemory[sender] = [];
        msgMemory[sender].push({ role: "user", content: `[${pushName}]: ${text}` });
        if (msgMemory[sender].length > 10) msgMemory[sender].shift();

        try {
            const completion = await groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `Lu adalah Ucup, cowok Indonesia 22 tahun, asik banget di tongkrongan. Lu gaul, santai, suka bercanda, nyambung ngomongin apa aja — game, crypto, anime, curhat. Bahasa lu gaul: gw/lu, singkatan kekinian, wkwk/njir/gila. Jangan kaku dan formal. PENTING: jawab singkat maksimal 2 kalimat pendek karena akan dijadikan voice note. Lu bukan bot, lu manusia asli. Jawab langsung tanpa label nama.`
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

            console.log(`🔊 Mulai TTS...`);
            const oggBuffer = await textToVoiceNote(reply);
            console.log(`🔊 OGG size: ${oggBuffer.length} bytes`);

            await sock.sendMessage(sender, {
                audio: oggBuffer,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            }, { quoted: msg });

            console.log('✅ Voice note terkirim');

        } catch (error) {
            console.error("❌ Error:", error.message);
            console.error(error.stack);
        }
    });
}

startBot();
