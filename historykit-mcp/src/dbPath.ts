import fs from 'fs'
import os from 'os'
import path from 'path'

export function resolveDbPath(): string {
  if (process.env.HISTORYKIT_DB_PATH) return process.env.HISTORYKIT_DB_PATH

  const home = os.homedir()
  const candidates: string[] = []

  if (process.platform === 'darwin') {
    // Electron's app userData path for this project is the lowercase app id.
    candidates.push(path.join(home, 'Library', 'Application Support', 'historykit', 'historykit.db'))
    candidates.push(path.join(home, 'Library', 'Application Support', 'HistoryKit', 'historykit.db'))
  } else if (process.platform === 'win32') {
    candidates.push(path.join(home, 'AppData', 'Roaming', 'HistoryKit', 'historykit.db'))
  } else {
    candidates.push(path.join(home, '.config', 'HistoryKit', 'historykit.db'))
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  throw new Error(
    `HistoryKit database not found. Searched:\n${candidates.map(c => '  ' + c).join('\n')}\n\n` +
    `Set HISTORYKIT_DB_PATH environment variable to override.`
  )
}
