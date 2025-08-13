import { useEffect } from 'react'
import { ParticipantsSidebar } from './ParticipantsSidebar'

type Props = {
  open: boolean
  onClose: () => void
  username: string
  ownerName: string
  participants: string[]
  onMakeAdmin: (targetName: string) => void
}

export function ParticipantsDrawer({ open, onClose, username, ownerName, participants, onMakeAdmin }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <>
      <div className="drawerBackdrop" onClick={onClose} />
      <div className="drawer" role="dialog" aria-label="Participants">
        <ParticipantsSidebar
          username={username}
          ownerName={ownerName}
          participants={participants}
          onMakeAdmin={onMakeAdmin}
        />
      </div>
    </>
  )
} 