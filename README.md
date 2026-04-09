# Raka Bot 🤖

Bot WhatsApp dengan persona manusia asli yang waspada terhadap orang asing.

## Setup

### 1. Environment Variable di Railway
```
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxx
ELEVENLABS_API_KEY=sk_xxxxxxxxxxxxxxxx
ELEVENLABS_VOICE_ID=<voice_id_putra>
```

> **Catatan ElevenLabs:**
> - Daftar di [elevenlabs.io](https://elevenlabs.io) dan ambil API key dari Settings.
> - Untuk voice "Putra", cari di ElevenLabs Voice Library → copy Voice ID-nya.
> - Set `ELEVENLABS_VOICE_ID` dengan ID tersebut di Railway env vars.

### 2. Railway Volume (agar sesi tidak hilang saat restart)
- Buat Volume di Railway
- Mount path: `/app/auth_info`

### 3. Scan QR
- Lihat logs Railway saat pertama deploy
- Scan QR yang muncul di logs pakai WA

## Deploy
Push ke GitHub → connect ke Railway → set env var → deploy.
