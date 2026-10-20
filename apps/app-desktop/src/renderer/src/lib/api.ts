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
  duplicate: {
    summary: {
      scan_date: new Date().toLocaleString('tr-TR'),
      elapsed_seconds: 9.31,
      scanned_drives: ['E:\\'],
      total_files_scanned: 6429,
      total_bytes_scanned: 8849055842,
      total_size_scanned_formatted: '8.24 GB',
      zero_byte_files_count: 512,
      duplicate_groups_count: 737,
      duplicate_files_count: 2010,
      total_wasted_bytes: 2247507764,
      total_wasted_formatted: '2.09 GB',
      cross_drive_groups_count: 0,
      cross_drive_wasted_formatted: '0 B'
    },
    duplicates: [
      {
        group_id: 233,
        hash: '882f2fc95e8bdb57a7a820b111e5f08330cba8d5923d71af2e019b69da9557b5',
        size_bytes: 173175877,
        size_formatted: '165.15 MB',
        count: 2,
        wasted_bytes: 173175877,
        wasted_formatted: '165.15 MB',
        files: [
          {
            path: 'E:\\20.10.2026-yedek\\ihale_dokumani_2022_649846.zip',
            filename: 'ihale_dokumani_2022_649846.zip'
          },
          {
            path: 'E:\\YEDEK\\ihale_dokumani_2022_649846.zip',
            filename: 'ihale_dokumani_2022_649846.zip'
          }
        ]
      }
    ]
  },
  migration: {
    summary: {
      source: 'E:\\ (USB Bellek)',
      target: 'D:\\E_BIRLESTIRME',
      total_files_scanned: 6429,
      total_bytes_scanned: 8849055842,
      total_size_scanned_formatted: '8.24 GB',
      unique_files_to_copy: 5078,
      unique_bytes_to_copy: 6601548078,
      unique_size_to_copy_formatted: '6.15 GB',
      duplicates_skipped: 1351,
      wasted_bytes_saved: 2247507764,
      wasted_saved_formatted: '2.09 GB',
      shortened_paths_count: 286,
      danger_paths_220_plus: 0
    }
  }
}

// In-memory mock state for web browser preview
let mockFilesState = [...MOCK_FILES]
const outputListeners = new Set<(data: { taskId: string; text: string; stream: 'stdout' | 'stderr' }) => void>()
const exitListeners = new Set<(data: { taskId: string; code: number }) => void>()
let mockProcessTimer: any = null

const mockApi: IApi = {
  runPythonTask: async ({ taskId, scriptName, args = [] }: { taskId: string; scriptName: string; args?: string[] }) => {
    console.log(`[MockApi] Running ${scriptName} with args:`, args)
    const logs = [
      `[MOCK ENGINE] Python ortamı simülasyonu başlatıldı.\n`,
      `[KOMUT] python ${scriptName} ${args.join(' ')}\n`,
      `[1/4] Dizin taranıyor (E:\\)... Toplam 6.429 dosya tespit edildi.\n`,
      `[2/4] SHA-256 hash kontrolleri yapılıyor... (Hızlı ön-boyut filtreleme)\n`,
      `[3/4] 737 mükerrer dosya grubu ayrıştırıldı. Tasarruf: 2.09 GB\n`,
      `[4/4] Hedef dizin kontrol edildi (D:\\E_BIRLESTIRME). Raporlar güncellendi.\n`,
      `✓ İşlem başarıyla tamamlandı (Çıkış Kodu: 0)\n`
    ]

    let step = 0
    clearInterval(mockProcessTimer)
    mockProcessTimer = setInterval(() => {
      if (step < logs.length) {
        outputListeners.forEach((fn) => fn({ taskId, text: logs[step], stream: 'stdout' }))
        step++
      } else {
        clearInterval(mockProcessTimer)
        exitListeners.forEach((fn) => fn({ taskId, code: 0 }))
      }
    }, 400)

    return { success: true, pid: 9999 }
  },

  stopPythonTask: async ({ taskId }: { taskId: string }) => {
    clearInterval(mockProcessTimer)
    outputListeners.forEach((fn) =>
      fn({ taskId, text: '\n[İşlem kullanıcı tarafından durduruldu.]\n', stream: 'stderr' })
    )
    exitListeners.forEach((fn) => fn({ taskId, code: -1 }))
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
