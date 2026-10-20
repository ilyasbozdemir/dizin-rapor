/**
 * Evrensel Dosya İsmi ve Dizin Semantik Analiz Motoru
 * Herhangi bir sektöre (belediye, mühendislik, hukuk, finans, yazılım, kişisel)
 * bağımlı olmadan dosya isimlerinden dinamik kümeleme ve kategori tespiti yapar.
 */

export interface AnalyzedFile {
  name: string
  cleanName: string
  path: string
  isDirectory: boolean
  size: number
  mtime: number
  ext: string
  tags: string[]
}

export interface DynamicCluster {
  id: string
  label: string
  type: 'topic' | 'year' | 'format' | 'folder' | 'project'
  count: number
  badge?: string
  files: AnalyzedFile[]
}

export interface DynamicAnalysisResult {
  realFolders: DynamicCluster[]
  smartTopics: DynamicCluster[]
  yearClusters: DynamicCluster[]
  formatClusters: DynamicCluster[]
  topKeywords: { word: string; count: number }[]
}

const STOP_WORDS = new Set([
  // Türkçe
  've', 'ile', 'veya', 'icin', 'için', 'bir', 'bu', 'su', 'şu', 'o', 'da', 'de', 'ta', 'te',
  'ki', 'mi', 'mu', 'mü', 'nin', 'nın', 'nun', 'nün', 'den', 'dan', 'ten', 'tan',
  'kopya', 'copy', 'yeni', 'new', 'son', 'final', 'temp', 'tmp', 'untitled', 'adsiz', 'isimsiz',
  'dosya', 'klasor', 'belge', 'dokuman', 'tarih', 'ek', 'ekler', 'rapor',
  // İngilizce
  'the', 'and', 'or', 'for', 'with', 'from', 'to', 'in', 'on', 'at', 'by', 'an', 'a', 'of'
])

const FORMAT_CATEGORIES: Record<string, { label: string; exts: string[]; icon: string }> = {
  cad_gis: {
    label: 'Mühendislik, Harita & CAD',
    exts: ['.dwg', '.dxf', '.ncz', '.ncp', '.shp', '.kml', '.kmz', '.geojson', '.dgn', '.mxd'],
    icon: 'Layers'
  },
  documents: {
    label: 'Resmi Belgeler & Metinler',
    exts: ['.pdf', '.docx', '.doc', '.odt', '.txt', '.rtf', '.md', '.wpd'],
    icon: 'FileText'
  },
  spreadsheets: {
    label: 'Tablo, Veri & Hesaplama',
    exts: ['.xlsx', '.xls', '.csv', '.tsv', '.ods', '.parquet', '.db', '.sqlite', '.sql'],
    icon: 'FileSpreadsheet'
  },
  media: {
    label: 'Görsel, Fotoğraf & Çizim',
    exts: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.bmp', '.tiff', '.psd', '.ai'],
    icon: 'Image'
  },
  video_audio: {
    label: 'Ses & Video Kayıtları',
    exts: ['.mp4', '.avi', '.mov', '.mkv', '.mp3', '.wav', '.flac', '.m4a'],
    icon: 'Video'
  },
  archives: {
    label: 'Arşiv & Sıkıştırılmış Paketler',
    exts: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.iso'],
    icon: 'Archive'
  },
  code_web: {
    label: 'Yazılım & Web Dosyaları',
    exts: ['.ts', '.tsx', '.js', '.jsx', '.json', '.html', '.css', '.py', '.java', '.cpp', '.c', '.cs'],
    icon: 'Code'
  }
}

/**
 * Dosya ismini anlamlı kelime token'larına ayırır.
 */
export function tokenizeFilename(filename: string): string[] {
  // Uzantıyı ve etiket köşeli parantezlerini temizle: "Evrak [ihale].pdf" -> "Evrak"
  const withoutExt = filename.replace(/\.[^.]+$/, '').replace(/\[.*?\]/g, '')
  // Sembolleri ve ayraçları boşluğa çevir
  const normalized = withoutExt
    .replace(/[_\-.,;:!?/\\()&%+]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase ayrımı
    .toLowerCase()
    .trim()

  const rawTokens = normalized.split(/\s+/).filter(Boolean)
  const tokens: string[] = []

  for (const t of rawTokens) {
    // 2 karakterden kısa veya salt rakam (yıl hariç) olanları ele
    if (t.length < 3) continue
    if (/^\d+$/.test(t) && !(t.length === 4 && (t.startsWith('19') || t.startsWith('20')))) {
      continue
    }
    if (!STOP_WORDS.has(t)) {
      tokens.push(t)
    }
  }

  return tokens
}

/**
 * Dosya isimlerinden dinamik olarak yıl desenini (örn: 2018..2030) çıkarır.
 */
export function extractYear(filename: string): string | null {
  const match = filename.match(/\b(19\d\d|20\d\d)\b/)
  return match ? match[1] : null
}

/**
 * Dosya isimlerinden proje/dosya numarası desenlerini (örn: 2022-649846, 406_25) çıkarır.
 */
export function extractProjectCode(filename: string): string | null {
  const match = filename.match(/\b(\d{4}[-_/]\d{3,8})\b/) || filename.match(/\b(\d{2,5}[-_/]\d{2,5})\b/)
  return match ? match[1].replace(/[/]/g, '-') : null
}

/**
 * Herhangi bir dosya listesi üzerinde çok boyutlu semantik analiz yapar.
 */
export function analyzeArchiveFiles(files: AnalyzedFile[], baseDir: string = ''): DynamicAnalysisResult {
  const wordFrequency: Record<string, AnalyzedFile[]> = {}
  const yearGroups: Record<string, AnalyzedFile[]> = {}
  const formatGroups: Record<string, AnalyzedFile[]> = {}
  const folderGroups: Record<string, AnalyzedFile[]> = {}

  // 1. Dosyaları tara ve dağıt
  for (const file of files) {
    // Gerçek klasör hiyerarşisi
    let relFolder = 'Kök Dizin'
    if (file.path && baseDir && file.path.startsWith(baseDir)) {
      const rest = file.path.slice(baseDir.length).replace(/^[\\/]/, '')
      const parts = rest.split(/[\\/]/)
      if (parts.length > 1) {
        relFolder = parts[0]
      }
    } else if (file.path) {
      const parts = file.path.split(/[\\/]/)
      if (parts.length > 2) {
        relFolder = parts[parts.length - 2]
      }
    }
    if (!folderGroups[relFolder]) folderGroups[relFolder] = []
    folderGroups[relFolder].push(file)

    if (file.isDirectory) continue

    // Format Analizi
    const ext = (file.ext || '').toLowerCase()
    let matchedFormatKey = 'diger'
    for (const [key, conf] of Object.entries(FORMAT_CATEGORIES)) {
      if (conf.exts.includes(ext)) {
        matchedFormatKey = key
        break
      }
    }
    if (!formatGroups[matchedFormatKey]) formatGroups[matchedFormatKey] = []
    formatGroups[matchedFormatKey].push(file)

    // Yıl Analizi
    const yr = extractYear(file.name)
    if (yr) {
      if (!yearGroups[yr]) yearGroups[yr] = []
      yearGroups[yr].push(file)
    }

    // İsim Token Analizi
    const tokens = tokenizeFilename(file.name)
    const uniqueTokens = Array.from(new Set(tokens))
    for (const t of uniqueTokens) {
      if (!wordFrequency[t]) wordFrequency[t] = []
      wordFrequency[t].push(file)
    }
  }

  // 2. Anlamlı Akıllı Konu Kümelerini Oluştur (En az 2 dosyada geçen kelimeler)
  const smartTopics: DynamicCluster[] = Object.entries(wordFrequency)
    .filter(([_, flist]) => flist.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20) // En belirgin ilk 20 konu kümesi
    .map(([word, flist]) => ({
      id: `topic-${word}`,
      label: word.charAt(0).toLocaleUpperCase('tr-TR') + word.slice(1),
      type: 'topic' as const,
      count: flist.length,
      files: flist
    }))

  // 3. Yıl Kümelerini Oluştur (Yıla göre sıralı)
  const yearClusters: DynamicCluster[] = Object.entries(yearGroups)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([yr, flist]) => ({
      id: `year-${yr}`,
      label: `${yr} Yılı Belgeleri`,
      type: 'year' as const,
      count: flist.length,
      badge: yr,
      files: flist
    }))

  // 4. Format Kümelerini Oluştur
  const formatClusters: DynamicCluster[] = Object.entries(FORMAT_CATEGORIES)
    .map(([key, conf]) => {
      const flist = formatGroups[key] || []
      return {
        id: `format-${key}`,
        label: conf.label,
        type: 'format' as const,
        count: flist.length,
        files: flist
      }
    })
    .filter((c) => c.count > 0)

  // 5. Gerçek Klasör Kümeleri
  const realFolders: DynamicCluster[] = Object.entries(folderGroups)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([fname, flist]) => ({
      id: `folder-${fname}`,
      label: fname,
      type: 'folder' as const,
      count: flist.length,
      files: flist
    }))

  const topKeywords = Object.entries(wordFrequency)
    .map(([word, flist]) => ({ word, count: flist.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30)

  return {
    realFolders,
    smartTopics,
    yearClusters,
    formatClusters,
    topKeywords
  }
}
