# Music Sync

Real-time music synchronization app with a TypeScript Node server and React client.

## Prerequisites
- Node.js 18+
- npm 9+

## Setup
```
# In one terminal
cd server
npm install
npm run dev
# Server runs at http://localhost:4000

# In another terminal
cd client
npm install
npm run dev
# Client runs at http://localhost:5173
```

## Configuration
- Client can point to a remote server via env:
```
# client/.env
VITE_SERVER_URL=http://your-server:4000
```
- In development, the client dev server proxies `/socket.io`, `/health`, `/proxy`, `/media`, and `/songs` to `VITE_SERVER_URL`.

## Features
- Create/join rooms with a short code
- Owner-controlled play/pause/seek with synchronized start times
- Drift correction via adaptive playbackRate
- Local song library served from `server/songs` (drop `.mp3`, `.m4a`, `.aac`, `.wav`, `.ogg`, `.flac`, `.webm`)
- Uploads served from `server/uploads`

## Notes
- This project uses in-memory storage. Restarting the server clears rooms/sessions.
- Production deploy should add a reverse proxy (nginx/Caddy) and persistent storage if needed.
