import { describe, it, expect } from 'vitest'
import { analyzeArchiveFiles, extractYear, ARSIV_CORE_VERSION } from '../index'

describe('Arsiv Core Analyzer', () => {
  it('should have correct version', () => {
    expect(ARSIV_CORE_VERSION).toBe('1.0.0')
  })

  it('should correctly extract years from file names', () => {
    expect(extractYear('2024_proje_ihale_dosyasi.pdf')).toBe('2024')
    expect(extractYear('imar_plani_1998_revizyon.dwg')).toBe('1998')
    expect(extractYear('logo_ve_resimler.png')).toBeNull()
  })

  it('should dynamically cluster files by topic and format', () => {
    const mockFiles = [
      {
        name: '2024_ihale_sozlesmesi.pdf',
        cleanName: '2024_ihale_sozlesmesi',
        path: 'D:\\Projeler\\2024_ihale_sozlesmesi.pdf',
        isDirectory: false,
        size: 1024000,
        mtime: Date.now(),
        ext: '.pdf',
        tags: []
      },
      {
        name: 'imar_plani_kadastro.dwg',
        cleanName: 'imar_plani_kadastro',
        path: 'D:\\Projeler\\imar_plani_kadastro.dwg',
        isDirectory: false,
        size: 5120000,
        mtime: Date.now(),
        ext: '.dwg',
        tags: []
      }
    ]

    const result = analyzeArchiveFiles(mockFiles)
    expect(result).toBeDefined()
    expect(result.formatClusters.length).toBeGreaterThan(0)
    expect(result.topKeywords.length).toBeGreaterThan(0)
  })
})
