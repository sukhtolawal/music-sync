import React from 'react'

type Props = {
  username: string
  ownerName: string
  participants: string[]
  onMakeAdmin: (targetName: string) => void
}

export function ParticipantsSidebar({ username, ownerName, participants, onMakeAdmin }: Props) {
  const unique = Array.from(new Set(participants || []))
  unique.sort((a, b) => (a === ownerName ? -1 : b === ownerName ? 1 : a.localeCompare(b)))

  return (
    <aside className="card sidebar">
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>Group</h3>
      <div className="userGrid">
        {unique.map((name) => (
          <div key={name} className={`userTile ${name === ownerName ? 'admin' : ''}`}>
            <div className="avatar">{(name || '?').slice(0, 1).toUpperCase()}</div>
            <div style={{ display: 'grid' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{name}</span>
                {name === ownerName && <span className="role">Admin</span>}
                {name === username && <span className="role me">You</span>}
              </div>
              {username === ownerName && name !== ownerName && (
                <div className="inlineMenu">
                  <button className="button secondary" onClick={() => onMakeAdmin(name)}>Make admin</button>
                </div>
              )}
            </div>
          </div>
        ))}
        {unique.length === 0 && <span className="helper">No participants yet</span>}
      </div>
    </aside>
  )
}


