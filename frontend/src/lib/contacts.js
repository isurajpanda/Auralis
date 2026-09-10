// Shared extension directory — single source of truth for names/numbers.
// Used by the dialer (App.jsx, NumberSelector) and the dashboard presence panel.
export const CONTACTS = [
  { ext: '1001', name: 'admin' },
  { ext: '1002', name: 'suraj' },
  { ext: '1003', name: 'subrat' },
  { ext: '1004', name: 'sagar' },
  { ext: '1005', name: 'krutarth' },
  { ext: '1006', name: 'yashi' },
  { ext: '1007', name: 'anand' },
]

export const nameFor = (ext) => CONTACTS.find((c) => c.ext === ext)?.name ?? ''
