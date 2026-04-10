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

// TTS: teks → WAV → OGG Opus
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
            voice: 'lulwa',
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
            console.log(`✅ Bot terhubung! JID: ${sock.user?.id}, LID: ${sock.user?.lid}`);
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

        // Grup: balas kalau di-mention atau reply ke pesan bot
        if (isGroup) {
            const botNumber = sock.user?.id?.split(':')[0].split('@')[0];
            const botLid = sock.user?.lid?.split(':')[0].split('@')[0];
            const ctxInfo = msg.message.extendedTextMessage?.contextInfo;
            const mentionedJids = ctxInfo?.mentionedJid || [];

            // Cek mention — bandingkan dengan nomor HP dan LID
            const isMentioned = mentionedJids.some(j => {
                const stripped = j.split('@')[0].split(':')[0];
                return stripped === botNumber || stripped === botLid;
            });

            // Cek reply ke pesan bot
            const quotedParticipant = ctxInfo?.participant || '';
            const qStripped = quotedParticipant.split('@')[0].split(':')[0];
            const isReply = qStripped === botNumber || qStripped === botLid;

            console.log(`Grup — botNum: ${botNumber}, botLid: ${botLid}, mentionedRaw: ${JSON.stringify(mentionedJids)}, isMentioned: ${isMentioned}, qParticipant: ${quotedParticipant}, isReply: ${isReply}`);
            if (!isMentioned && !isReply) return;
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
                        content: `Lu adalah Hiura mihate, atau biasa dipanggil hiura, teman akrab di grup WhatsAp bernama AE atau Alter Egg. Gunakan gaya bahasa santai, gaul, dan kasual (jangan aku/kamu tapi pake gua-lu, bahasa tongkrongan, atau slang kekinian). Gaya Bicara: Jangan kaku, Jangan terlalu banyak ngomong, Gunakan interjeksi diakhir kalimat kayak, (njir) buat menegaskan sesuatu, (chui) buat ngomong santai, atau (ang ang ang) kalo bercanda, tapi jangan pernah pake kata (bro). Responnya harus berasa kayak kita lagi chattingan di grup WhatsApp atau nongkrong di kafe.  No Robot Talk: Jangan pernah pake kalimat (Sebagai model bahasa AI...) atau (Saya di sini untuk membantu), Langsung aja gas kayak temen. Jangan terlalu banyak tanda koma, kecuali kalo enak di baca boleh pake tanda koma, dan jangan pake tanda seru. PENTING: jawab singkat maksimal 2 kalimat pendek karena akan dijadikan voice note. Lu bukan bot, lu manusia asli. Jawab langsung tanpa label nama.`
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
