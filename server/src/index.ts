import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import multer, { diskStorage } from 'multer';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  path: '/socket.io',
  transports: ['polling', 'websocket'],
  allowEIO3: true,
  cors: {
    origin: (origin, cb) => cb(null, true),
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }
});

app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: false, methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors({ origin: (origin, cb) => cb(null, true) }));
app.use(express.json());

// In-memory storage
const users = new Map<string, { username: string }>();
const rooms = new Map<string, { ownerId: string; participants: string[] }>();
const playbackStates = new Map<string, {
  isPlaying: boolean;
  positionSec: number;
  trackUrl: string;
  startTime: number;
  lastUpdate: number;
}>();

// Local uploads storage
const uploadRoot = join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadRoot)) {
  fs.mkdirSync(uploadRoot, { recursive: true });
}

// Local songs library storage
const songsRoot = join(process.cwd(), 'songs');
if (!fs.existsSync(songsRoot)) {
  fs.mkdirSync(songsRoot, { recursive: true });
}

const storage = diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadRoot),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
    cb(null, unique);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.use('/media', express.static(uploadRoot, {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

// List songs in the library
app.get('/songs/list', (_req, res) => {
  try {
    const allowed = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac', '.webm']);
    const files = fs.readdirSync(songsRoot, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((name) => allowed.has(extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    const songs = files.map((name) => ({ name, url: `/songs/${encodeURIComponent(name)}` }));
    res.json({ ok: true, songs });
  } catch (e) {
    console.error('Songs list error:', e);
    res.json({ ok: true, songs: [] });
  }
});

// Serve songs from local library
app.use('/songs', express.static(songsRoot, {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

app.post('/upload', upload.single('file'), (req, res) => {
  try {
    const file = (req as any).file as { filename: string; originalname: string } | undefined
    if (!file) {
      return res.status(400).json({ ok: false, reason: 'No file uploaded' });
    }
    const urlPath = `/media/${file.filename}`;
    res.json({ ok: true, url: urlPath, filename: file.originalname });
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ ok: false, reason: 'Upload failed' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// CORS proxy for external audio URLs
app.get('/proxy', async (req, res) => {
  const url = req.query.url as string;
  if (!url) {
    return res.status(400).json({ error: 'URL parameter required' });
  }

  try {
    const forwardHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    };
    const range = req.header('range');
    if (range) forwardHeaders['Range'] = range;

    const response = await fetch(url, { headers: forwardHeaders, method: 'GET' });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch audio' });
    }

    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    const contentLength = response.headers.get('content-length') || undefined;
    const contentRange = response.headers.get('content-range') || undefined;
    const acceptRanges = response.headers.get('accept-ranges') || 'bytes';

    res.status(response.status);
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Accept-Ranges': acceptRanges,
      'Cache-Control': 'public, max-age=3600',
      'Content-Type': contentType,
    });
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (contentRange) res.setHeader('Content-Range', contentRange);

    if (response.body) {
      response.body.pipeTo(new WritableStream({
        write(chunk) {
          res.write(chunk);
        },
        close() {
          res.end();
        }
      })).catch(error => {
        console.error('Streaming error:', error);
        res.end();
      });
    } else {
      res.end();
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Proxy failed' });
  }
});

// Disable legacy auth routes
app.use('/auth', (_req, res) => {
  res.status(404).json({ ok: false, reason: 'Auth is disabled' });
});

// Helper function to get current playback position
function getCurrentPositionSec(roomId: string): number {
  const state = playbackStates.get(roomId);
  if (!state) return 0;
  
  if (!state.isPlaying) return state.positionSec;
  
  const elapsed = (Date.now() - state.startTime) / 1000;
  return state.positionSec + elapsed;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  let currentUser: string | null = null;
  let currentRoom: string | null = null;

  // Set display name (no auth)
  socket.on('user:setName', (name: string, callback?: (r: any) => void) => {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      callback?.({ ok: false, reason: 'Name required' });
      return;
    }
    currentUser = trimmed.slice(0, 32);
    socket.emit('user:ready', { username: currentUser });
    callback?.({ ok: true, username: currentUser });
    console.log('User set name:', currentUser);
  });

  // Create a new room
  socket.on('room:create', (callback) => {
    if (!currentUser) {
      callback({ ok: false, reason: 'Not authenticated' });
      return;
    }
    
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms.set(roomId, { ownerId: currentUser!, participants: [currentUser!] });
    currentRoom = roomId;
    
    socket.join(roomId);
    // Inform creator about room info
    io.to(roomId).emit('room:info', {
      roomId,
      ownerName: currentUser,
      participants: rooms.get(roomId)?.participants ?? [currentUser]
    });
    callback({ ok: true, roomId, ownerName: currentUser });
    console.log('Room created:', roomId, 'by:', currentUser);
  });

  // Join an existing room
  socket.on('room:join', (roomId: string, callback) => {
    if (!currentUser) {
      callback({ ok: false, reason: 'Not authenticated' });
      return;
    }
    
    const room = rooms.get(roomId);
    if (!room) {
      callback({ ok: false, reason: 'Room not found' });
      return;
    }
    
    if (!room.participants.includes(currentUser!)) {
      room.participants.push(currentUser!);
    }
    currentRoom = roomId;
    
    socket.join(roomId);
    
    // Send current playback state to the joining user
    const playbackState = playbackStates.get(roomId);
    if (playbackState) {
      const currentPosition = getCurrentPositionSec(roomId);
      socket.emit('state:init', {
        trackUrl: playbackState.trackUrl,
        isPlaying: playbackState.isPlaying,
        positionSec: currentPosition,
        startTimeMs: playbackState.isPlaying ? playbackState.startTime : null,
        serverNowMs: Date.now()
      });
    }
    
    // Send room info to all clients in the room
    io.to(roomId).emit('room:info', {
      roomId,
      ownerName: room.ownerId,
      participants: room.participants
    });
    
    callback({ ok: true, roomId, ownerName: room.ownerId });
    console.log('User joined room:', roomId, 'user:', currentUser);
  });

  // Time synchronization
  // Client emits: socket.emit('timesync:ping', clientSendMs)
  // Server responds by emitting a corresponding 'timesync:pong'
  socket.on('timesync:ping', (clientSendMs: number) => {
    // Guard against older clients that might send a callback instead
    if (typeof clientSendMs === 'function') {
      // @ts-expect-error runtime guard for legacy signature
      try { clientSendMs(Date.now()); } catch {}
      return;
    }
    socket.emit('timesync:pong', {
      serverNowMs: Date.now(),
      clientSendMs: typeof clientSendMs === 'number' ? clientSendMs : Date.now(),
    });
  });

  // Load track
  socket.on('control:load', (data: { roomId: string; trackUrl: string }) => {
    const { roomId, trackUrl } = data;
    if (!roomId || !trackUrl) return;
    
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.ownerId !== currentUser) {
      socket.emit('control:denied', { reason: 'Only the room owner can load tracks' });
      return;
    }
    
    playbackStates.set(roomId, {
      isPlaying: false,
      positionSec: 0,
      trackUrl,
      startTime: Date.now(),
      lastUpdate: Date.now()
    });
    
    // Send to all clients in the room including sender
    io.to(roomId).emit('state:update', {
      trackUrl,
      isPlaying: false,
      positionSec: 0,
      serverNowMs: Date.now()
    });
    console.log('Track loaded in room:', roomId, 'by:', currentUser);
  });

  // Play control
  socket.on('control:play', (data: { roomId: string }) => {
    const { roomId } = data;
    if (!roomId) return;
    
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.ownerId !== currentUser) {
      socket.emit('control:denied', { reason: 'Only the room owner can play/pause' });
      return;
    }
    
    const state = playbackStates.get(roomId);
    if (!state) return;
    
    const startDelayMs = 1500; // 1.5 second delay for sync
    const plannedStartAtMs = Date.now() + startDelayMs;
    
    state.isPlaying = true;
    state.startTime = plannedStartAtMs;
    state.lastUpdate = Date.now();
    
    // Send to all clients in the room including sender
    io.to(roomId).emit('play', {
      trackUrl: state.trackUrl,
      positionSec: state.positionSec,
      startAtServerMs: plannedStartAtMs
    });
    console.log('Play in room:', roomId, 'by:', currentUser);
  });

  // Pause control
  socket.on('control:pause', (data: { roomId: string }) => {
    const { roomId } = data;
    if (!roomId) return;
    
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.ownerId !== currentUser) {
      socket.emit('control:denied', { reason: 'Only the room owner can play/pause' });
      return;
    }
    
    const state = playbackStates.get(roomId);
    if (!state) return;
    
    const currentPosition = getCurrentPositionSec(roomId);
    state.isPlaying = false;
    state.positionSec = currentPosition;
    state.lastUpdate = Date.now();
    
    // Send to all clients in the room including sender
    io.to(roomId).emit('pause', {
      positionSec: currentPosition,
      serverNowMs: Date.now()
    });
    console.log('Pause in room:', roomId, 'by:', currentUser);
  });

  // Seek control
  socket.on('control:seek', (data: { roomId: string; positionSec: number }) => {
    const { roomId, positionSec } = data;
    if (!roomId || typeof positionSec !== 'number') return;
    
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.ownerId !== currentUser) {
      socket.emit('control:denied', { reason: 'Only the room owner can seek' });
      return;
    }
    
    const state = playbackStates.get(roomId);
    if (!state) return;
    
    state.positionSec = positionSec;
    state.lastUpdate = Date.now();
    
    if (state.isPlaying) {
      // If playing, schedule a new start time
      const startDelayMs = 1000; // 1 second delay for seek
      const plannedStartAtMs = Date.now() + startDelayMs;
      state.startTime = plannedStartAtMs;
      
      io.to(roomId).emit('seek', {
        positionSec,
        startAtServerMs: plannedStartAtMs
      });
    } else {
      // If paused, just update position
      io.to(roomId).emit('seek', {
        positionSec,
        startAtServerMs: null
      });
    }
    console.log('Seek in room:', roomId, 'by:', currentUser, 'to:', positionSec);
  });

  // Get current playback state
  socket.on('playback:getState', (callback) => {
    if (!currentRoom) {
      callback(null);
      return;
    }
    
    const state = playbackStates.get(currentRoom);
    if (!state) {
      callback(null);
      return;
    }
    
    callback({
      isPlaying: state.isPlaying,
      positionSec: getCurrentPositionSec(currentRoom),
      trackUrl: state.trackUrl
    });
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    if (currentRoom && currentUser) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.participants = room.participants.filter(p => p !== currentUser);
        
        // If owner left, transfer ownership or delete room
        if (room.ownerId === currentUser) {
          if (room.participants.length > 0) {
            room.ownerId = room.participants[0];
            io.to(currentRoom).emit('room:ownerChanged', room.ownerId);
          } else {
            rooms.delete(currentRoom);
            playbackStates.delete(currentRoom);
          }
        }
      }
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
