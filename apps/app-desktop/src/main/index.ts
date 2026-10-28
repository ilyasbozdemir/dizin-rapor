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
  const cjsPath = join(__dirname, '../preload/index.cjs')
  const jsPath = join(__dirname, '../preload/index.js')
  const mjsPath = join(__dirname, '../preload/index.mjs')
  if (fs.existsSync(cjsPath)) return cjsPath
  if (fs.existsSync(jsPath)) return jsPath
  return mjsPath
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

// 2. Directory Listing with Breadth-First Real Disk Traversal & Auto-Tags
function collectFilesBFS(
  rootDir: string,
  maxDepth: number,
  tagsDb: Record<string, string[]>,
  maxFiles = 5000
): any[] {
  const acc: any[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: rootDir, depth: 0 }]

  while (queue.length > 0 && acc.length < maxFiles) {
    const { dir, depth } = queue.shift()!
    if (depth > maxDepth) continue

    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const ent of entries) {
      if (acc.length >= maxFiles) break
      const nameL = ent.name.toLowerCase()
      if (
        ent.name.startsWith('$') ||
        ent.name.startsWith('.') ||
        ent.name.startsWith('~$') ||
        nameL === 'system volume information' ||
        nameL.startsWith('found.00') ||
        nameL === 'node_modules' ||
        nameL === '$recycle.bin' ||
        nameL === 'pagefile.sys' ||
        nameL === 'hiberfil.sys' ||
        nameL === 'swapfile.sys' ||
        nameL.startsWith('dumpstack.log')
      ) {
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

      if (isDir && depth < maxDepth) {
        queue.push({ dir: fullPath, depth: depth + 1 })
      }
    }
  }
  return acc
}

function formatDriveCapacity(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1000) return `${(gb / 1024).toFixed(1)} TB`
  return `${Math.round(gb)} GB`
}

ipcMain.handle('get-system-drives', async () => {
  const drives: {
    letter: string
    path: string
    label: string
    isReady: boolean
    totalBytes?: number
    freeBytes?: number
    sizeText?: string
  }[] = []
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  for (const l of letters) {
    const root = `${l}:\\`
    try {
      if (fs.existsSync(root)) {
        // Verify the volume is mounted and readable
        fs.readdirSync(root)
        let totalBytes = 0
        let freeBytes = 0
        let sizeText = ''
        try {
          if (typeof fs.statfsSync === 'function') {
            const st = fs.statfsSync(root)
            totalBytes = st.bsize * st.blocks
            freeBytes = st.bsize * st.bavail
            sizeText = formatDriveCapacity(totalBytes)
          }
        } catch {}

        let label = `Sürücü (${l}:)`
        if (l === 'C') label = `Yerel Disk (C:)${sizeText ? ' • ' + sizeText : ''}`
        else if (l === 'D') label = `Depo Disk (D:)${sizeText ? ' • ' + sizeText : ''}`
        else if (l === 'E') label = `Harici / USB (E:)${sizeText ? ' • ' + sizeText : ''}`
        else if (sizeText) label = `Disk (${l}:) • ${sizeText}`

        drives.push({
          letter: l,
          path: root,
          label,
          isReady: true,
          totalBytes,
          freeBytes,
          sizeText
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
    let targetDir = (dirPath || '').trim()
    if (/^[a-zA-Z]:$/.test(targetDir)) {
      targetDir = targetDir.toUpperCase() + '\\'
    }

    let isAccessible = false
    if (targetDir) {
      try {
        if (fs.existsSync(targetDir)) {
          fs.readdirSync(targetDir)
          isAccessible = true
        }
      } catch {}
    }

    if (!isAccessible) {
      // Fall back to a real mounted drive (D:\ or C:\)
      for (const fallback of ['D:\\', 'E:\\', 'C:\\', SCRIPT_DIR]) {
        try {
          if (fs.existsSync(fallback)) {
            fs.readdirSync(fallback)
            targetDir = fallback
            break
          }
        } catch {}
      }
    }

    // Direct child subfolders with real item counts
    const subfolders: { name: string; path: string; fileCount: number }[] = []
    try {
      const dirEntries = fs.readdirSync(targetDir, { withFileTypes: true })
      for (const d of dirEntries) {
        const nameL = d.name.toLowerCase()
        if (
          d.isDirectory() &&
          !d.name.startsWith('.') &&
          !d.name.startsWith('$') &&
          nameL !== 'node_modules' &&
          nameL !== 'system volume information' &&
          !nameL.startsWith('found.00') &&
          nameL !== '$recycle.bin'
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
    const maxFiles = typeof options?.maxFiles === 'number' ? options.maxFiles : 5000

    const tagsDb = loadTagsDb()
    const items = collectFilesBFS(targetDir, maxDepth, tagsDb, maxFiles)

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

// 6. Real-time File Existence & Direct Management
ipcMain.handle('check-files-exist', async (_event, filePaths: string[]) => {
  const result: Record<string, boolean> = {}
  if (!Array.isArray(filePaths)) return result
  for (const fp of filePaths) {
    try {
      result[fp] = fs.existsSync(fp)
    } catch {
      result[fp] = false
    }
  }
  return result
})

ipcMain.handle('move-files', async (_event, { filePaths, destinationFolder }: { filePaths: string[]; destinationFolder?: string }) => {
  let successCount = 0
  let failCount = 0
  const errors: { path: string; error: string }[] = []

  for (const src of filePaths) {
    try {
      if (!fs.existsSync(src)) {
        failCount++
        errors.push({ path: src, error: 'Dosya bulunamadı' })
        continue
      }

      const driveMatch = src.match(/^([a-zA-Z]:)[\\/]/)
      const driveRoot = driveMatch ? `${driveMatch[1]}\\` : 'C:\\'
      const relPath = driveMatch ? src.substring(driveMatch[0].length) : src.replace(/^[\\/]+/, '')
      const fileName = basename(src)
      const relDir = relPath.length > fileName.length ? relPath.substring(0, relPath.length - fileName.length).replace(/[\\/]+$/, '') : ''

      let destDir = destinationFolder
      if (!destDir) {
        // Hedef klasör belirtilmediğinde dosyanın ait olduğu sürücü kökündeki _SILINECEK_KOPYALAR altında göreli yolu koru
        destDir = relDir ? join(driveRoot, '_SILINECEK_KOPYALAR', relDir) : join(driveRoot, '_SILINECEK_KOPYALAR')
      } else if (relDir && !destinationFolder.includes(relDir)) {
        destDir = join(destinationFolder, relDir)
      }

      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true })
      }

      let destPath = join(destDir, fileName)

      // Karantina hedefinde aynı isimli dosya varsa ASLA üzerine yazma; _kopya_N soneki ekle
      if (fs.existsSync(destPath)) {
        const ext = extname(fileName)
        const nameWithoutExt = basename(fileName, ext)
        let idx = 1
        while (fs.existsSync(destPath)) {
          destPath = join(destDir, `${nameWithoutExt}_kopya_${idx}${ext}`)
          idx++
        }
      }

      try {
        fs.renameSync(src, destPath)
      } catch (e: any) {
        if (e.code === 'EXDEV') {
          fs.copyFileSync(src, destPath)
          fs.unlinkSync(src)
        } else {
          throw e
        }
      }

      successCount++
    } catch (err: any) {
      failCount++
      errors.push({ path: src, error: err.message })
    }
  }

  return { success: failCount === 0, successCount, failCount, errors, targetFolder: destinationFolder }
})

ipcMain.handle('delete-files', async (_event, { filePaths, useRecycleBin = true }: { filePaths: string[]; useRecycleBin?: boolean }) => {
  let successCount = 0
  let failCount = 0
  const errors: { path: string; error: string }[] = []

  for (const src of filePaths) {
    try {
      if (!fs.existsSync(src)) {
        failCount++
        errors.push({ path: src, error: 'Dosya bulunamadı' })
        continue
      }

      if (useRecycleBin) {
        await shell.trashItem(src)
      } else {
        fs.unlinkSync(src)
      }
      successCount++
    } catch (err: any) {
      failCount++
      errors.push({ path: src, error: err.message })
    }
  }

  return { success: failCount === 0, successCount, failCount, errors }
})
