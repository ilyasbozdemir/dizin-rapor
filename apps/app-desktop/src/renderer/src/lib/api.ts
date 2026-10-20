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

// Preset mock data for browser preview or fallback
const MOCK_FILES = [
  {
    name: '2022_649846_Kapali_Spor_Salonu_Ihale.pdf',
    cleanName: '2022_649846_Kapali_Spor_Salonu_Ihale',
    path: 'D:\\E_BIRLESTIRME\\06_İHALE_ve_ALIM_İŞLERİ\\2022_649846_Kapali_Spor_Salonu_Ihale.pdf',
    isDirectory: false,
    size: 173160000,
    mtime: Date.now() - 1000 * 60 * 60 * 24 * 5,
    ext: '.pdf',
    tags: ['ihale', 'temin360', 'onayli', '2026']
  },
  {
    name: 'Pinar_Gozu_Park_Spor_Alani_Hakedis.xlsx',
    cleanName: 'Pinar_Gozu_Park_Spor_Alani_Hakedis',
    path: 'D:\\E_BIRLESTIRME\\06_İHALE_ve_ALIM_İŞLERİ\\Pinar_Gozu_Park_Spor_Alani_Hakedis.xlsx',
    isDirectory: false,
    size: 2450000,
    mtime: Date.now() - 1000 * 60 * 60 * 24 * 2,
    ext: '.xlsx',
    tags: ['hakedis', 'temin360', 'tablo']
  },
  {
    name: '406_Ada_25_26_Parsel_18_Madde_Plani.dwg',
    cleanName: '406_Ada_25_26_Parsel_18_Madde_Plani',
    path: 'D:\\E_BIRLESTIRME\\04_İMAR_UYGULAMALARI\\406_Ada_25_26_Parsel_18_Madde_Plani.dwg',
    isDirectory: false,
    size: 36060000,
    mtime: Date.now() - 1000 * 60 * 60 * 24 * 10,
    ext: '.dwg',
    tags: ['imar', 'cad-harita', '18.madde']
  },
  {
    name: 'Belediye_Kurumsal_Logo.png',
    cleanName: 'Belediye_Kurumsal_Logo',
    path: 'D:\\E_BIRLESTIRME\\00_KURUMSAL_MEDYA\\Belediye_Kurumsal_Logo.png',
    isDirectory: false,
    size: 1540000,
    mtime: Date.now() - 1000 * 60 * 60 * 24 * 30,
    ext: '.png',
    tags: ['kurumsal', 'medya', 'logo']
  },
  {
    name: 'Kamulastirma_Anlasma_Tutanaklari.docx',
    cleanName: 'Kamulastirma_Anlasma_Tutanaklari',
    path: 'D:\\E_BIRLESTIRME\\03_KAMULAŞTIRMA\\Kamulastirma_Anlasma_Tutanaklari.docx',
    isDirectory: false,
    size: 890000,
    mtime: Date.now() - 1000 * 60 * 60 * 24 * 15,
    ext: '.docx',
    tags: ['kamulastirma', 'belge']
  },
  {
    name: 'Kanalizasyon_ve_Yol_Altyapi_Projesi.dwg',
    cleanName: 'Kanalizasyon_ve_Yol_Altyapi_Projesi',
    path: 'D:\\E_BIRLESTIRME\\07_ALTYAPI_YOL_KANAL\\Kanalizasyon_ve_Yol_Altyapi_Projesi.dwg',
    isDirectory: false,
    size: 42100000,
    mtime: Date.now() - 1000 * 60 * 60 * 24 * 7,
    ext: '.dwg',
    tags: ['cad-harita', 'altyapi']
  },
  {
    name: 'Zabita_Pazar_Yeri_Denetim_Tutanagi.pdf',
    cleanName: 'Zabita_Pazar_Yeri_Denetim_Tutanagi',
    path: 'D:\\E_BIRLESTIRME\\09_ZABİTA_DENETİM\\Zabita_Pazar_Yeri_Denetim_Tutanagi.pdf',
    isDirectory: false,
    size: 650000,
    mtime: Date.now() - 1000 * 60 * 60 * 24 * 1,
    ext: '.pdf',
    tags: ['zabita', 'denetim', 'belge']
  }
]

const MOCK_REPORTS = {
  duplicate: null,
  migration: null
}

// In-memory state for web browser preview
let mockFilesState = [...MOCK_FILES]
const outputListeners = new Set<(data: { taskId: string; text: string; stream: 'stdout' | 'stderr' }) => void>()
const exitListeners = new Set<(data: { taskId: string; code: number }) => void>()

const mockApi: IApi = {
  runPythonTask: async ({ taskId, scriptName, args = [] }: { taskId: string; scriptName: string; args?: string[] }) => {
    console.warn(`[Electron Gerekli] ${scriptName} işlemi doğrudan masaüstü uygulamasında çalıştırılmalıdır.`, args)
    outputListeners.forEach((fn) =>
      fn({
        taskId,
        text: `[HATA] Python betikleri (${scriptName}) yalnızca Electron masaüstü uygulamasında çalıştırılabilir.\nTarayıcı önizlemesinde doğrudan sistem süreçleri yürütülemez.\nKomut: python ${scriptName} ${args.join(' ')}\n`,
        stream: 'stderr'
      })
    )
    exitListeners.forEach((fn) => fn({ taskId, code: 1 }))
    return { success: false, message: 'Python betiği çalıştırmak için Electron uygulamasını kullanın.' }
  },

  stopPythonTask: async (_params: { taskId: string }) => {
    return { success: true }
  },

  onPythonOutput: (callback: (data: { taskId: string; text: string; stream: 'stdout' | 'stderr' }) => void) => {
    outputListeners.add(callback)
    return () => outputListeners.delete(callback)
  },

  onPythonExit: (callback: (data: { taskId: string; code: number }) => void) => {
    exitListeners.add(callback)
    return () => exitListeners.delete(callback)
  },

  getSystemDrives: async () => {
    return [
      { letter: 'C', path: 'C:\\', label: 'Yerel Disk (C:)', isReady: true },
      { letter: 'D', path: 'D:\\', label: 'Disk (D:)', isReady: true },
      { letter: 'E', path: 'E:\\', label: 'USB / Disk (E:)', isReady: true }
    ]
  },

  listDirectory: async (dirPath: string, _options?: ListDirectoryOptions) => {
    console.log(`[MockApi] listDirectory called for: ${dirPath}`)
    const mockSubfolders = [
      { name: '00_KURUMSAL_MEDYA', path: `${dirPath}\\00_KURUMSAL_MEDYA`, fileCount: 142 },
      { name: '03_KAMULAŞTIRMA', path: `${dirPath}\\03_KAMULAŞTIRMA`, fileCount: 89 },
      { name: '04_İMAR_UYGULAMALARI', path: `${dirPath}\\04_İMAR_UYGULAMALARI`, fileCount: 312 },
      { name: '06_İHALE_ve_ALIM_İŞLERİ', path: `${dirPath}\\06_İHALE_ve_ALIM_İŞLERİ`, fileCount: 640 },
      { name: '07_ALTYAPI_YOL_KANAL', path: `${dirPath}\\07_ALTYAPI_YOL_KANAL`, fileCount: 95 },
      { name: '09_ZABİTA_DENETİM', path: `${dirPath}\\09_ZABİTA_DENETİM`, fileCount: 48 }
    ]
    return {
      success: true,
      items: mockFilesState,
      subfolders: mockSubfolders,
      targetDir: dirPath,
      message: 'Mock web preview'
    }
  },

  selectFolder: async () => {
    const custom = prompt('Taranacak klasör yolunu girin:', 'D:\\E_BIRLESTIRME')
    return custom || null
  },

  addFileTag: async ({ filePath, tag }: { filePath: string; tag: string }) => {
    mockFilesState = mockFilesState.map((f) => {
      if (f.path === filePath && !f.tags.includes(tag)) {
        return { ...f, tags: [...f.tags, tag] }
      }
      return f
    })
    const found = mockFilesState.find((f) => f.path === filePath)
    return { success: true, tags: found ? found.tags : [tag] }
  },

  removeFileTag: async ({ filePath, tag }: { filePath: string; tag: string }) => {
    mockFilesState = mockFilesState.map((f) => {
      if (f.path === filePath) {
        return { ...f, tags: f.tags.filter((t) => t !== tag) }
      }
      return f
    })
    const found = mockFilesState.find((f) => f.path === filePath)
    return { success: true, tags: found ? found.tags : [] }
  },

  openFile: async (filePath: string) => {
    console.log(`[MockApi] openFile: ${filePath}`)
    alert(`Dosya Açılıyor: ${filePath}`)
    return filePath
  },

  showInFolder: async (filePath: string) => {
    console.log(`[MockApi] showInFolder: ${filePath}`)
    alert(`Klasörde Gösteriliyor: ${filePath}`)
    return true
  },

  getMigrationReports: async () => {
    return MOCK_REPORTS
  },

  checkFilesExist: async (filePaths: string[]) => {
    const res: Record<string, boolean> = {}
    filePaths.forEach((p) => {
      res[p] = true // mock assumption: all exist initially
    })
    return res
  },

  moveFiles: async ({ filePaths, destinationFolder }: { filePaths: string[]; destinationFolder?: string }) => {
    console.log(`[MockApi] moveFiles to ${destinationFolder || '_SILINECEK_KOPYALAR'}:`, filePaths)
    alert(`${filePaths.length} adet dosya başarıyla '${destinationFolder || '_SILINECEK_KOPYALAR'}' klasörüne taşındı!`)
    return { success: true, successCount: filePaths.length, failCount: 0, errors: [], targetFolder: destinationFolder }
  },

  deleteFiles: async ({ filePaths, useRecycleBin = true }: { filePaths: string[]; useRecycleBin?: boolean }) => {
    console.log(`[MockApi] deleteFiles (useRecycleBin=${useRecycleBin}):`, filePaths)
    alert(`${filePaths.length} adet dosya ${useRecycleBin ? 'Geri Dönüşüm Kutusuna' : 'kalıcı olarak'} silindi!`)
    return { success: true, successCount: filePaths.length, failCount: 0, errors: [] }
  }
}

// Select either the real Electron window.api or the fallback MockApi
export const isElectron = typeof window !== 'undefined' && Boolean(window.api)

export const api: IApi = (typeof window !== 'undefined' && window.api) ? window.api : mockApi

// Ensure window.api is ALWAYS populated so external scripts or components never crash
if (typeof window !== 'undefined' && !window.api) {
  ;(window as any).api = mockApi
}

export default api
