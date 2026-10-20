import { contextBridge, ipcRenderer } from 'electron'

export interface SystemDrive {
  letter: string
  path: string
  label: string
  isReady: boolean
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

const api: IApi = {
  runPythonTask: (params) => ipcRenderer.invoke('run-python-task', params),
  stopPythonTask: (params) => ipcRenderer.invoke('stop-python-task', params),
  onPythonOutput: (callback) => {
    const sub = (_event: any, data: any) => callback(data)
    ipcRenderer.on('python-output', sub)
    return () => ipcRenderer.removeListener('python-output', sub)
  },
  onPythonExit: (callback) => {
    const sub = (_event: any, data: any) => callback(data)
    ipcRenderer.on('python-exit', sub)
    return () => ipcRenderer.removeListener('python-exit', sub)
  },
  getSystemDrives: () => ipcRenderer.invoke('get-system-drives'),
  listDirectory: (dirPath, options) => ipcRenderer.invoke('list-directory', dirPath, options),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  addFileTag: (params) => ipcRenderer.invoke('add-file-tag', params),
  removeFileTag: (params) => ipcRenderer.invoke('remove-file-tag', params),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  getMigrationReports: () => ipcRenderer.invoke('get-migration-reports'),
  checkFilesExist: (filePaths) => ipcRenderer.invoke('check-files-exist', filePaths),
  moveFiles: (params) => ipcRenderer.invoke('move-files', params),
  deleteFiles: (params) => ipcRenderer.invoke('delete-files', params)
}

contextBridge.exposeInMainWorld('api', api)
