import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import { useTimeSync } from './lib/useTimeSync'

const SERVER_URL = `${window.location.protocol}//${window.location.hostname}:4000`

type View = 'lobby' | 'room'

type AuthMode = 'login' | 'signup'

export default function App() {
  const socket = useMemo<Socket>(() => {
    const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent)
    const transports = isFirefox ? ['polling'] as const : (['polling', 'websocket'] as const)
    return io(SERVER_URL, {
      transports: Array.from(transports),
      upgrade: !isFirefox,
      rememberUpgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    timeout: 20000,
    withCredentials: false,
      path: '/socket.io',
      // No custom headers to avoid CORS preflight issues
    })
  }, [])
  const { offsetMs, rttMs } = useTimeSync(socket)

  const [connected, setConnected] = useState(false)
  const [apiOnline, setApiOnline] = useState(true)
  const [view, setView] = useState<View>('lobby')
  const [username, setUsername] = useState('')
  const [nameSet, setNameSet] = useState(false)
  const [settingName, setSettingName] = useState(false)

  const [roomId, setRoomId] = useState<string>('');
  const [trackUrl, setTrackUrl] = useState<string>('');
  const [creating, setCreating] = useState(false)
  const [joining, setJoining] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionBaseSec, setPositionBaseSec] = useState(0);
  const [plannedStartServerMs, setPlannedStartServerMs] = useState<number | null>(null);
  // Proxy is always automatic via backend now; no UI toggle
  const [uploading, setUploading] = useState(false); // deprecated with songs picker
  const [ownerName, setOwnerName] = useState<string>('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [songsOpen, setSongsOpen] = useState(false);
  const [songs, setSongs] = useState<{ name: string; url: string }[]>([]);
  const [songQuery, setSongQuery] = useState('');
  const visibleSongs = useMemo(() => {
    const q = songQuery.trim().toLowerCase()
    if (!q) return songs
    return songs.filter(s => s.name.toLowerCase().includes(q))
  }, [songs, songQuery])

  const [audioUnlocked, setAudioUnlocked] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const correctionTimerRef = useRef<number | null>(null)

  const [currentSec, setCurrentSec] = useState(0)
  const [durationSec, setDurationSec] = useState(0)
  const [bufferedSec, setBufferedSec] = useState(0)
  const [previewSec, setPreviewSec] = useState<number | null>(null)
  const draggingRef = useRef(false)

  useEffect(() => { setView('lobby') }, [])

  // Backend health heartbeat
  useEffect(() => {
    let stopped = false
    const check = async () => {
      try {
        const res = await fetch(`${SERVER_URL}/health`, { cache: 'no-store' })
        if (!stopped) setApiOnline(res.ok)
      } catch {
        if (!stopped) setApiOnline(false)
      }
    }
    check()
    const id = window.setInterval(check, 2500)
    return () => { stopped = true; clearInterval(id) }
  }, [])

  useEffect(() => {
    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    const onInit = (state: any) => {
      if (state.trackUrl) setTrackUrl(state.trackUrl)
      if (state.isPlaying && typeof state.startTimeMs === 'number') {
        schedulePlay(state.positionSec ?? 0, state.startTimeMs, { positionIsCurrent: true })
      } else {
        cancelDriftCorrection()
        const audio = audioRef.current
        if (audio) {
          audio.pause()
          if (typeof state.positionSec === 'number') {
            audio.currentTime = state.positionSec
            setCurrentSec(state.positionSec)
          }
        }
        setIsPlaying(false)
        setPositionBaseSec(state.positionSec ?? 0)
        setPlannedStartServerMs(null)
      }
    }
    socket.on('state:init', onInit)

    const onStateUpdate = (s: any) => {
      if (s.trackUrl) setTrackUrl(s.trackUrl)
      cancelDriftCorrection()
      const audio = audioRef.current
      if (audio) {
        audio.pause()
        const p = typeof s.positionSec === 'number' ? s.positionSec : 0
        audio.currentTime = p
        setCurrentSec(p)
        setPositionBaseSec(p)
      }
      setIsPlaying(false)
      setPlannedStartServerMs(null)
    }
    socket.on('state:update', onStateUpdate)

    const onRoomInfo = (info: any) => {
      setOwnerName(info.ownerName ?? null)
      setParticipants(Array.isArray(info.participants) ? info.participants : [])
    }
    socket.on('room:info', onRoomInfo)

    const onDenied = ({ reason }: any) => {
      setAudioError(reason || 'Only the owner can control playback')
      setTimeout(() => setAudioError(null), 2500)
    }
    socket.on('control:denied', onDenied)

    const onPlay = ({ trackUrl, positionSec, startAtServerMs }: any) => {
      if (trackUrl) setTrackUrl(trackUrl)
      schedulePlay(positionSec, startAtServerMs, { positionIsCurrent: false })
    }
    socket.on('play', onPlay)

    const onPause = ({ positionSec }: any) => {
      cancelDriftCorrection()
      const audio = audioRef.current
      if (!audio) return
      audio.pause()
      if (typeof positionSec === 'number') {
        audio.currentTime = positionSec
        setPositionBaseSec(positionSec)
        setCurrentSec(positionSec)
      }
      setIsPlaying(false)
      setPlannedStartServerMs(null)
    }
    socket.on('pause', onPause)

    const onSeek = ({ positionSec, startAtServerMs }: any) => {
      if (startAtServerMs) {
        schedulePlay(positionSec, startAtServerMs, { positionIsCurrent: false })
      } else {
        const audio = audioRef.current
        if (!audio) return
        audio.currentTime = positionSec
        setPositionBaseSec(positionSec)
        setCurrentSec(positionSec)
      }
    }
    socket.on('seek', onSeek)

    return () => {
      socket.off('state:init', onInit)
      socket.off('state:update', onStateUpdate)
      socket.off('room:info', onRoomInfo)
      socket.off('control:denied', onDenied)
      socket.off('play', onPlay)
      socket.off('pause', onPause)
      socket.off('seek', onSeek)
    }
  }, [socket, offsetMs])

  // Listen for server acknowledgment of name
  useEffect(() => {
    const onReady = ({ username: u }: any) => {
      if (u && u === username) setNameSet(true)
      setSettingName(false)
    }
    socket.on('user:ready', onReady)
    return () => { socket.off('user:ready', onReady) }
  }, [socket, username])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onLoaded = () => {
      setDurationSec(isFinite(audio.duration) ? audio.duration : 0)
      try {
        const buf = audio.buffered
        if (buf && buf.length > 0) setBufferedSec(buf.end(buf.length - 1))
      } catch {}
    }
    const onTime = () => {
      setCurrentSec(audio.currentTime)
    }
    const onProgress = () => {
      try {
        const buf = audio.buffered
        if (buf && buf.length > 0) setBufferedSec(buf.end(buf.length - 1))
      } catch {}
    }

    audio.addEventListener('loadedmetadata', onLoaded)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('progress', onProgress)

    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('progress', onProgress)
    }
  }, [trackUrl])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onErr = () => {
      const mediaErr = audio.error
      if (mediaErr) {
        const map: Record<number, string> = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' }
        setAudioError(`Audio error: ${map[mediaErr.code] || mediaErr.code}`)
      } else {
        setAudioError('Audio error')
      }
    }
    audio.addEventListener('error', onErr)
    return () => audio.removeEventListener('error', onErr)
  }, [trackUrl])

  const serverNowMs = () => Date.now() + offsetMs

  const waitForReady = (audio: HTMLAudioElement) => new Promise<void>((resolve) => {
    if (audio.readyState >= 1) return resolve()
    const onReady = () => {
      audio.removeEventListener('loadedmetadata', onReady)
      audio.removeEventListener('canplay', onReady)
      resolve()
    }
    audio.addEventListener('loadedmetadata', onReady, { once: true })
    audio.addEventListener('canplay', onReady, { once: true })
  })

  const primeAudio = async () => {
    const audio = audioRef.current
    if (!audio) return
    try {
      const oldMuted = audio.muted
      audio.muted = true
      await audio.play()
      audio.pause()
      audio.muted = oldMuted
      setAudioUnlocked(true)
      setAudioError(null)
    } catch (e) {
      setAudioUnlocked(false)
      // Do not show manual prompt; we'll retry automatically
    }
  }

  // Automatically attempt to unlock audio without manual interaction
  useEffect(() => {
    let attempts = 0
    let cancelled = false
    const tryPrime = async () => {
      if (cancelled || audioUnlocked) return
      attempts += 1
      await primeAudio()
      if (!audioUnlocked && attempts < 10) {
        setTimeout(tryPrime, 800)
      }
    }
    tryPrime()
    return () => { cancelled = true }
  }, [audioUnlocked, trackUrl])

  const schedulePlay = async (
    positionSec: number,
    startAtServerMs: number,
    options?: { positionIsCurrent?: boolean }
  ) => {
    const audio = audioRef.current
    if (!audio) return

    cancelDriftCorrection()

    // If positionSec is already the current position at server time now,
    // use server now as the effective start so drift correction begins from zero offset.
    const serverNow = serverNowMs()
    const effectiveStartAtServerMs = options?.positionIsCurrent ? serverNow : startAtServerMs

    setPositionBaseSec(positionSec)
    setPlannedStartServerMs(effectiveStartAtServerMs)

    const localStartMs = effectiveStartAtServerMs - offsetMs
    const deltaMs = localStartMs - Date.now()

    audio.pause()
    await waitForReady(audio)

    const lateBySec = options?.positionIsCurrent ? 0 : Math.max(0, -deltaMs / 1000)
    audio.currentTime = positionSec + lateBySec
    setCurrentSec(audio.currentTime)

    const start = () => {
      // Start muted to satisfy autoplay policies, then unmute shortly after
      try { audio.muted = true } catch {}
      audio
        .play()
        .then(() => {
          setAudioUnlocked(true)
          setAudioError(null)
          setTimeout(() => { try { audio.muted = false } catch {} }, 150)
        })
        .catch(() => setAudioError('Playback failed. Check browser autoplay settings or try again.'))
      startDriftCorrection(positionSec, effectiveStartAtServerMs)
      setIsPlaying(true)
    }

    if (deltaMs > 10) {
      window.setTimeout(start, deltaMs)
    } else {
      start()
    }
  }

  const startDriftCorrection = (basePositionSec: number, startAtServerMs: number) => {
    cancelDriftCorrection()
    const audio = audioRef.current!
    const tick = () => {
      const expectedSec = basePositionSec + Math.max(0, (serverNowMs() - startAtServerMs) / 1000)
      const actualSec = audio.currentTime
      const errorSec = expectedSec - actualSec
      const k = 0.5
      const correction = Math.max(-0.02, Math.min(0.02, k * errorSec))
      audio.playbackRate = 1 + correction
    }
    correctionTimerRef.current = window.setInterval(tick, 1000)
  }

  const cancelDriftCorrection = () => {
    if (correctionTimerRef.current != null) {
      clearInterval(correctionTimerRef.current)
      correctionTimerRef.current = null
    }
    const audio = audioRef.current
    if (audio) audio.playbackRate = 1
  }

  const resolveSrc = (raw: string) => {
    if (!raw) return ''
    // Relative paths served by our backend
    if (raw.startsWith('/media/') || raw.startsWith('/songs/')) return `${SERVER_URL}${raw}`
    // Absolute same-origin URL, serve directly
    try {
      const target = new URL(raw, SERVER_URL)
      const origin = new URL(SERVER_URL)
      if (target.origin === origin.origin) return target.toString()
    } catch {}
    // Everything else goes through backend proxy to avoid CORS
    const u = new URL('/proxy', SERVER_URL)
    u.searchParams.set('url', raw)
    return u.toString()
  }

  const logout = () => {
    setUsername('')
    setView('lobby')
  }

  // Room actions
  const createRoom = () => {
    setCreating(true)
    socket.emit('room:create', (resp: any) => {
      setCreating(false)
      if (resp?.ok && resp.roomId) {
        const id = resp.roomId
        setRoomId(id)
        setView('room')
      } else {
        setAudioError(resp?.reason || 'Failed to create room')
      }
    })
  }

  const joinRoom = () => {
    const clean = roomId.trim().toUpperCase()
    if (!clean) return
    setJoining(true)
    socket.emit('room:join', clean, (resp: any) => {
      setJoining(false)
      if (resp?.ok) {
        setRoomId(clean)
        setView('room')
      } else {
        setAudioError(resp?.reason || 'Failed to join room')
      }
    })
  }

  const loadTrack = async () => {
    if (!trackUrl || !roomId) return
    await primeAudio()
    socket.emit('control:load', { roomId, trackUrl })
  }
  // Songs library
  const openSongs = async () => {
    try {
      setSongQuery('')
      const res = await fetch(`${SERVER_URL}/songs/list`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({ ok: false }))
      if (data?.ok && Array.isArray(data.songs)) {
        setSongs(data.songs)
        setSongsOpen(true)
      } else {
        setAudioError('Failed to load songs list')
      }
    } catch {
      setAudioError('Failed to load songs list')
    }
  }
  const selectSong = async (songUrl: string) => {
    if (!roomId) return
    const absolute = songUrl.startsWith('http') ? songUrl : `${SERVER_URL}${songUrl}`
    setTrackUrl(absolute)
    await primeAudio()
    socket.emit('control:load', { roomId, trackUrl: absolute })
    setSongsOpen(false)
  }
  const play = async () => { await primeAudio(); roomId && socket.emit('control:play', { roomId }) }
  const pause = () => { roomId && socket.emit('control:pause', { roomId }) }
  const seekBy = async (deltaSec: number) => { await primeAudio(); const newPos = Math.max(0, (audioRef.current?.currentTime ?? 0) + deltaSec); roomId && socket.emit('control:seek', { roomId, positionSec: newPos }) }

  const canControl = ownerName != null && username === ownerName

  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) s = 0
    const m = Math.floor(s / 60)
    const ss = Math.floor(s % 60).toString().padStart(2, '0')
    return `${m}:${ss}`
  }

  const displaySec = previewSec ?? currentSec
  const progressPct = durationSec > 0 ? (displaySec / durationSec) * 100 : 0
  const bufferedPct = durationSec > 0 ? (bufferedSec / durationSec) * 100 : 0

  const handleProgressPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const bar = e.currentTarget
    const rect = bar.getBoundingClientRect()
    const x = e.clientX
    const frac = Math.min(1, Math.max(0, (x - rect.left) / rect.width))
    const pos = durationSec * frac
    setPreviewSec(pos)
  }
  const handleProgressDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!durationSec) return
    draggingRef.current = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    handleProgressPointer(e)
  }
  const handleProgressMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    handleProgressPointer(e)
  }
  const handleProgressUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    const target = previewSec ?? currentSec
    setPreviewSec(null)
    if (canControl && isFinite(target)) {
      socket.emit('control:seek', { roomId, positionSec: Math.max(0, Math.min(durationSec || 0, target)) })
    }
  }

  const overallOnline = connected && apiOnline

  // Views
  // Removed auth view

  if (view === 'lobby') {
    return (
      <div className="container">
        <div className="header">
          <div className="brand">Music Sync</div>
          <div className={`badge ${overallOnline? 'ok':'err'}`}>{overallOnline? 'online':'offline'}</div>
        </div>
        {(!apiOnline || !connected) && (
          <div className="error" role="status">Connection lost. Trying to reconnect…</div>
        )}
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Lobby</h2>
          <div className="row">
            {nameSet ? (
              <span className="helper">Name: <b>{username}</b></span>
            ) : (
              <>
                <input className="input" placeholder="Your name" value={username} onChange={e => setUsername(e.target.value)} />
                <button
                  className="button secondary"
                  onClick={() => {
                    if (!username.trim()) return
                    setSettingName(true)
                    socket.emit('user:setName', username.trim(), (resp: any) => {
                      setSettingName(false)
                      if (resp?.ok) setNameSet(true)
                      else setAudioError(resp?.reason || 'Failed to set name')
                    })
                  }}
                  disabled={!connected || !username.trim() || settingName}
                >
                  {settingName ? 'Setting…' : 'Set name'}
                </button>
              </>
            )}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="button" onClick={createRoom} disabled={!connected || !nameSet || creating || joining}>
              {creating ? 'Creating…' : 'Create room'}
            </button>
            <span className="helper">or</span>
            <input className="input" placeholder="Room code" value={roomId} onChange={e => setRoomId(e.target.value.toUpperCase())} />
            <button className="button secondary" onClick={joinRoom} disabled={!connected || !nameSet || !roomId.trim() || creating || joining}>
              {joining ? 'Joining…' : 'Join room'}
            </button>
          </div>

          {audioError && <div className="error">{audioError}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className="container">
      <div className="header">
        <div className="brand">Music Sync</div>
        <div className={`badge ${overallOnline? 'ok':'err'}`}>{overallOnline? 'online':'offline'}</div>
      </div>
      {(!apiOnline || !connected) && (
        <div className="error" role="status">Connection lost. Trying to reconnect…</div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Room {roomId}</h2>
        <div className="row">
          <span className="helper">User: {username}</span>
          <span className="helper">Owner: {ownerName ?? 'none'}</span>
          <span className="helper">offset: {offsetMs} ms</span>
          <span className="helper">rtt: {rttMs ?? '-'} ms</span>
          {/* Proxy is automatic (no toggle) */}
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="button" onClick={openSongs} disabled={!canControl} title={canControl?undefined:'Only owner can pick songs'}>
            Songs
          </button>
        </div>

        {/* Custom player */}
        <div className="player section">
          <button className="iconBtn" onClick={() => canControl && seekBy(-5)} disabled={!canControl} title="Back 5s" aria-label="Back 5 seconds">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11 19A7 7 0 1 1 18 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M12 5V2l-3 3 3 3V5z" fill="currentColor"/></svg>
          </button>
          <button className={`iconBtn ${canControl ? 'primary' : ''}`} onClick={() => (isPlaying ? pause() : play())} disabled={!canControl} aria-label={isPlaying? 'Pause':'Play'}>
            {isPlaying ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M7 5l12 7-12 7V5z"/></svg>
            )}
          </button>
          <button className="iconBtn" onClick={() => canControl && seekBy(5)} disabled={!canControl} title="Forward 5s" aria-label="Forward 5 seconds">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 5a7 7 0 1 1-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M12 5V2l3 3-3 3V5z" fill="currentColor"/></svg>
          </button>

          <div className="progress"
            onPointerDown={handleProgressDown}
            onPointerMove={handleProgressMove}
            onPointerUp={handleProgressUp}
            onPointerCancel={handleProgressUp}
          >
            <div className="progressBar">
              <div className="progressBuffered" style={{ width: `${Math.min(100, bufferedPct)}%` }} />
              <div className="progressFill" style={{ width: `${Math.min(100, progressPct)}%` }} />
              <div className="progressKnob" style={{ left: `${Math.min(100, progressPct)}%` }} />
            </div>
            <div className="timeRow">
              <span>{fmt(previewSec ?? currentSec)}</span>
              <span>{fmt(durationSec || 0)}</span>
            </div>
          </div>
        </div>

        {audioError && (
          <div className="error">{audioError}</div>
        )}

        <audio
          ref={audioRef}
          src={resolveSrc(trackUrl) || undefined}
          preload="auto"
          playsInline
          className="audio"
        />

        <p className="helper" style={{ marginTop: 12 }}>
          Only the room owner can control playback. The creator of the room is the owner.
        </p>
      </div>
      {songsOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'grid', placeItems: 'center', zIndex: 50 }} onClick={() => setSongsOpen(false)}>
          <div className="card" style={{ width: 'min(720px, 96vw)', maxHeight: '80vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>Songs</h3>
              <div className="row" style={{ marginLeft: 'auto' }}>
                <input
                  className="input"
                  placeholder="Search songs..."
                  value={songQuery}
                  onChange={e => setSongQuery(e.target.value)}
                  style={{ width: '28ch' }}
                />
                <button className="button secondary" onClick={() => setSongsOpen(false)}>Close</button>
              </div>
            </div>
            {songs.length === 0 ? (
              <p className="helper">No songs found in server `songs` folder.</p>
            ) : (
              <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                {visibleSongs.length === 0 ? (
                  <p className="helper" style={{ margin: 0 }}>No results for "{songQuery}"</p>
                ) : (
                  visibleSongs.map((s) => (
                    <div key={s.url} className="row" style={{ justifyContent: 'space-between' }}>
                      <span>{s.name}</span>
                      <button className="button" onClick={() => selectSong(s.url)} disabled={!canControl}>Play</button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
