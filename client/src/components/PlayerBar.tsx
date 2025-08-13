import { FaPlay, FaPause, FaStepBackward, FaStepForward } from 'react-icons/fa'
import type React from 'react'

type Props = {
  isPlaying: boolean
  canControl: boolean
  currentSec: number
  durationSec: number
  bufferedSec: number
  onPlay: () => void
  onPause: () => void
  onSeekBy: (delta: number) => void
  onSeekTo: (sec: number) => void
  fmt: (s: number) => string
}

export function PlayerBar({ isPlaying, canControl, currentSec, durationSec, bufferedSec, onPlay, onPause, onSeekBy, onSeekTo, fmt }: Props) {
  const progressPct = durationSec > 0 ? (currentSec / durationSec) * 100 : 0
  const bufferedPct = durationSec > 0 ? (bufferedSec / durationSec) * 100 : 0

  return (
    <div className="playerBar">
      <div className="playerBarLeft">
        <div className="trackMeta">
          <div className="trackTitle">Now Playing</div>
          <div className="trackArtist">Synchronized Audio</div>
        </div>
      </div>

      <div className="playerBarCenter">
        <div className="controls">
          <button className="ctrlBtn" onClick={() => canControl && onSeekBy(-5)} disabled={!canControl} aria-label="Back 5 seconds"><FaStepBackward size={16} /></button>
          {isPlaying ? (
            <button className="ctrlBtn primary" onClick={() => canControl && onPause()} disabled={!canControl} aria-label="Pause"><FaPause size={16} /></button>
          ) : (
            <button className="ctrlBtn primary" onClick={() => canControl && onPlay()} disabled={!canControl} aria-label="Play"><FaPlay size={16} /></button>
          )}
          <button className="ctrlBtn" onClick={() => canControl && onSeekBy(5)} disabled={!canControl} aria-label="Forward 5 seconds"><FaStepForward size={16} /></button>
        </div>
        <div className="barRow">
          <span className="timeSmall">{fmt(currentSec)}</span>
          <div className="bar" onClick={(e) => {
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
            const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
            onSeekTo(frac * (durationSec || 0))
          }}>
            <div className="barBuffered" style={{ width: `${Math.min(100, bufferedPct)}%` }} />
            <div className="barFill" style={{ width: `${Math.min(100, progressPct)}%` }} />
          </div>
          <span className="timeSmall">{fmt(durationSec || 0)}</span>
        </div>
      </div>

      <div className="playerBarRight">
        <div className="brandMini">Music Sync</div>
      </div>
    </div>
  )
} 