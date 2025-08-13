import { useLayoutEffect, useRef } from 'react'
import { gsap } from 'gsap'

export type QueueItem = { id: string; url: string; name: string; addedBy: string; addedAt: number }

type Props = {
  open: boolean
  items: QueueItem[]
  canControl: boolean
  onPlayNow: (id: string) => void
  onRemove: (id: string) => void
  onClose: () => void
}

export function QueueWidget({ open, items, canControl, onPlayNow, onRemove, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReduced) return
    const ctx = gsap.context(() => {
      if (!panelRef.current) return
      gsap.set(panelRef.current, { y: 12, opacity: 0 })
      gsap.to(panelRef.current, { y: 0, opacity: 1, duration: .28, ease: 'power3.out' })
    }, panelRef)
    return () => ctx.revert()
  }, [open])

  if (!open) return null

  return (
    <div ref={panelRef} className="queuePanel">
      <div className="queueHeader">
        <div className="queueTitle">Queue</div>
        <button className="chatClose" onClick={onClose} aria-label="Close queue">✕</button>
      </div>
      <div className="queueList">
        {items.map((item) => (
          <div key={item.id} className="row" style={{ justifyContent: 'space-between' }}>
            <div style={{ display: 'grid' }}>
              <span>{item.name}</span>
              <span className="helper">added by {item.addedBy}</span>
            </div>
            {canControl && (
              <div className="row">
                <button className="button" onClick={() => onPlayNow(item.id)}>Play now</button>
                <button className="button secondary" onClick={() => onRemove(item.id)}>Remove</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
} 