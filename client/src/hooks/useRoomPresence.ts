import { useEffect, useState } from 'react'
import type { Socket } from 'socket.io-client'

export type RoomPresence = {
  ownerName: string
  participants: string[]
}

export function useRoomPresence(socket: Socket): RoomPresence {
  const [ownerName, setOwnerName] = useState<string>('')
  const [participants, setParticipants] = useState<string[]>([])

  useEffect(() => {
    const onRoomInfo = (info: any) => {
      if (info && typeof info === 'object') {
        if (typeof info.ownerName === 'string') setOwnerName(info.ownerName)
        if (Array.isArray(info.participants)) setParticipants(info.participants)
      }
    }
    const onRoomState = (state: any) => {
      if (state && typeof state === 'object') {
        if (typeof state.ownerName === 'string') setOwnerName(state.ownerName)
        if (Array.isArray(state.participants)) setParticipants(state.participants)
      }
    }
    const onOwnerChanged = (newOwner: string) => {
      if (typeof newOwner === 'string') setOwnerName(newOwner)
    }
    const onRoleUpdate = ({ ownerName: o }: any) => {
      if (typeof o === 'string') setOwnerName(o)
    }

    socket.on('room:info', onRoomInfo)
    socket.on('room:state', onRoomState)
    socket.on('room:ownerChanged', onOwnerChanged)
    socket.on('role:update', onRoleUpdate)

    return () => {
      socket.off('room:info', onRoomInfo)
      socket.off('room:state', onRoomState)
      socket.off('room:ownerChanged', onOwnerChanged)
      socket.off('role:update', onRoleUpdate)
    }
  }, [socket])

  return { ownerName, participants }
}


