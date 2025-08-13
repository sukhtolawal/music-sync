import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { gsap } from 'gsap'

export type ChatMessage = { id: string; user: string; text: string; timeMs: number }

type Props = {
  socket: Socket
  roomId: string
  username: string
  open: boolean
  onClose?: () => void
  onNewMessage?: (msg: ChatMessage) => void
}

export function ChatWidget({ socket, roomId, username, open, onClose, onNewMessage }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
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

  // Load history on open
  useEffect(() => {
    if (!open || !roomId) return
    socket.emit('chat:get', roomId, (msgs: ChatMessage[]) => {
      setMessages(Array.isArray(msgs) ? msgs : [])
      scrollToBottom()
    })
  }, [open, roomId, socket])

  // Realtime new messages
  useEffect(() => {
    const onNew = (msg: ChatMessage) => {
      if (!msg || msg == null) return
      setMessages(prev => [...prev, msg])
      try { onNewMessage?.(msg) } catch {}
      scrollToBottomSoon()
    }
    socket.on('chat:new', onNew)
    return () => { socket.off('chat:new', onNew) }
  }, [socket, onNewMessage])

  const scrollToBottom = () => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }
  const scrollToBottomSoon = () => setTimeout(scrollToBottom, 10)

  const send = () => {
    const clean = text.trim()
    if (!clean || !roomId) return
    socket.emit('chat:send', { roomId, text: clean })
    setText('')
  }

  const fmtTime = (ms: number) => {
    const d = new Date(ms)
    const hh = d.getHours().toString().padStart(2, '0')
    const mm = d.getMinutes().toString().padStart(2, '0')
    return `${hh}:${mm}`
  }

  if (!open) return null

  return (
    <div ref={panelRef} className="chatPanel">
      <div className="chatHeader">
        <div className="chatTitle">Room Chat</div>
        <button className="chatClose" onClick={() => onClose?.()} aria-label="Close chat">✕</button>
      </div>
      <div className="chatList" ref={listRef}>
        {messages.length === 0 && <div className="chatEmpty">No messages yet</div>}
        {messages.map(m => {
          const mine = m.user === username
          return (
            <div key={m.id} className={`chatItem ${mine ? 'mine' : 'theirs'}`}>
              {!mine && <div className="chatName">{m.user}</div>}
              <div className="chatBubble">
                <div className="chatText">{m.text}</div>
                <div className="chatMeta">{fmtTime(m.timeMs)}</div>
              </div>
            </div>
          )
        })}
      </div>
      <div className="chatInputRow">
        <input
          className="chatInput"
          placeholder="Type a message"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send() }}
        />
        <button className="button" onClick={send} disabled={!text.trim()}>Send</button>
      </div>
    </div>
  )
} 