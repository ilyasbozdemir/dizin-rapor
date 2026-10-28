import { resolve, join, basename, extname } from 'path'
import * as fs from 'fs'
import { spawn, exec, ChildProcessWithoutNullStreams } from 'child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const WORKSPACE_ROOT = resolve(__dirname, '../..')
const TAGS_DB_FILE = join(WORKSPACE_ROOT, 'file_tags.json')

function getPythonExecutable(): string {
  if (fs.existsSync('C:\\Python314\\python.exe')) return 'C:\\Python314\\python.exe'
  if (fs.existsSync('C:\\Python313\\python.exe')) return 'C:\\Python313\\python.exe'
  if (fs.existsSync('C:\\Python312\\python.exe')) return 'C:\\Python312\\python.exe'
  if (fs.existsSync('C:\\Python311\\python.exe')) return 'C:\\Python311\\python.exe'
  return 'python'
}

function loadTagsDb(): Record<string, string[]> {
  try {
    if (fs.existsSync(TAGS_DB_FILE)) {
      return JSON.parse(fs.readFileSync(TAGS_DB_FILE, 'utf-8'))
    }
  } catch {}
  return {}
}

function saveTagsDb(db: Record<string, string[]>): void {
  try {
    fs.writeFileSync(TAGS_DB_FILE, JSON.stringify(db, null, 2), 'utf-8')
  } catch {}
}

function extractFileInlineTags(filename: string): { cleanName: string; tags: string[] } {
  const match = filename.match(/^(.*?)(?:\s*\[(.*?)\])?(\.[^.]*)?$/)
  if (!match) return { cleanName: filename, tags: [] }
  const cleanName = ((match[1] || '') + (match[3] || '')).trim()
  const tagStr = match[2] || ''
  const tags = tagStr.split(/\s+/).filter((t) => t.length > 0)
  return { cleanName, tags }
}

function formatDriveCapacity(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1000) return `${(gb / 1024).toFixed(1)} TB`
  return `${Math.round(gb)} GB`
}

function collectFilesBFS(rootDir: string, maxDepth: number, tagsDb: Record<string, string[]>, maxFiles = 5000): any[] {
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

function realDiskApiPlugin(): Plugin {
  const runningProcesses = new Map<string, ChildProcessWithoutNullStreams>()
  const sseClients = new Set<any>()

  const broadcastEvent = (type: string, payload: any) => {
    const msg = `data: ${JSON.stringify({ type, payload })}\n\n`
    sseClients.forEach((res) => {
      try {
        res.write(msg)
      } catch {}
    })
  }

  return {
    name: 'real-disk-api-middleware',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/__api/')) return next()

        const urlObj = new URL(req.url, 'http://localhost')
        const endpoint = urlObj.pathname.replace('/__api/', '')

        if (endpoint === 'events' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })
          res.write('\n')
          sseClients.add(res)
          req.on('close', () => sseClients.delete(res))
          return
        }

        let body: any = {}
        if (req.method === 'POST') {
          const chunks: Buffer[] = []
          for await (const chunk of req) {
            chunks.push(Buffer.from(chunk))
          }
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          } catch {}
        }

        const sendJson = (data: any) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(data))
        }

        try {
          if (endpoint === 'get-system-drives') {
            const drives: any[] = []
            for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
              const root = `${l}:\\`
              try {
                if (fs.existsSync(root)) {
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
                  drives.push({ letter: l, path: root, label, isReady: true, totalBytes, freeBytes, sizeText })
                }
              } catch {}
            }
            return sendJson(drives)
          }

          if (endpoint === 'list-directory') {
            let targetDir = (body.dirPath || '').trim()
            if (/^[a-zA-Z]:$/.test(targetDir)) targetDir = targetDir.toUpperCase() + '\\'
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
              for (const fallback of ['D:\\', 'E:\\', 'C:\\', WORKSPACE_ROOT]) {
                try {
                  if (fs.existsSync(fallback)) {
                    fs.readdirSync(fallback)
                    targetDir = fallback
                    break
                  }
                } catch {}
              }
            }
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
            const maxDepth = typeof body.options?.maxDepth === 'number' ? body.options.maxDepth : 2
            const maxFiles = typeof body.options?.maxFiles === 'number' ? body.options.maxFiles : 5000
            const items = collectFilesBFS(targetDir, maxDepth, loadTagsDb(), maxFiles)
            return sendJson({ success: true, items, targetDir, subfolders })
          }

          if (endpoint === 'get-migration-reports') {
            const reports: Record<string, any> = {}
            const dupJson = join(WORKSPACE_ROOT, 'duplicate_report.json')
            if (fs.existsSync(dupJson)) {
              reports.duplicate = JSON.parse(fs.readFileSync(dupJson, 'utf-8'))
            }
            const migJson = join(WORKSPACE_ROOT, 'migration_plan.json')
            if (fs.existsSync(migJson)) {
              reports.migration = JSON.parse(fs.readFileSync(migJson, 'utf-8'))
            }
            return sendJson(reports)
          }

          if (endpoint === 'run-python-task') {
            const { taskId, scriptName, args = [] } = body
            if (runningProcesses.has(taskId)) {
              return sendJson({ success: false, message: 'Bu görev zaten çalışıyor.' })
            }
            const scriptPath = join(WORKSPACE_ROOT, scriptName)
            if (!fs.existsSync(scriptPath)) {
              return sendJson({ success: false, message: `Betik bulunamadı: ${scriptPath}` })
            }
            const pyProcess = spawn(getPythonExecutable(), ['-u', scriptPath, ...args], {
              cwd: WORKSPACE_ROOT,
              env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
            })
            runningProcesses.set(taskId, pyProcess)
            pyProcess.stdout.on('data', (data) => {
              broadcastEvent('python-output', { taskId, text: data.toString('utf-8'), stream: 'stdout' })
            })
            pyProcess.stderr.on('data', (data) => {
              broadcastEvent('python-output', { taskId, text: data.toString('utf-8'), stream: 'stderr' })
            })
            pyProcess.on('close', (code) => {
              runningProcesses.delete(taskId)
              broadcastEvent('python-exit', { taskId, code })
            })
            pyProcess.on('error', (err) => {
              runningProcesses.delete(taskId)
              broadcastEvent('python-output', { taskId, text: `\nHata: ${err.message}\n`, stream: 'stderr' })
              broadcastEvent('python-exit', { taskId, code: -1 })
            })
            return sendJson({ success: true, pid: pyProcess.pid })
          }

          if (endpoint === 'stop-python-task') {
            const proc = runningProcesses.get(body.taskId)
            if (proc) {
              proc.kill('SIGTERM')
              runningProcesses.delete(body.taskId)
              return sendJson({ success: true })
            }
            return sendJson({ success: false, message: 'Çalışan işlem bulunamadı' })
          }

          if (endpoint === 'check-files-exist') {
            const result: Record<string, boolean> = {}
            for (const fp of body.filePaths || []) {
              try {
                result[fp] = fs.existsSync(fp)
              } catch {
                result[fp] = false
              }
            }
            return sendJson(result)
          }

          if (endpoint === 'add-file-tag') {
            const db = loadTagsDb()
            const list = db[body.filePath] || []
            if (!list.includes(body.tag)) {
              list.push(body.tag)
              db[body.filePath] = list
              saveTagsDb(db)
            }
            return sendJson({ success: true, tags: list })
          }

          if (endpoint === 'remove-file-tag') {
            const db = loadTagsDb()
            db[body.filePath] = (db[body.filePath] || []).filter((t) => t !== body.tag)
            saveTagsDb(db)
            return sendJson({ success: true, tags: db[body.filePath] })
          }

          if (endpoint === 'open-file') {
            exec(`start "" "${body.filePath}"`)
            return sendJson({ success: true })
          }

          if (endpoint === 'show-in-folder') {
            exec(`explorer.exe /select,"${body.filePath}"`)
            return sendJson({ success: true })
          }

          return sendJson({ success: false, message: 'Bilinmeyen uç nokta' })
        } catch (err: any) {
          return sendJson({ success: false, message: err.message })
        }
      })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@arsiv/core': resolve(__dirname, '../../packages/arsiv-core/src')
      }
    },
    plugins: [react(), realDiskApiPlugin()]
  }
})
