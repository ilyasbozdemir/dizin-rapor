export interface SystemDrive {
  letter: string
  path: string
  label: string
  isReady: boolean
  totalBytes?: number
  freeBytes?: number
  sizeText?: string
}

export interface ListDirectoryOptions {
  maxDepth?: number
  maxFiles?: number
}

export interface IApi {
  runPythonTask: (params: { taskId: string; scriptName: string; args?: string[] }) => Promise<{ success: boolean; pid?: number; message?: string }>
  stopPythonTask: (params: { taskId: string }) => Promise<{ success: boolean; message?: string }>
  onPythonOutput: (callback: (data: { taskId: string; text: string; stream: 'stdout' | 'stderr' }) => void) => () => void
  onPythonExit: (callback: (data: { taskId: string; code: number }) => void) => () => void
  getSystemDrives: () => Promise<SystemDrive[]>
  listDirectory: (dirPath: string, options?: ListDirectoryOptions) => Promise<{ success: boolean; items: any[]; subfolders?: { name: string; path: string; fileCount: number }[]; targetDir?: string; message?: string }>
  selectFolder: () => Promise<string | null>
  addFileTag: (params: { filePath: string; tag: string }) => Promise<{ success: boolean; tags: string[] }>
  removeFileTag: (params: { filePath: string; tag: string }) => Promise<{ success: boolean; tags: string[] }>
  openFile: (filePath: string) => Promise<string>
  showInFolder: (filePath: string) => Promise<boolean>
  getMigrationReports: () => Promise<any>
  checkFilesExist: (filePaths: string[]) => Promise<Record<string, boolean>>
  moveFiles: (params: { filePaths: string[]; destinationFolder?: string }) => Promise<{ success: boolean; successCount: number; failCount: number; errors: { path: string; error: string }[]; targetFolder?: string }>
  deleteFiles: (params: { filePaths: string[]; useRecycleBin?: boolean }) => Promise<{ success: boolean; successCount: number; failCount: number; errors: { path: string; error: string }[] }>
}

const outputListeners = new Set<(data: { taskId: string; text: string; stream: 'stdout' | 'stderr' }) => void>()
const exitListeners = new Set<(data: { taskId: string; code: number }) => void>()
let sseInitialized = false

function ensureSseConnected(): void {
  if (sseInitialized || typeof window === 'undefined' || Boolean(window.api)) return
  sseInitialized = true
  try {
    const es = new EventSource('/__api/events')
    es.onmessage = (ev) => {
      try {
        const { type, payload } = JSON.parse(ev.data)
        if (type === 'python-output') {
          outputListeners.forEach((fn) => fn(payload))
        } else if (type === 'python-exit') {
          exitListeners.forEach((fn) => fn(payload))
        }
      } catch {}
    }
  } catch {}
}

async function postApi(endpoint: string, body: any = {}): Promise<any> {
  const res = await fetch(`/__api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return res.json()
}

// Real HTTP Disk Bridge when running in web browser via Vite dev server (NO MOCK / SAMPLE DATA)
const httpDiskApi: IApi = {
  runPythonTask: async (params) => {
    ensureSseConnected()
    return postApi('run-python-task', params)
  },

  stopPythonTask: async (params) => {
    return postApi('stop-python-task', params)
  },

  onPythonOutput: (callback) => {
    ensureSseConnected()
    outputListeners.add(callback)
    return () => outputListeners.delete(callback)
  },

  onPythonExit: (callback) => {
    ensureSseConnected()
    exitListeners.add(callback)
    return () => exitListeners.delete(callback)
  },

  getSystemDrives: async () => {
    return postApi('get-system-drives')
  },

  listDirectory: async (dirPath: string, options?: ListDirectoryOptions) => {
    return postApi('list-directory', { dirPath, options })
  },

  selectFolder: async () => {
    const custom = prompt('Taranacak gerçek klasör veya sürücü yolunu girin (Örn: D:\\ veya C:\\):', 'D:\\')
    return custom ? custom.trim() : null
  },

  addFileTag: async (params) => {
    return postApi('add-file-tag', params)
  },

  removeFileTag: async (params) => {
    return postApi('remove-file-tag', params)
  },

  openFile: async (filePath: string) => {
    await postApi('open-file', { filePath })
    return filePath
  },

  showInFolder: async (filePath: string) => {
    await postApi('show-in-folder', { filePath })
    return true
  },

  getMigrationReports: async () => {
    return postApi('get-migration-reports')
  },

  checkFilesExist: async (filePaths: string[]) => {
    return postApi('check-files-exist', { filePaths })
  },

  moveFiles: async (params) => {
    return postApi('move-files', params)
  },

  deleteFiles: async (params) => {
    return postApi('delete-files', params)
  }
}

export const isElectron = typeof window !== 'undefined' && Boolean(window.api)

export const api: IApi = typeof window !== 'undefined' && window.api ? window.api : httpDiskApi

if (typeof window !== 'undefined' && !window.api) {
  ;(window as any).api = httpDiskApi
}

export default api
