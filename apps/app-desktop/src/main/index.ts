import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, resolve, basename, extname } from 'path'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import * as fs from 'fs'

app.commandLine.appendSwitch('disable-gpu-cache')
app.commandLine.appendSwitch('no-sandbox')
app.setName('ArsivGezgini')

try {
  const customUserData = join(app.getPath('temp'), 'arsiv-gezgini-runtime')
  if (!fs.existsSync(customUserData)) fs.mkdirSync(customUserData, { recursive: true })
  app.setPath('userData', customUserData)
} catch {}

let mainWindow: BrowserWindow | null = null
const runningProcesses = new Map<string, ChildProcessWithoutNullStreams>()

function findWorkspaceRoot(): string {
  let cur = __dirname
  for (let i = 0; i < 7; i++) {
    if (fs.existsSync(join(cur, 'scanner.py')) && fs.existsSync(join(cur, 'birlestir.py'))) {
      return cur
    }
    cur = resolve(cur, '..')
  }
  return process.cwd()
}

function getPythonExecutable(): string {
  if (fs.existsSync('C:\\Python314\\python.exe')) return 'C:\\Python314\\python.exe'
  if (fs.existsSync('C:\\Python313\\python.exe')) return 'C:\\Python313\\python.exe'
  if (fs.existsSync('C:\\Python312\\python.exe')) return 'C:\\Python312\\python.exe'
  if (fs.existsSync('C:\\Python311\\python.exe')) return 'C:\\Python311\\python.exe'
  return 'python'
}

// Tag and Metadata Storage Path
const SCRIPT_DIR = findWorkspaceRoot()
console.log('[Main] SCRIPT_DIR resolved to:', SCRIPT_DIR)
const TAGS_DB_FILE = join(SCRIPT_DIR, 'file_tags.json')

function loadTagsDb(): Record<string, string[]> {
  try {
    if (fs.existsSync(TAGS_DB_FILE)) {
      return JSON.parse(fs.readFileSync(TAGS_DB_FILE, 'utf-8'))
    }
  } catch (err) {
    console.error('Failed to load tags DB:', err)
  }
  return {}
}

function saveTagsDb(db: Record<string, string[]>): void {
  try {
    fs.writeFileSync(TAGS_DB_FILE, JSON.stringify(db, null, 2), 'utf-8')
  } catch (err) {
    console.error('Failed to save tags DB:', err)
  }
}

// Extract inline tags from filename format: "Document [tag1 tag2].pdf"
function extractFileInlineTags(filename: string): { cleanName: string; tags: string[] } {
  const match = filename.match(/^(.*?)(?:\s*\[(.*?)\])?(\.[^.]*)?$/)
  if (!match) return { cleanName: filename, tags: [] }
  const cleanName = ((match[1] || '') + (match[3] || '')).trim()
  const tagStr = match[2] || ''
  const tags = tagStr.split(/\s+/).filter(t => t.length > 0)
  return { cleanName, tags }
}

function getPreloadPath(): string {
  const mjsPath = join(__dirname, '../preload/index.mjs')
  const cjsPath = join(__dirname, '../preload/index.cjs')
  const jsPath = join(__dirname, '../preload/index.js')
  if (fs.existsSync(mjsPath)) return mjsPath
  if (fs.existsSync(cjsPath)) return cjsPath
  return jsPath
}

function createWindow(): void {
  const preloadPath = getPreloadPath()
  console.log('[Main] Using preload script:', preloadPath)

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0f1d',
    title: 'Arşiv 360 - Akıllı Dosya & Arşiv Gezgini',
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // F12 DevTools & F5 Reload key event listener
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    }
    if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i' && input.type === 'keyDown') {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    }
    if (input.key === 'F5' && input.type === 'keyDown') {
      mainWindow?.webContents.reload()
      event.preventDefault()
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    // Open DevTools in dev mode (F12 or automatically on start)
    const isDev = Boolean(process.env['ELECTRON_RENDERER_URL']) || !app.isPackaged
    if (isDev) {
      console.log('[Main] Dev mode detected: opening DevTools (F12 enabled)')
      mainWindow?.webContents.openDevTools({ mode: 'right' })
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ==========================================
// IPC HANDLERS
// ==========================================

// 1. Python Task Runner
ipcMain.handle('run-python-task', async (event, { taskId, scriptName, args = [] }) => {
  if (runningProcesses.has(taskId)) {
    return { success: false, message: 'Bu görev zaten çalışıyor.' }
  }

  const scriptPath = join(SCRIPT_DIR, scriptName)
  if (!fs.existsSync(scriptPath)) {
    const msg = `Python betiği bulunamadı: ${scriptPath}\n(Çalışma Dizini: ${SCRIPT_DIR})`
    event.sender.send('python-output', { taskId, text: `\n[HATA] ${msg}\n`, stream: 'stderr' })
    event.sender.send('python-exit', { taskId, code: 1 })
    return { success: false, message: msg }
  }

  const pythonExecutable = getPythonExecutable()
  const fullArgs = ['-u', scriptPath, ...args]

  console.log(`[Python] Running: ${pythonExecutable} ${fullArgs.join(' ')} in ${SCRIPT_DIR}`)

  const pyProcess = spawn(pythonExecutable, fullArgs, {
    cwd: SCRIPT_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
  })

  runningProcesses.set(taskId, pyProcess)

  pyProcess.stdout.on('data', (data) => {
    const text = data.toString('utf-8')
    event.sender.send('python-output', { taskId, text, stream: 'stdout' })
  })

  pyProcess.stderr.on('data', (data) => {
    const text = data.toString('utf-8')
    event.sender.send('python-output', { taskId, text, stream: 'stderr' })
  })

  pyProcess.on('close', (code) => {
    runningProcesses.delete(taskId)
    event.sender.send('python-exit', { taskId, code })
  })

  pyProcess.on('error', (err) => {
    runningProcesses.delete(taskId)
    event.sender.send('python-output', { taskId, text: `\nHata: ${err.message}\n`, stream: 'stderr' })
    event.sender.send('python-exit', { taskId, code: -1 })
  })

  return { success: true, pid: pyProcess.pid }
})

ipcMain.handle('stop-python-task', async (_event, { taskId }) => {
  const proc = runningProcesses.get(taskId)
  if (proc) {
    proc.kill('SIGTERM')
    runningProcesses.delete(taskId)
    return { success: true }
  }
  return { success: false, message: 'Çalışan işlem bulunamadı' }
})

// 2. Directory Listing with TagSpaces & Temin-360 Auto-Tags
function collectFilesRecursively(
  dir: string,
  currentDepth: number,
  maxDepth: number,
  tagsDb: Record<string, string[]>,
  acc: any[],
  maxFiles = 2500
): void {
  if (currentDepth > maxDepth || acc.length >= maxFiles) return
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const ent of entries) {
      if (acc.length >= maxFiles) break
      if (ent.name.startsWith('$') || ent.name.startsWith('.') || ent.name === 'System Volume Information' || ent.name === 'found.000' || ent.name === 'node_modules' || ent.name === '$RECYCLE.BIN') {
        continue
      }
      const fullPath = join(dir, ent.name)
      let size = 0
      let mtime = 0
      try {
        const stat = fs.statSync(fullPath)
        size = stat.size
        mtime = stat.mtimeMs
      } catch {}

      const isDir = ent.isDirectory()
      const ext = isDir ? '' : extname(ent.name).toLowerCase()
      const { cleanName, tags: inlineTags } = extractFileInlineTags(ent.name)
      const storedTags = tagsDb[fullPath] || []

      // Smart auto-tags based on file category and name
      const autoTags: string[] = []
      const lower = (fullPath + ' ' + ent.name).toLowerCase()
      if (lower.includes('temin') || lower.includes('ihale') || lower.includes('alim')) autoTags.push('ihale', 'temin360')
      if (lower.includes('hakedis') || lower.includes('metraj') || lower.includes('kesif')) autoTags.push('hakedis', 'maliyet')
      if (lower.includes('imar') || lower.includes('parsel') || lower.includes('18. madde') || lower.includes('ada')) autoTags.push('imar')
      if (lower.includes('kamulastirma') || lower.includes('istimlak') || lower.includes('tapu')) autoTags.push('kamulastirma')
      if (['.dwg', '.dxf', '.ncz', '.ncp', '.shp', '.kml'].includes(ext)) autoTags.push('cad-harita')
      if (['.xlsx', '.xls', '.csv'].includes(ext)) autoTags.push('tablo')
      if (['.pdf', '.docx', '.doc'].includes(ext)) autoTags.push('belge')
      if (['.jpg', '.jpeg', '.png', '.mp4'].includes(ext)) autoTags.push('medya')

      const allTags = Array.from(new Set([...inlineTags, ...storedTags, ...autoTags]))

      acc.push({
        name: ent.name,
        cleanName,
        path: fullPath,
        isDirectory: isDir,
        size,
        mtime,
        ext,
        tags: allTags
      })

      if (isDir && currentDepth < maxDepth) {
        collectFilesRecursively(fullPath, currentDepth + 1, maxDepth, tagsDb, acc, maxFiles)
      }
    }
  } catch {}
}

ipcMain.handle('get-system-drives', async () => {
  const drives: { letter: string; path: string; label: string; isReady: boolean }[] = []
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  for (const l of letters) {
    const root = `${l}:\\`
    try {
      if (fs.existsSync(root)) {
        let label = `Sürücü (${l}:)`
        if (l === 'C') label = 'Yerel Disk (C:)'
        else if (l === 'D') label = 'Disk (D:)'
        else if (l === 'E') label = 'USB / Disk (E:)'
        drives.push({
          letter: l,
          path: root,
          label,
          isReady: true
        })
      }
    } catch {}
  }
  return drives
})

ipcMain.handle('select-folder', async () => {
  if (!mainWindow) return null
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'dontAddToRecent'],
    title: 'Arşiv / Taranacak Klasörü Seçin'
  })
  if (!res.canceled && res.filePaths.length > 0) {
    return res.filePaths[0]
  }
  return null
})

ipcMain.handle('list-directory', async (_event, dirPath: string, options?: { maxDepth?: number; maxFiles?: number }) => {
  try {
    let targetDir = dirPath
    if (!targetDir || !fs.existsSync(targetDir)) {
      if (fs.existsSync('D:\\E_BIRLESTIRME')) targetDir = 'D:\\E_BIRLESTIRME'
      else if (fs.existsSync('D:\\')) targetDir = 'D:\\'
      else if (fs.existsSync('E:\\')) targetDir = 'E:\\'
      else if (fs.existsSync('C:\\')) targetDir = 'C:\\'
      else targetDir = SCRIPT_DIR
    }

    // Direct child subfolders with counts
    const subfolders: { name: string; path: string; fileCount: number }[] = []
    try {
      const dirEntries = fs.readdirSync(targetDir, { withFileTypes: true })
      for (const d of dirEntries) {
        if (
          d.isDirectory() &&
          !d.name.startsWith('.') &&
          !d.name.startsWith('$') &&
          d.name !== 'node_modules' &&
          d.name !== 'System Volume Information' &&
          d.name !== 'found.000' &&
          d.name !== '$RECYCLE.BIN'
        ) {
          const subPath = join(targetDir, d.name)
          let count = 0
          try {
            count = fs.readdirSync(subPath).length
          } catch {}
          subfolders.push({ name: d.name, path: subPath, fileCount: count })
        }
      }
    } catch {}

    const maxDepth = typeof options?.maxDepth === 'number' ? options.maxDepth : 2
    const maxFiles = typeof options?.maxFiles === 'number' ? options.maxFiles : 2500

    const tagsDb = loadTagsDb()
    const items: any[] = []
    collectFilesRecursively(targetDir, 0, maxDepth, tagsDb, items, maxFiles)

    return { success: true, items, targetDir, subfolders }
  } catch (err: any) {
    return { success: false, message: err.message, items: [], subfolders: [] }
  }
})

// 3. Tag Management
ipcMain.handle('add-file-tag', async (_event, { filePath, tag }) => {
  const db = loadTagsDb()
  const list = db[filePath] || []
  if (!list.includes(tag)) {
    list.push(tag)
    db[filePath] = list
    saveTagsDb(db)
  }
  return { success: true, tags: list }
})

ipcMain.handle('remove-file-tag', async (_event, { filePath, tag }) => {
  const db = loadTagsDb()
  const list = db[filePath] || []
  db[filePath] = list.filter(t => t !== tag)
  saveTagsDb(db)
  return { success: true, tags: db[filePath] }
})

// 4. Shell Integration
ipcMain.handle('open-file', async (_event, filePath: string) => {
  return shell.openPath(filePath)
})

ipcMain.handle('show-in-folder', async (_event, filePath: string) => {
  shell.showItemInFolder(filePath)
  return true
})

// 5. Read System Reports
ipcMain.handle('get-migration-reports', async () => {
  const reports: Record<string, any> = {}
  try {
    const dupJson = join(SCRIPT_DIR, 'duplicate_report.json')
    if (fs.existsSync(dupJson)) {
      reports.duplicate = JSON.parse(fs.readFileSync(dupJson, 'utf-8'))
    }
    const migJson = join(SCRIPT_DIR, 'migration_plan.json')
    if (fs.existsSync(migJson)) {
      reports.migration = JSON.parse(fs.readFileSync(migJson, 'utf-8'))
    }
  } catch (err) {
    console.error('Error reading reports:', err)
  }
  return reports
})
