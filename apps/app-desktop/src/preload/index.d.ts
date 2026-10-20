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

declare global {
  interface Window {
    api: IApi
  }
}
