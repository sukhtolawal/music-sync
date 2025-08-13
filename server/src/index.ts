import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import multer, { diskStorage } from 'multer';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { Readable } from 'stream';

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

app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: false, methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','Range'] }));
app.options('*', cors({ origin: (origin, cb) => cb(null, true) }));
app.use(express.json());

// In-memory storage
const users = new Map<string, { username: string }>();
const rooms = new Map<string, { ownerId: string; participants: string[] }>();
const sessions = new Map<string, { username?: string; roomId?: string }>();
const playbackStates = new Map<string, {
  isPlaying: boolean;
  positionSec: number;
  trackUrl: string;
  startTime: number;
  lastUpdate: number;
}>();

// Per-room chat history (in-memory)
const chatHistory = new Map<string, Array<{ id: string; user: string; text: string; timeMs: number }>>();

// Per-room playback queue (in-memory)
export type QueueItem = { id: string; url: string; name: string; addedBy: string; addedAt: number }
const queues = new Map<string, QueueItem[]>();

function getQueue(roomId: string): QueueItem[] {
  const q = queues.get(roomId)
  if (!q) { const arr: QueueItem[] = []; queues.set(roomId, arr); return arr }
  return q
}
function broadcastQueue(roomId: string) {
  const items = getQueue(roomId)
  io.to(roomId).emit('queue:update', items)
}

function schedulePlayForRoom(roomId: string) {
  const state = playbackStates.get(roomId)
  if (!state) return
  const startDelayMs = 1500
  const plannedStartAtMs = Date.now() + startDelayMs
  state.isPlaying = true
  state.startTime = plannedStartAtMs
  state.lastUpdate = Date.now()
  io.to(roomId).emit('play', {
    trackUrl: state.trackUrl,
    positionSec: state.positionSec,
    startAtServerMs: plannedStartAtMs
  })
  io.to(roomId).emit('room:state', buildRoomState(roomId))
}

// Resolve media roots; prefer repo-level folders when running from packages/server
const repoRoot = join(process.cwd(), '..');
const candidateUploads = [join(repoRoot, 'uploads'), join(process.cwd(), 'uploads')];
const candidateSongs = [join(repoRoot, 'songs'), join(process.cwd(), 'songs')];

function ensureFirstExistingPath(candidates: string[]): string {
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  // default to first and create it
  const first = candidates[0];
  try { fs.mkdirSync(first, { recursive: true }); } catch {}
  return first;
}

// Local uploads storage
const uploadRoot = ensureFirstExistingPath(candidateUploads);
if (!fs.existsSync(uploadRoot)) {
  fs.mkdirSync(uploadRoot, { recursive: true });
}

// Local songs library storage
const songsRoot = ensureFirstExistingPath(candidateSongs);
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

const allowedAudioMimes = new Set([
  'audio/mpeg', // mp3
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/flac',
  'audio/webm'
]);
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowedAudioMimes.has(file.mimetype)) return cb(null, true)
    return cb(new Error('Unsupported file type'))
  }
});

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
  } catch (e: any) {
    console.error('Upload error:', e);
    const msg = typeof e?.message === 'string' ? e.message : 'Upload failed'
    res.status(400).json({ ok: false, reason: msg });
  }
});

// Format Multer errors
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!err) return next()
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, reason: 'File too large' })
  }
  if (typeof err?.message === 'string') {
    return res.status(400).json({ ok: false, reason: err.message })
  }
  next(err)
})

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
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Accept-Ranges': acceptRanges,
      'Cache-Control': 'public, max-age=3600',
      'Content-Type': contentType,
    });
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (contentRange) res.setHeader('Content-Range', contentRange);

    if (response.body) {
      try {
        const nodeStream = Readable.fromWeb(response.body as any);
        nodeStream.on('error', (error) => {
          console.error('Streaming error:', error);
          try { res.end(); } catch {}
        });
        nodeStream.pipe(res);
      } catch (err) {
        console.error('Stream conversion error:', err);
        // Fallback: read fully (not ideal for large files)
        const buffer = Buffer.from(await response.arrayBuffer());
        res.end(buffer);
      }
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

function buildRoomState(roomId: string) {
  const room = rooms.get(roomId)
  return {
    roomId,
    ownerName: room?.ownerId ?? '',
    participants: room?.participants ?? [],
  }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  let currentUser: string | null = null;
  let currentRoom: string | null = null;
  let sessionToken: string | null = null;

  // Session identify and restore
  socket.on('session:identify', (token: string, callback?: (r: any) => void) => {
    const clean = typeof token === 'string' ? token.trim() : ''
    if (!clean) { callback?.({ ok: false }); return }
    sessionToken = clean
    const s = sessions.get(clean)
    callback?.({ ok: true, username: s?.username ?? null, roomId: s?.roomId ?? null })
  });

  // Set display name (no auth)
  socket.on('user:setName', (name: string, callback?: (r: any) => void) => {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      callback?.({ ok: false, reason: 'Name required' });
      return;
    }
    currentUser = trimmed.slice(0, 32);
    users.set(socket.id, { username: currentUser })
    if (sessionToken) {
      const s = sessions.get(sessionToken) || {}
      s.username = currentUser
      sessions.set(sessionToken, s)
    }
    // store on socket for lookups later
    try { (socket as any).data = { ...(socket as any).data, username: currentUser }; } catch {}
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
    // Persist into session
    if (sessionToken) {
      const s = sessions.get(sessionToken) || {}
      s.roomId = roomId
      s.username = currentUser
      sessions.set(sessionToken, s)
    }
    // Inform creator about room info
    io.to(roomId).emit('room:info', buildRoomState(roomId));
    io.to(roomId).emit('room:state', buildRoomState(roomId));
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
      const now = Date.now();
      const currentPosition = getCurrentPositionSec(roomId);
      socket.emit('state:init', {
        trackUrl: playbackState.trackUrl,
        isPlaying: playbackState.isPlaying,
        positionSec: currentPosition,
        startTimeMs: playbackState.isPlaying ? playbackState.startTime : null,
        serverNowMs: now
      });

      // If already playing, schedule a per-socket catch-up start a bit in the future
      if (playbackState.isPlaying) {
        const joinStartDelayMs = 2500; // give the new client time to buffer and unlock audio
        const plannedStartAtMs = now + joinStartDelayMs;
        const delaySec = joinStartDelayMs / 1000;
        const baseAtStart = currentPosition + delaySec;
        socket.emit('play', {
          trackUrl: playbackState.trackUrl,
          positionSec: baseAtStart,
          startAtServerMs: plannedStartAtMs
        });
      }
    }
    
    // Persist into session
    if (sessionToken) {
      const s = sessions.get(sessionToken) || {}
      s.roomId = roomId
      s.username = currentUser
      sessions.set(sessionToken, s)
    }
    // Send room info to all clients in the room
    io.to(roomId).emit('room:info', buildRoomState(roomId));
    io.to(roomId).emit('room:state', buildRoomState(roomId));
    
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

  // Queue: add item
  socket.on('queue:add', (data: { roomId: string; url: string; name?: string }, callback?: (r: any) => void) => {
    try {
      const { roomId, url } = data || ({} as any)
      let { name } = data || ({} as any)
      if (!roomId || typeof url !== 'string' || !url.trim()) { callback?.({ ok: false, reason: 'Invalid payload' }); return }
      const room = rooms.get(roomId)
      if (!room) { callback?.({ ok: false, reason: 'Room not found' }); return }
      if (room.ownerId !== currentUser) { callback?.({ ok: false, reason: 'Only owner can add to queue' }); return }
      name = typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : url
      const q = getQueue(roomId)
      // dedupe: avoid back-to-back duplicate adds of same track by same user within 2s
      const now = Date.now()
      const last = q[q.length - 1]
      if (last && last.url === url.trim() && last.addedBy === currentUser && now - last.addedAt < 2000) {
        callback?.({ ok: true, item: last })
        return
      }
      const item: QueueItem = { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, url: url.trim(), name, addedBy: currentUser!, addedAt: now }
      q.push(item)
      queues.set(roomId, q)
      broadcastQueue(roomId)
      console.log('Queue add:', { roomId, item: { id: item.id, name: item.name } })
      callback?.({ ok: true, item })
    } catch (e) {
      console.error('queue:add error', e)
      callback?.({ ok: false, reason: 'Queue add failed' })
    }
  })

  // Queue: remove item
  socket.on('queue:remove', (data: { roomId: string; id: string }, callback?: (r: any) => void) => {
    try {
      const { roomId, id } = data || ({} as any)
      if (!roomId || !id) { callback?.({ ok: false, reason: 'Invalid payload' }); return }
      const room = rooms.get(roomId)
      if (!room) { callback?.({ ok: false, reason: 'Room not found' }); return }
      if (room.ownerId !== currentUser) { callback?.({ ok: false, reason: 'Only owner can remove from queue' }); return }
      const q = getQueue(roomId)
      const next = q.filter(x => x.id !== id)
      queues.set(roomId, next)
      broadcastQueue(roomId)
      callback?.({ ok: true })
    } catch (e) {
      console.error('queue:remove error', e)
      callback?.({ ok: false, reason: 'Queue remove failed' })
    }
  })

  // Queue: play item now
  socket.on('queue:playNow', (data: { roomId: string; id: string }, callback?: (r: any) => void) => {
    try {
      const { roomId, id } = data || ({} as any)
      if (!roomId || !id) { callback?.({ ok: false, reason: 'Invalid payload' }); return }
      const room = rooms.get(roomId)
      if (!room) { callback?.({ ok: false, reason: 'Room not found' }); return }
      if (room.ownerId !== currentUser) { callback?.({ ok: false, reason: 'Only owner can play now' }); return }
      const q = getQueue(roomId)
      const idx = q.findIndex(x => x.id === id)
      if (idx === -1) { callback?.({ ok: false, reason: 'Item not found' }); return }
      const [item] = q.splice(idx, 1)
      // Load this track immediately
      playbackStates.set(roomId, {
        isPlaying: false,
        positionSec: 0,
        trackUrl: item.url,
        startTime: Date.now(),
        lastUpdate: Date.now()
      })
      io.to(roomId).emit('state:update', { trackUrl: item.url, isPlaying: false, positionSec: 0, serverNowMs: Date.now() })
      // Put remaining queue back and broadcast
      queues.set(roomId, q)
      broadcastQueue(roomId)
      // Auto play after small delay to sync
      schedulePlayForRoom(roomId)
      callback?.({ ok: true })
    } catch (e) {
      console.error('queue:playNow error', e)
      callback?.({ ok: false, reason: 'Play now failed' })
    }
  })

  // Queue: get
  socket.on('queue:get', (roomId: string, callback?: (items: QueueItem[]) => void) => {
    try {
      const r = typeof roomId === 'string' ? roomId : currentRoom
      if (!r) { callback?.([]); return }
      callback?.(getQueue(r))
    } catch { callback?.([]) }
  })

  // Playback ended (owner can trigger auto-advance)
  socket.on('playback:ended', (data: { roomId: string }) => {
    try {
      const { roomId } = data || ({} as any)
      if (!roomId) return
      const room = rooms.get(roomId)
      if (!room) return
      if (room.ownerId !== currentUser) return
      const q = getQueue(roomId)
      if (q.length === 0) return
      const next = q.shift()!
      // Load next track
      playbackStates.set(roomId, {
        isPlaying: false,
        positionSec: 0,
        trackUrl: next.url,
        startTime: Date.now(),
        lastUpdate: Date.now()
      })
      io.to(roomId).emit('state:update', { trackUrl: next.url, isPlaying: false, positionSec: 0, serverNowMs: Date.now() })
      queues.set(roomId, q)
      broadcastQueue(roomId)
      schedulePlayForRoom(roomId)
    } catch (e) {
      console.error('playback:ended error', e)
    }
  })

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
    io.to(roomId).emit('room:state', buildRoomState(roomId));
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
    io.to(roomId).emit('room:state', buildRoomState(roomId));
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
    io.to(roomId).emit('room:state', buildRoomState(roomId));
    console.log('Seek in room:', roomId, 'by:', currentUser, 'to:', positionSec);
  });

  // Transfer room ownership (admin action)
  socket.on('room:transferOwner', (data: { roomId: string; newOwnerName: string }, callback?: (r: any) => void) => {
    try {
      const { roomId, newOwnerName } = data || ({} as any);
      if (!roomId || typeof newOwnerName !== 'string' || !newOwnerName.trim()) {
        callback?.({ ok: false, reason: 'Invalid payload' });
        return;
      }

      const room = rooms.get(roomId);
      if (!room) {
        callback?.({ ok: false, reason: 'Room not found' });
        return;
      }
      if (room.ownerId !== currentUser) {
        callback?.({ ok: false, reason: 'Only the owner can transfer ownership' });
        return;
      }
      const target = newOwnerName.trim();
      if (!room.participants.includes(target)) {
        callback?.({ ok: false, reason: 'Target user is not in the room' });
        return;
      }
      if (target === room.ownerId) {
        callback?.({ ok: false, reason: 'User is already the owner' });
        return;
      }

      room.ownerId = target;
      // Broadcast updated room info and explicit owner change
      io.to(roomId).emit('room:ownerChanged', room.ownerId);
      io.to(roomId).emit('room:info', buildRoomState(roomId));
      io.to(roomId).emit('room:state', buildRoomState(roomId));
      // Notify both sides explicitly
      io.in(roomId).fetchSockets().then((sockets) => {
        try {
          const by = currentUser
          const to = target
          const prevOwnerSocket = sockets.find(s => (s as any).data?.username === by);
          const newOwnerSocket = sockets.find(s => (s as any).data?.username === to);
          prevOwnerSocket?.emit('role:update', { role: 'member', ownerName: room.ownerId });
          newOwnerSocket?.emit('role:update', { role: 'owner', ownerName: room.ownerId });
        } catch {}
      }).catch(() => {})
      callback?.({ ok: true, ownerName: room.ownerId });
      console.log('Ownership transferred in room:', roomId, 'to:', room.ownerId, 'by:', currentUser);
    } catch (e) {
      console.error('transferOwner error:', e);
      callback?.({ ok: false, reason: 'Transfer failed' });
    }
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

  // Chat: send message to room
  socket.on('chat:send', (data: { roomId: string; text: string }) => {
    try {
      const { roomId, text } = data || ({} as any)
      const clean = typeof text === 'string' ? text.trim() : ''
      if (!roomId || !clean) return
      if (!currentUser) return
      const room = rooms.get(roomId)
      if (!room) return
      if (!room.participants.includes(currentUser) && room.ownerId !== currentUser) return
      const msg = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        user: currentUser,
        text: clean.slice(0, 1000),
        timeMs: Date.now(),
      }
      const arr = chatHistory.get(roomId) || []
      arr.push(msg)
      while (arr.length > 200) arr.shift()
      chatHistory.set(roomId, arr)
      io.to(roomId).emit('chat:new', msg)
    } catch (e) {
      console.error('chat:send error', e)
    }
  })

  // Chat: get recent history
  socket.on('chat:get', (roomId: string, callback?: (messages: Array<{ id: string; user: string; text: string; timeMs: number }>) => void) => {
    try {
      const r = typeof roomId === 'string' ? roomId : currentRoom
      if (!r) { callback?.([]); return }
      const room = rooms.get(r)
      if (!room) { callback?.([]); return }
      if (!currentUser || (!room.participants.includes(currentUser) && room.ownerId !== currentUser)) { callback?.([]); return }
      callback?.(chatHistory.get(r) || [])
    } catch {
      callback?.([])
    }
  })

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
