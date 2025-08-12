import { useEffect, useState } from 'react'
import type { Socket } from 'socket.io-client'

export function useTimeSync(socket: Socket) {
  const [offsetMs, setOffsetMs] = useState(0)
  const [rttMs, setRttMs] = useState<number | null>(null)

  useEffect(() => {
    const onPong = ({ serverNowMs, clientSendMs }: { serverNowMs: number; clientSendMs: number }) => {
      const clientRecvMs = Date.now()
      const rtt = clientRecvMs - clientSendMs
      const offset = serverNowMs - (clientSendMs + rtt / 2)
      setRttMs(prev => (prev == null ? rtt : Math.round(prev * 0.7 + rtt * 0.3)))
      setOffsetMs(prev => Math.round(prev * 0.7 + offset * 0.3))
    }

    const ping = () => socket.emit('timesync:ping', Date.now())

    socket.on('timesync:pong', onPong)
    ping()
    const id = window.setInterval(ping, 2000)
    return () => {
      socket.off('timesync:pong', onPong)
      clearInterval(id)
    }
  }, [socket])

  return { offsetMs, rttMs }
}
