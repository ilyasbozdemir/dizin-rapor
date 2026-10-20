# Arşiv 360 — Akıllı Dosya & Arşiv Gezgini 🗂️⚡

Modern, çevrimdışı (offline-first), yüksek performanslı akıllı dosya analiz, arşiv gezgini ve birleştirme platformu.

![Arşiv 360](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6?style=for-the-badge&logo=windows)
![Electron](https://img.shields.io/badge/Electron-32-47848F?style=for-the-badge&logo=electron)
![React](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=for-the-badge&logo=typescript)
![TailwindCSS](https://img.shields.io/badge/Tailwind-3.4-38B2AC?style=for-the-badge&logo=tailwind-css)
![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=for-the-badge&logo=python)

---

## 🌟 Öne Çıkan Özellikler

- **📁 Tamamen Dinamik Dizin & Sürücü Yönetimi:** Sabit yollara bağlı kalmadan sisteminizdeki tüm sürücüleri (`C:`, `D:`, `E:`) otomatik algılar; bilgisayarınızdaki herhangi bir klasörü seçip anında taramanıza olanak tanır.
- **🧭 Tıklanabilir Breadcrumb Dizin Ağacı:** Klasör hiyerarşisi arasında tek tıkla gezinin, üst dizinlere zıplayın veya yolu manuel düzenleyin.
- **🔍 İç Dizinler & Derinlik Kontrollü Tarama:** Seçilen klasörün alt dizinlerini içerik sayılarıyla görüntüler; 1 Seviye (Hızlı), 2 Seviye (Dengeli) veya 3 Seviye (Derin) tarama seçenekleri sunar.
- **🧠 Evrensel Semantik NLP Analizi:** Dosya isimlerini otomatik ayrıştırarak akıllı konu kümeleri, yıllara göre kronoloji, format grupları ve anahtar kelimeleri anında çıkarır.
- **⚡ Entegre Python Motoru:**
  - `scanner.py`: SHA-256 hash algoritmasıyla birebir aynı mükerrer kopyaları tespit eder, kurtarılabilecek disk alanını hesaplar.
  - `birlestir.py`: Windows 260 karakter (`MAX_PATH`) sınırını aşan yolları akıllıca güvenli boyuta çekerek simülasyon (`--onizleme`) veya gerçek birleştirme (`--uygula`) yapar.
  - Canlı terminal akışı (`-u` unbuffered stdout/stderr) ile anlık çıktı takibi.
- **🎨 Premium Dark & Light Tema:** Göz yormayan koyu ve aydınlık modlar, modern cam efektleri (glassmorphism) ve mikro animasyonlar.
- **🏷️ Akıllı Etiketleme & Filtreleme:** Dosyalara özel etiket ekleme, kaldırma ve çoklu perspektiften anında filtreleme.
- **🔒 %100 Çevrimdışı & Gizlilik Odaklı:** Hiçbir veri dışarıya veya buluta aktarılmaz; tüm analiz ve işlemler yerel makinenizde gerçekleşir.

---

## 🏗️ Proje Mimarisi (Monorepo)

```text
dizin-rapor/
├── apps/
│   └── app-desktop/          # Electron + React + Tailwind masaüstü uygulaması
│       ├── src/
│       │   ├── main/         # Electron ana süreç, IPC köprüsü, Python işlem yöneticisi
│       │   ├── preload/      # Güvenli contextBridge API tanımları
│       │   └── renderer/     # Modern React arayüzü, Breadcrumb gezgini, Python terminali
│       └── electron.vite.config.ts
├── packages/
│   └── arsiv-core/           # Evrensel NLP, dosya kümeleme ve tokenizer kütüphanesi
├── scanner.py                # Hızlı SHA-256 mükerrer dosya tarama motoru
├── birlestir.py              # MAX_PATH korumalı akıllı birleştirme motoru
├── migrate_e_to_d.py         # Yol optimizasyon ve geçiş planlayıcı
├── package.json              # Monorepo kök yapılandırması
├── pnpm-workspace.yaml       # pnpm monorepo tanımları
└── tsconfig.base.json
```

---

## 🚀 Kurulum ve Çalıştırma

### Gereksinimler
- **Node.js**: v18+ veya v20+
- **pnpm**: v9+ (`npm install -g pnpm`)
- **Python**: 3.10+ (CLI tarama ve birleştirme motoru için)

### 1. Bağımlılıkları Yükleyin
```bash
pnpm install
```

### 2. Geliştirici Modunda Başlatın
```bash
pnpm dev
```
> **İpucu:** Geliştirici araçları (DevTools) için uygulama açıkken `F12` veya `Ctrl+Shift+I` tuşlarına basabilirsiniz.

### 3. TypeScript ve Tip Kontrolü
```bash
pnpm typecheck
```

### 4. Üretim (Production) Derlemesi
```bash
pnpm build
```

---

## 🛠️ Python Motoru CLI Kullanımı

İsterseniz Python motorunu masaüstü arayüzüne gerek duymadan doğrudan terminalden de çalıştırabilirsiniz:

```bash
# 1. Herhangi bir klasörü tarayıp mükerrer raporu oluşturma:
python scanner.py "D:\Arsivim"

# 2. İki klasör arasında güvenli simülasyon (önizleme) yapma:
python birlestir.py faz1 --kaynak "E:\HamDosyalar" --hedef "D:\DuzenliArsiv" --duzen konu-tip --onizleme

# 3. Akıllı birleştirmeyi uygulama:
python birlestir.py faz1 --kaynak "E:\HamDosyalar" --hedef "D:\DuzenliArsiv" --duzen konu-tip --uygula --hash-cache duplicate_report.json
```

---

## 📄 Lisans

MIT License © 2026 Arşiv 360
