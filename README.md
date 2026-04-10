# Raka Bot 🤖

Bot WhatsApp dengan persona manusia asli yang waspada terhadap orang asing.

## Setup

### 1. Environment Variable di Railway
```
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxx
```

### 2. Railway Volume (agar sesi tidak hilang saat restart)
- Buat Volume di Railway
- Mount path: `/app/auth_info`

### 3. Scan QR
- Lihat logs Railway saat pertama deploy
- Scan QR yang muncul di logs pakai WA

## Deploy
Push ke GitHub → connect ke Railway → set env var → deploy.
