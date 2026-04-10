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

    const ttsResponse = await fetch('https://api.groq.com/openai/v1/audio/speech', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'canopylabs/orpheus-arabic-saudi',
            input,
            voice: 'sultan',
            response_format: 'wav'
        })
    });

    if (!ttsResponse.ok) {
        const errText = await ttsResponse.text();
        throw new Error(`TTS API error ${ttsResponse.status}: ${errText}`);
    }

    const wavBuffer = Buffer.from(await ttsResponse.arrayBuffer());
    console.log(`🔊 WAV size: ${wavBuffer.length} bytes`);

    const tmpWav = `/tmp/vn_${Date.now()}.wav`;
    const tmpOgg = tmpWav.replace('.wav', '.ogg');
    fs.writeFileSync(tmpWav, wavBuffer);

    // Check ffmpeg tersedia
    try {
        execSync('which ffmpeg');
    } catch(e) {
        console.error('❌ ffmpeg tidak ditemukan!');
        throw new Error('ffmpeg not found');
    }

    execSync(`ffmpeg -y -i ${tmpWav} -c:a libopus -b:a 128k ${tmpOgg} 2>&1`);
    console.log(`🔊 OGG size: ${fs.statSync(tmpOgg).size} bytes`);

    const oggBuffer = fs.readFileSync(tmpOgg);
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

        // Grup: balas kalau ada @mention bot, atau reply ke bot
        if (isGroup) {
            const botNumber = sock.user?.id?.split(':')[0].split('@')[0];
            const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            console.log(`mentionedJids: ${JSON.stringify(mentionedJids)}, botNumber: ${botNumber}`);
            const isMentionedJid = mentionedJids.some(j => j.replace('@lid','').replace('@s.whatsapp.net','') === botNumber);
            const isMentionedInText = botNumber && text.includes(botNumber);
            const isReply = !!msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
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
                        content: `Lu adalah Yusuf jauhari, cowok Indonesia 21 tahun, asik banget di tongkrongan. Lu gaul, santai, suka bercanda, nyambung ngomongin apa aja — game, crypto, anime, curhat. Bahasa lu gaul: gw/lu, singkatan kekinian, wkwk/njir/gila. Setiap ngomong, diakhir kalimat harus ada kata (cui) untuk ngomong biasa atau nyampaikan pendapat dengan santai, dan (njir) untuk menegaskan kalimat. Jangan kaku dan formal. PENTING: jawab singkat maksimal 2 kalimat pendek karena akan dijadikan voice note. Lu bukan bot, lu manusia asli. Jawab langsung tanpa label nama.`
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
