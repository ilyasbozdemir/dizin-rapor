/**
 * Arşiv 360 - Yüksek Performanslı & Lazy-Loaded Kopya Dosya Yönetim Motoru
 */

// Global State
const duplicateData = window.DUPLICATE_DATA || [];
const summaryData = window.SUMMARY_DATA || {};

let currentFilter = 'all';
let searchQuery = '';
let currentPlatform = 'powershell';
let currentViewMode = 'tree';

// Selected duplicate file paths for script generation
const selectedPaths = new Set();

// Lazy Loading & Virtualization State
const PAGE_SIZE = 40;
let currentRenderedCount = 0;
let filteredList = [];
let scrollObserver = null;
let searchDebounceTimer = null;

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  applyFilters();
});

function initEventListeners() {
  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      applyFilters();
    });
  });

  // Search input with debounce
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        searchQuery = e.target.value.trim();
        applyFilters();
      }, 150);
    });
  }

  // Load More Button
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      renderNextBatch();
    });
  }
}

function toggleViewMode() {
  currentViewMode = currentViewMode === 'tree' ? 'list' : 'tree';
  const btn = document.getElementById('btnViewToggle');
  if (btn) {
    btn.innerHTML = currentViewMode === 'tree' ? '🌳 Ağaç Görünümü (Aktif)' : '📋 Düz Liste (Aktif)';
  }
  // Re-render currently displayed items with new mode
  const currentCount = currentRenderedCount;
  currentRenderedCount = 0;
  const container = document.getElementById('groupsList');
  container.innerHTML = '';
  renderNextBatch(Math.max(currentCount, PAGE_SIZE));
}

function applyFilters() {
  const q = searchQuery.toLowerCase();

  filteredList = duplicateData.filter(g => {
    if (currentFilter === 'cross' && !g.is_cross_drive) return false;
    if (currentFilter === 'large' && g.size_bytes < 10 * 1024 * 1024) return false;
    if (currentFilter !== 'all' && currentFilter !== 'cross' && currentFilter !== 'large') {
      const isSingle = !g.is_cross_drive && g.drives.length === 1;
      const drvKey = isSingle ? g.drives[0].replace(':', '').toLowerCase() : '';
      if (drvKey !== currentFilter) return false;
    }

    if (q) {
      const matchHash = g.hash.toLowerCase().includes(q);
      const matchFile = g.files.some(f => f.path.toLowerCase().includes(q) || f.filename.toLowerCase().includes(q));
      if (!matchHash && !matchFile) return false;
    }
    return true;
  });

  const countBadge = document.getElementById('filterMatchCount');
  if (countBadge) {
    countBadge.innerText = `${filteredList.length} grup eşleşti`;
  }

  currentRenderedCount = 0;
  const container = document.getElementById('groupsList');
  container.innerHTML = '';

  if (filteredList.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding:3rem; color:var(--text-muted); background:var(--card-bg); border-radius:16px;">Arama kriterlerine uygun kopya dosya bulunamadı.</div>';
    updateLoadMoreUI();
    return;
  }

  renderNextBatch();
  setupObserver();
}

function renderNextBatch(batchSize = PAGE_SIZE) {
  if (currentRenderedCount >= filteredList.length) {
    updateLoadMoreUI();
    return;
  }

  const container = document.getElementById('groupsList');
  const sliceEnd = Math.min(currentRenderedCount + batchSize, filteredList.length);
  const nextChunk = filteredList.slice(currentRenderedCount, sliceEnd);
  const fragment = document.createDocumentFragment();

  nextChunk.forEach((group, chunkIdx) => {
    const globalIdx = currentRenderedCount + chunkIdx;
    const card = buildGroupCard(group, globalIdx);
    fragment.appendChild(card);
  });

  container.appendChild(fragment);
  currentRenderedCount = sliceEnd;
  updateLoadMoreUI();
  updateScriptStats();
}

function setupObserver() {
  if (scrollObserver) {
    scrollObserver.disconnect();
  }
  const sentinel = document.getElementById('sentinel');
  if (!sentinel) return;

  scrollObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && currentRenderedCount < filteredList.length) {
      renderNextBatch();
    }
  }, { rootMargin: '400px' });

  scrollObserver.observe(sentinel);
}

function updateLoadMoreUI() {
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const sentinel = document.getElementById('sentinel');
  const countDisplay = document.getElementById('renderedCountText');
  const hasMore = currentRenderedCount < filteredList.length;

  if (loadMoreBtn) {
    loadMoreBtn.style.display = hasMore ? 'inline-block' : 'none';
    if (hasMore) {
      const remaining = filteredList.length - currentRenderedCount;
      loadMoreBtn.innerText = `Daha Fazla Göster (${remaining} grup kaldı)`;
    }
  }

  if (sentinel) {
    sentinel.style.display = hasMore ? 'block' : 'none';
  }

  if (countDisplay) {
    countDisplay.innerText = `${currentRenderedCount} / ${filteredList.length} gösteriliyor`;
  }
}

function buildGroupCard(group, idx) {
  const card = document.createElement('div');
  card.className = 'group-card';
  card.id = 'group-' + group.group_id;

  const crossBadge = group.is_cross_drive 
    ? '<span class="badge badge-cross">Çapraz Disk (D ↔ E)</span>'
    : '<span class="badge badge-single">Disk: ' + group.drives.join(', ') + '</span>';

  const selCountInGroup = group.files.filter(f => selectedPaths.has(f.path)).length;
  const allSelected = selCountInGroup === group.files.length;
  const treeData = organizeFilesIntoTree(group.files);

  let itemsHtml = '';

  if (currentViewMode === 'tree') {
    // TREE VIEW
    let rootHtml = '';
    if (treeData.commonRoot) {
      rootHtml = `
        <div class="tree-root-banner">
          <span>📁</span>
          <strong style="color:#94a3b8; font-size:0.75rem; text-transform:uppercase;">Ortak Kök Dizin:</strong>
          <span>${escapeHtml(treeData.commonRoot)}\\</span>
        </div>
      `;
    }

    const branchesHtml = treeData.branches.map(b => {
      const filesHtml = b.files.map((f, fIdx) => {
        const driveClass = f.drive === 'D:' ? 'drive-d' : f.drive === 'C:' ? 'drive-c' : 'drive-e';
        const isSelected = selectedPaths.has(f.path);
        const rowClass = isSelected ? 'file-row is-selected' : 'file-row';
        const statusHtml = isSelected
          ? '<span class="status-badge status-del">Silinecek</span>'
          : '<span class="status-badge status-keep">Saklanacak</span>';

        return `
          <div class="${rowClass}" id="row-${idx}-${fIdx}">
            <label class="file-chk-label">
              <span style="color:#64748b; font-family:monospace;">└──</span>
              <input type="checkbox" class="file-chk" data-path="${escapeHtml(f.path)}" ${isSelected ? 'checked' : ''} 
                onchange="toggleFileSelection(this.dataset.path, this.checked)">
              ${statusHtml}
            </label>
            <div class="file-path">
              📄 <strong>${escapeHtml(f.filename)}</strong>
            </div>
            <div class="file-time">${f.modified}</div>
            <button class="btn-copy" data-path="${escapeHtml(f.path)}" onclick="copyFilePath(this.dataset.path)">Yolu Kopyala</button>
          </div>
        `;
      }).join('');

      return `
        <div style="margin-bottom:0.75rem;">
          <div class="tree-branch-header">
            <span style="color:#818cf8;">├──</span>
            <span>📂</span>
            <span class="branch-tag">${escapeHtml(b.subfolder)}</span>
          </div>
          <div class="tree-files-wrap">
            ${filesHtml}
          </div>
        </div>
      `;
    }).join('');

    itemsHtml = `
      ${rootHtml}
      <div style="padding:0.75rem 1rem;">
        ${branchesHtml}
      </div>
    `;
  } else {
    // FLAT LIST VIEW
    const fileRows = group.files.map((f, fIdx) => {
      const driveClass = f.drive === 'D:' ? 'drive-d' : f.drive === 'C:' ? 'drive-c' : 'drive-e';
      const isSelected = selectedPaths.has(f.path);
      const rowClass = isSelected ? 'file-row is-selected' : 'file-row';
      const statusHtml = isSelected
        ? '<span class="status-badge status-del">Silinecek</span>'
        : '<span class="status-badge status-keep">Saklanacak</span>';

      return `
        <div class="${rowClass}" id="row-${idx}-${fIdx}">
          <label class="file-chk-label">
            <input type="checkbox" class="file-chk" data-path="${escapeHtml(f.path)}" ${isSelected ? 'checked' : ''} 
              onchange="toggleFileSelection(this.dataset.path, this.checked)">
            ${statusHtml}
          </label>
          <div class="file-path">
            <span class="drive-tag ${driveClass}">${f.drive}</span>${escapeHtml(f.path)}
          </div>
          <div class="file-time">${f.modified}</div>
          <button class="btn-copy" data-path="${escapeHtml(f.path)}" onclick="copyFilePath(this.dataset.path)">Yolu Kopyala</button>
        </div>
      `;
    }).join('');

    itemsHtml = `<div class="file-items">${fileRows}</div>`;
  }

  const warningBanner = allSelected
    ? '<span style="font-size:0.75rem; color:#f87171; font-weight:700; background:rgba(239,68,68,0.15); padding:0.2rem 0.5rem; border-radius:6px; border:1px solid rgba(239,68,68,0.3);">⚠️ DİKKAT: Gruptaki tüm kopyalar seçili!</span>'
    : '';

  card.innerHTML = `
    <div class="group-header">
      <div class="group-title">
        <span>${idx + 1}. ${escapeHtml(group.files[0].filename)}</span>
        ${crossBadge}
        <span class="badge badge-wasted">-${group.wasted_formatted} israf</span>
        ${warningBanner}
      </div>
      <div class="group-meta">
        <span>Tekil: <strong>${group.size_formatted}</strong></span>
        <span>Adet: <strong>${group.count}</strong></span>
        <span class="hash-code" title="${group.hash}">SHA: ${group.hash.substring(0, 14)}...</span>
      </div>
    </div>
    ${itemsHtml}
  `;
  return card;
}

function getCommonPathPrefix(paths) {
  if (!paths || paths.length === 0) return '';
  if (paths.length === 1) {
    const p = paths[0];
    const lastSlash = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return lastSlash > 0 ? p.substring(0, lastSlash) : '';
  }

  const splitDirs = paths.map(p => {
    const lastSlash = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    const dir = lastSlash > 0 ? p.substring(0, lastSlash) : p;
    return dir.split(/[\\/]+/).filter(Boolean);
  });

  const first = splitDirs[0];
  const commonParts = [];

  for (let i = 0; i < first.length; i++) {
    const part = first[i];
    const allMatch = splitDirs.every(sd => i < sd.length && sd[i].toLowerCase() === part.toLowerCase());
    if (allMatch) {
      commonParts.push(part);
    } else {
      break;
    }
  }

  if (commonParts.length === 0) return '';
  if (commonParts[0].includes(':')) {
    return commonParts[0] + '\\' + commonParts.slice(1).join('\\');
  }
  return commonParts.join('\\');
}

function organizeFilesIntoTree(files) {
  const paths = files.map(f => f.path).filter(Boolean);
  const commonRoot = getCommonPathPrefix(paths);

  const branchMap = {};
  files.forEach(f => {
    const fullDir = f.directory || (f.path ? f.path.substring(0, Math.max(f.path.lastIndexOf('\\'), f.path.lastIndexOf('/'))) : '');
    let relative = '';
    if (commonRoot && fullDir.toLowerCase().startsWith(commonRoot.toLowerCase())) {
      relative = fullDir.substring(commonRoot.length).replace(/^[\\/]+/, '');
    } else {
      relative = fullDir;
    }
    const branchKey = relative || '(Doğrudan Klasör)';
    if (!branchMap[branchKey]) {
      branchMap[branchKey] = [];
    }
    branchMap[branchKey].push(f);
  });

  const branches = Object.keys(branchMap).map(subfolder => ({
    subfolder,
    files: branchMap[subfolder]
  }));

  return { commonRoot, branches };
}

function copyFilePath(path) {
  if (!path) return;
  navigator.clipboard.writeText(path);
  showToast('Dosya yolu kopyalandı!');
}

function toggleFileSelection(path, isChecked) {
  if (!path) return;
  if (isChecked) {
    selectedPaths.add(path);
  } else {
    selectedPaths.delete(path);
  }
  // Fast DOM update for visible cards using dataset.path (no fragile inline JS selector quoting)
  document.querySelectorAll('.file-chk').forEach(chk => {
    if (chk.dataset.path === path) {
      chk.checked = isChecked;
      const row = chk.closest('.file-row');
      if (row) {
        row.classList.toggle('is-selected', isChecked);
        const badge = row.querySelector('.status-badge');
        if (badge) {
          badge.className = isChecked ? 'status-badge status-del' : 'status-badge status-keep';
          badge.innerText = isChecked ? 'Silinecek' : 'Saklanacak';
        }
      }
    }
  });
  updateScriptStats();
}

function autoSelectKeepFirst() {
  selectedPaths.clear();
  duplicateData.forEach(g => {
    for (let i = 1; i < g.files.length; i++) {
      selectedPaths.add(g.files[i].path);
    }
  });
  refreshVisibleSelections();
  showToast('Her gruptan 1 orijinal saklandı, kalan ' + selectedPaths.size + ' kopya seçildi!');
}

function autoSelectKeepNewest() {
  selectedPaths.clear();
  duplicateData.forEach(g => {
    const sorted = [...g.files].sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
    for (let i = 1; i < sorted.length; i++) {
      selectedPaths.add(sorted[i].path);
    }
  });
  refreshVisibleSelections();
  showToast('En yeni kopyalar saklandı, eski kopyalar seçildi!');
}

function autoSelectKeepOldest() {
  selectedPaths.clear();
  duplicateData.forEach(g => {
    const sorted = [...g.files].sort((a, b) => (a.modified || '').localeCompare(b.modified || ''));
    for (let i = 1; i < sorted.length; i++) {
      selectedPaths.add(sorted[i].path);
    }
  });
  refreshVisibleSelections();
  showToast('En eski kopyalar saklandı, yeni kopyalar seçildi!');
}

function clearAllSelections() {
  selectedPaths.clear();
  refreshVisibleSelections();
  showToast('Tüm seçimler temizlendi.');
}

function refreshVisibleSelections() {
  document.querySelectorAll('.file-row').forEach(row => {
    const chk = row.querySelector('.file-chk');
    if (chk && chk.dataset.path) {
      const p = chk.dataset.path;
      const isSelected = selectedPaths.has(p);
      chk.checked = isSelected;
      row.classList.toggle('is-selected', isSelected);
      const badge = row.querySelector('.status-badge');
      if (badge) {
        badge.className = isSelected ? 'status-badge status-del' : 'status-badge status-keep';
        badge.innerText = isSelected ? 'Silinecek' : 'Saklanacak';
      }
    }
  });
  updateScriptStats();
}

function calculateSelectedSize() {
  let total = 0;
  duplicateData.forEach(g => {
    g.files.forEach(f => {
      if (selectedPaths.has(f.path)) {
        total += g.size_bytes;
      }
    });
  });
  return total;
}

function updateScriptStats() {
  const count = selectedPaths.size;
  const sizeBytes = calculateSelectedSize();

  const selCountEl = document.getElementById('selCount');
  const selSizeEl = document.getElementById('selSize');
  if (selCountEl) selCountEl.innerText = count + ' dosya';
  if (selSizeEl) selSizeEl.innerText = formatBytes(sizeBytes);
}

function setPlatform(plat) {
  currentPlatform = plat;
  document.querySelectorAll('.plat-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.plat === plat);
  });
  if (document.getElementById('previewModal').classList.contains('open')) {
    openPreviewModal();
  }
}

/**
 * Dile Özgü Güvenli Yol Kodlama (Path Escaping) ve Karantina Hedef Hesaplayıcıları
 */
function escapePsLiteral(str) {
  // PowerShell tek tırnaklı değişmez dizge ('...'): yalnızca tek tırnak '' olarak kaçırılır;
  // $, `, ", $(), & gibi karakterler kesinlikle yorumlanmaz/çalıştırılmaz.
  return "'" + String(str || '').replace(/\r|\n/g, '').replace(/'/g, "''") + "'";
}

function escapeCmdLiteral(str) {
  // Windows CMD çift tırnak içi: % değişken genişlemesini %% ile kapatır, satır sonu ve " karakterini temizler.
  return String(str || '').replace(/\r|\n/g, '').replace(/"/g, '').replace(/%/g, '%%');
}

function escapeBashLiteral(str) {
  // POSIX / Bash tek tırnaklı dizge ('...'): içindeki ' karakteri '\'' ile kapatılır;
  // $, `, ", \, !, * tamamen etkisizdir.
  const posix = String(str || '').replace(/\r|\n/g, '').replace(/\\/g, '/');
  return "'" + posix.replace(/'/g, "'\\''") + "'";
}

function buildQuarantineTargetWin(fullPath, usedTargets) {
  const clean = String(fullPath || '').replace(/\//g, '\\');
  const hasDrive = /^[A-Za-z]:\\/.test(clean);
  const driveRoot = hasDrive ? clean.substring(0, 3) : 'C:\\';
  const relPath = hasDrive ? clean.substring(3) : clean.replace(/^\\+/, '');
  const lastSep = relPath.lastIndexOf('\\');
  const relDir = lastSep >= 0 ? relPath.substring(0, lastSep) : '';
  const fileName = lastSep >= 0 ? relPath.substring(lastSep + 1) : relPath;
  const baseDir = relDir ? `${driveRoot}_SILINECEK_KOPYALAR\\${relDir}` : `${driveRoot}_SILINECEK_KOPYALAR`;

  let candidate = `${baseDir}\\${fileName}`;
  let idx = 1;
  while (usedTargets.has(candidate.toLowerCase())) {
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.substring(0, dot) : fileName;
    const ext = dot > 0 ? fileName.substring(dot) : '';
    candidate = `${baseDir}\\${stem}_kopya_${idx}${ext}`;
    idx++;
  }
  usedTargets.add(candidate.toLowerCase());
  return { destDir: baseDir, destFile: candidate };
}

function buildQuarantineTargetPosix(fullPath, usedTargets) {
  const posix = String(fullPath || '').replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  const relPath = posix.replace(/^\/+/, '');
  const lastSep = relPath.lastIndexOf('/');
  const relDir = lastSep >= 0 ? relPath.substring(0, lastSep) : '';
  const fileName = lastSep >= 0 ? relPath.substring(lastSep + 1) : relPath;
  const baseDir = relDir ? `./_SILINECEK_KOPYALAR/${relDir}` : `./_SILINECEK_KOPYALAR`;

  let candidate = `${baseDir}/${fileName}`;
  let idx = 1;
  while (usedTargets.has(candidate)) {
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.substring(0, dot) : fileName;
    const ext = dot > 0 ? fileName.substring(dot) : '';
    candidate = `${baseDir}/${stem}_kopya_${idx}${ext}`;
    idx++;
  }
  usedTargets.add(candidate);
  return { destDir: baseDir, destFile: candidate };
}

function generateScriptText() {
  const paths = Array.from(selectedPaths);
  const isSafe = document.getElementById('safeModeChbox').checked;
  const totalSize = formatBytes(calculateSelectedSize());
  const now = new Date().toLocaleString('tr-TR');

  if (paths.length === 0) {
    return '# Henüz silinecek dosya seçilmedi.\n# Yukarıdaki listeden dosyaları seçin veya "İlkini Tut, Kalanları Seç" butonuna tıklayın.';
  }

  // Güvenlik Kontrolü: Seçilen her dosya için beklenen SHA-256 ve korunacak (keeper) dosya bilgisini derle
  const fileSafetyMap = new Map();
  const unsafeAllSelectedGroups = [];
  duplicateData.forEach(g => {
    const keepers = g.files.filter(f => !selectedPaths.has(f.path));
    if (keepers.length === 0 && g.files.length > 0) {
      unsafeAllSelectedGroups.push(g.group_id);
    }
    const keeperPath = keepers.length > 0 ? keepers[0].path : '';
    g.files.forEach(f => {
      if (selectedPaths.has(f.path)) {
        fileSafetyMap.set(f.path, {
          hash: (g.hash || '').toUpperCase(),
          size: g.size_bytes,
          keeper: keeperPath
        });
      }
    });
  });

  if (unsafeAllSelectedGroups.length > 0) {
    return `# ⚠️ GÜVENLİK UYARISI: ${unsafeAllSelectedGroups.length} gruptaki TÜM kopyalar seçilmiş durumda!\n` +
           `# Veri kaybını önlemek için her grupta en az 1 kopya "Saklanacak" olarak bırakılmalıdır.\n` +
           `# Lütfen tümü seçili olan gruplarda en az bir dosyanın işaretini kaldırın.`;
  }

  if (currentPlatform === 'powershell') {
    const entriesPs = paths.map(p => {
      const meta = fileSafetyMap.get(p) || { hash: '', size: 0, keeper: '' };
      return `    @{ Path = ${escapePsLiteral(p)}; Hash = ${escapePsLiteral(meta.hash)}; Size = ${Number(meta.size) || 0}; Keeper = ${escapePsLiteral(meta.keeper)} }`;
    }).join(',\n');

    if (isSafe) {
      return `# ========================================================\n` +
             `# Arşiv 360 - Güvenli Kopya Taşıma Betiği (PowerShell)\n` +
             `# Tarih: ${now}\n` +
             `# Taşınacak Dosya: ${paths.length} adet (Teorik: ${totalSize})\n` +
             `# ========================================================\n` +
             `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n` +
             `$ErrorActionPreference = "Continue"\n\n` +
             `$targetRoot = '_SILINECEK_KOPYALAR'\n` +
             `Write-Host "Kopya dosyalar SHA-256 ve çakışma kontrolüyle güvenli karantinaya taşınıyor..." -ForegroundColor Cyan\n\n` +
             `$items = @(\n${entriesPs}\n)\n\n` +
             `$success = 0; $fail = 0\n` +
             `foreach ($item in $items) {\n` +
             `    $f = $item.Path\n` +
             `    $k = $item.Keeper\n` +
             `    if (-not $k -or -not (Test-Path -LiteralPath $k)) {\n` +
             `        Write-Host "  [X Atlandı] Korunacak kopya bulunamadı: $k" -ForegroundColor Red; $fail++; continue\n` +
             `    }\n` +
             `    if ($f -eq $k) {\n` +
             `        Write-Host "  [X Atlandı] Hedef ile korunacak dosya aynı: $f" -ForegroundColor Red; $fail++; continue\n` +
             `    }\n` +
             `    if (Test-Path -LiteralPath $f) {\n` +
             `        try {\n` +
             `            $curHash = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToUpper()\n` +
             `            $keepHash = (Get-FileHash -LiteralPath $k -Algorithm SHA256).Hash.ToUpper()\n` +
             `            if ($item.Hash -and (($curHash -ne $item.Hash) -or ($keepHash -ne $item.Hash))) {\n` +
             `                Write-Host "  [X Atlandı] Dosya veya korunacak kopya değişmiş (SHA-256 uyuşmuyor): $f" -ForegroundColor Yellow; $fail++; continue\n` +
             `            }\n` +
             `            $fileObj = Get-Item -LiteralPath $f -Force\n` +
             `            $driveRoot = $fileObj.PSDrive.Name + ":\\\\"\n` +
             `            $relDir = $fileObj.DirectoryName.Substring($driveRoot.Length)\n` +
             `            $destFolder = Join-Path (Join-Path $driveRoot $targetRoot) $relDir\n` +
             `            if (-not (Test-Path -LiteralPath $destFolder)) { New-Item -ItemType Directory -Path $destFolder -Force | Out-Null }\n` +
             `            $destFile = Join-Path $destFolder $fileObj.Name\n` +
             `            if (Test-Path -LiteralPath $destFile) {\n` +
             `                $base = [System.IO.Path]::GetFileNameWithoutExtension($fileObj.Name)\n` +
             `                $ext  = [System.IO.Path]::GetExtension($fileObj.Name)\n` +
             `                $idx  = 1\n` +
             `                while (Test-Path -LiteralPath $destFile) {\n` +
             `                    $destFile = Join-Path $destFolder ("{0}_kopya_{1}{2}" -f $base, $idx, $ext)\n` +
             `                    $idx++\n` +
             `                }\n` +
             `            }\n` +
             `            Move-Item -LiteralPath $f -Destination $destFile -ErrorAction Stop\n` +
             `            Write-Host "  [✓ Taşındı] $f -> $destFile" -ForegroundColor Green\n` +
             `            $success++\n` +
             `        } catch {\n` +
             `            Write-Host "  [X Hata] $f ($($_.Exception.Message))" -ForegroundColor Red\n` +
             `            $fail++\n` +
             `        }\n` +
             `    } else {\n` +
             `        Write-Host "  [-] Bulunamadı: $f" -ForegroundColor Yellow\n` +
             `    }\n` +
             `}\n\n` +
             `Write-Host "\\nİşlem Tamamlandı! Başarılı: $success | Hata/Atlanan: $fail" -ForegroundColor Cyan\n` +
             `Write-Host "Dosyalarınız çakışmasız klasör yapısıyla '_SILINECEK_KOPYALAR' altına taşındı." -ForegroundColor Yellow\n` +
             `pause\n`;
    } else {
      return `# ========================================================\n` +
             `# Arşiv 360 - Kalıcı Kopya Silme Betiği (PowerShell)\n` +
             `# Tarih: ${now}\n` +
             `# Silinecek Dosya: ${paths.length} adet (Teorik: ${totalSize})\n` +
             `# ========================================================\n` +
             `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n` +
             `$ErrorActionPreference = "Continue"\n\n` +
             `$confirm = Read-Host "${paths.length} adet kopya dosya KALICI OLARAK silinecektir. Devam etmek için 'EVET' yazın"\n` +
             `if ($confirm -ne 'EVET') { Write-Host 'İşlem iptal edildi.' -ForegroundColor Yellow; exit }\n\n` +
             `$items = @(\n${entriesPs}\n)\n\n` +
             `$deleted = 0\n` +
             `foreach ($item in $items) {\n` +
             `    $f = $item.Path\n` +
             `    $k = $item.Keeper\n` +
             `    if (-not $k -or -not (Test-Path -LiteralPath $k)) {\n` +
             `        Write-Host "  [X Atlandı] Korunacak kopya bulunamadı: $k" -ForegroundColor Red; continue\n` +
             `    }\n` +
             `    if ($f -eq $k) {\n` +
             `        Write-Host "  [X Atlandı] Hedef ile korunacak dosya aynı: $f" -ForegroundColor Red; continue\n` +
             `    }\n` +
             `    if (Test-Path -LiteralPath $f) {\n` +
             `        try {\n` +
             `            $curHash = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToUpper()\n` +
             `            $keepHash = (Get-FileHash -LiteralPath $k -Algorithm SHA256).Hash.ToUpper()\n` +
             `            if ($item.Hash -and (($curHash -ne $item.Hash) -or ($keepHash -ne $item.Hash))) {\n` +
             `                Write-Host "  [X Atlandı] Dosya veya korunacak kopya değişmiş (SHA-256 uyuşmuyor): $f" -ForegroundColor Yellow; continue\n` +
             `            }\n` +
             `            Remove-Item -LiteralPath $f -Force -ErrorAction Stop\n` +
             `            Write-Host "  [✓ Silindi] $f" -ForegroundColor Green\n` +
             `            $deleted++\n` +
             `        } catch {\n` +
             `            Write-Host "  [X Hata] $f ($($_.Exception.Message))" -ForegroundColor Red\n` +
             `        }\n` +
             `    } else {\n` +
             `        Write-Host "  [-] Bulunamadı: $f" -ForegroundColor Yellow\n` +
             `    }\n` +
             `}\n\n` +
             `Write-Host "\\nToplam Silinen: $deleted dosya." -ForegroundColor Cyan\npause\n`;
    }
  }

  if (currentPlatform === 'cmd') {
    const usedWinTargets = new Set();
    if (isSafe) {
      const lines = [
        `@echo off`,
        `chcp 65001 > nul`,
        `title Arşiv 360 - Güvenli Kopya Taşıma`,
        `echo ========================================================`,
        `echo Arşiv 360 - Kopya Dosyaları _SILINECEK_KOPYALAR Klasörüne Taşıma`,
        `echo Taşınacak Dosya: ${paths.length} adet (Teorik: ${totalSize})`,
        `echo ========================================================`,
        `echo.`,
        `pause`
      ];
      paths.forEach(p => {
        const meta = fileSafetyMap.get(p) || { keeper: '' };
        const qt = buildQuarantineTargetWin(p, usedWinTargets);
        const srcCmd = escapeCmdLiteral(p);
        const keepCmd = escapeCmdLiteral(meta.keeper);
        const dstDirCmd = escapeCmdLiteral(qt.destDir);
        const dstFileCmd = escapeCmdLiteral(qt.destFile);
        lines.push(`if not exist "${keepCmd}" ( echo [ATLANDI - Korunacak kopya yok] "${srcCmd}" ) else (`);
        lines.push(`  if not exist "${dstDirCmd}" mkdir "${dstDirCmd}" >nul 2>&1`);
        lines.push(`  if exist "${dstFileCmd}" ( echo [ATLANDI - Hedefte dosya var] "${dstFileCmd}" ) else (`);
        lines.push(`    move /-y "${srcCmd}" "${dstFileCmd}" >nul 2>&1 && echo [OK] "${srcCmd}" || echo [HATA] "${srcCmd}"`);
        lines.push(`  )`);
        lines.push(`)`);
      });
      lines.push(`echo.`, `echo İşlem tamamlandı. Dosyalar klasör yapısı korunarak _SILINECEK_KOPYALAR altına taşındı.`, `pause`);
      return lines.join('\n');
    } else {
      const lines = [
        `@echo off`,
        `chcp 65001 > nul`,
        `title Arşiv 360 - Kalıcı Kopya Silme`,
        `echo ========================================================`,
        `echo DİKKAT: ${paths.length} adet dosya kalıcı olarak silinecek!`,
        `echo Teorik Kurtarılacak Alan: ${totalSize}`,
        `echo ========================================================`,
        `set /p onay="Onaylıyor musunuz? (EVET yazın): "`,
        `if /i not "%onay%"=="EVET" exit /b`,
        `echo.`
      ];
      paths.forEach(p => {
        const meta = fileSafetyMap.get(p) || { keeper: '' };
        const srcCmd = escapeCmdLiteral(p);
        const keepCmd = escapeCmdLiteral(meta.keeper);
        lines.push(`if not exist "${keepCmd}" ( echo [ATLANDI - Korunacak kopya yok] "${srcCmd}" ) else (`);
        lines.push(`  del /f /q "${srcCmd}" 2>nul && echo [SILINDI] "${srcCmd}" || echo [BULUNAMADI/HATA] "${srcCmd}"`);
        lines.push(`)`);
      });
      lines.push(`echo.`, `echo Tamamlandı.`, `pause`);
      return lines.join('\n');
    }
  }

  if (currentPlatform === 'bash') {
    const usedPosixTargets = new Set();
    const lines = [
      `#!/usr/bin/env bash`,
      `# ========================================================`,
      `# Arşiv 360 - Güvenli Kopya Dosya Temizleme Betiği (macOS & Linux)`,
      `# Dosya Sayısı: ${paths.length} adet (Teorik: ${totalSize})`,
      `# ========================================================`,
      `set -euo pipefail`,
      `calc_sha256() {`,
      `  if command -v sha256sum >/dev/null 2>&1; then`,
      `    sha256sum "$1" | awk '{print toupper($1)}'`,
      `  elif command -v shasum >/dev/null 2>&1; then`,
      `    shasum -a 256 "$1" | awk '{print toupper($1)}'`,
      `  else`,
      `    echo ""`,
      `  fi`,
      `}`,
      `echo "Toplam ${paths.length} dosya işlenecek..."`
    ];
    if (isSafe) {
      lines.push(`echo "Dosyalar klasör yapısı korunarak ./_SILINECEK_KOPYALAR altına taşınıyor..."`);
      paths.forEach(p => {
        const meta = fileSafetyMap.get(p) || { hash: '', keeper: '' };
        const qt = buildQuarantineTargetPosix(p, usedPosixTargets);
        const srcLit = escapeBashLiteral(p);
        const keepLit = escapeBashLiteral(meta.keeper);
        const dstDirLit = escapeBashLiteral(qt.destDir);
        const dstFileLit = escapeBashLiteral(qt.destFile);
        const expHashLit = escapeBashLiteral(meta.hash);
        lines.push(
          `src=${srcLit}; keep=${keepLit}; dst_dir=${dstDirLit}; dst=${dstFileLit}; exp_hash=${expHashLit}`,
          `if [ ! -f "$keep" ]; then`,
          `  echo "  [X Atlandı] Korunacak kopya bulunamadı: $keep"`,
          `elif [ -f "$src" ]; then`,
          `  cur_h="$(calc_sha256 "$src")"`,
          `  keep_h="$(calc_sha256 "$keep")"`,
          `  if [ -n "$exp_hash" ] && [ -n "$cur_h" ] && { [ "$cur_h" != "$exp_hash" ] || [ "$keep_h" != "$exp_hash" ]; }; then`,
          `    echo "  [X Atlandı] SHA-256 uyuşmuyor: $src"`,
          `  else`,
          `    mkdir -p "$dst_dir"`,
          `    if [ -e "$dst" ]; then dst="\${dst}_$(date +%s)_$$"; fi`,
          `    mv -n "$src" "$dst" && echo "  [✓ Taşındı] $src -> $dst"`,
          `  fi`,
          `fi`
        );
      });
    } else {
      lines.push(
        `read -r -p "Dosyaları kalıcı olarak silmek istiyor musunuz? (EVET yazın): " onay`,
        `if [[ "$onay" != "EVET" ]]; then echo "İptal edildi."; exit 0; fi`
      );
      paths.forEach(p => {
        const meta = fileSafetyMap.get(p) || { hash: '', keeper: '' };
        const srcLit = escapeBashLiteral(p);
        const keepLit = escapeBashLiteral(meta.keeper);
        const expHashLit = escapeBashLiteral(meta.hash);
        lines.push(
          `src=${srcLit}; keep=${keepLit}; exp_hash=${expHashLit}`,
          `if [ ! -f "$keep" ]; then`,
          `  echo "  [X Atlandı] Korunacak kopya bulunamadı: $keep"`,
          `elif [ -f "$src" ]; then`,
          `  cur_h="$(calc_sha256 "$src")"`,
          `  keep_h="$(calc_sha256 "$keep")"`,
          `  if [ -n "$exp_hash" ] && [ -n "$cur_h" ] && { [ "$cur_h" != "$exp_hash" ] || [ "$keep_h" != "$exp_hash" ]; }; then`,
          `    echo "  [X Atlandı] SHA-256 uyuşmuyor: $src"`,
          `  else`,
          `    rm -f -- "$src" && echo "  [✓ Silindi] $src"`,
          `  fi`,
          `fi`
        );
      });
    }
    lines.push(`echo "İşlem tamamlandı!"`);
    return lines.join('\n');
  }

  return '';
}

function copyScriptToClipboard() {
  const text = generateScriptText();
  navigator.clipboard.writeText(text).then(() => {
    showToast('✓ ' + currentPlatform.toUpperCase() + ' komutları panoya kopyalandı!');
  });
}

function downloadScript() {
  const text = generateScriptText();
  const ext = currentPlatform === 'powershell' ? 'ps1' : currentPlatform === 'cmd' ? 'bat' : 'sh';
  const filename = `arsiv360_kopya_temizle_${Date.now()}.${ext}`;
  
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('✓ ' + filename + ' dosyası indirildi!');
}

function openPreviewModal() {
  const code = generateScriptText();
  const titles = {
    powershell: 'Windows PowerShell Betiği (.ps1)',
    cmd: 'Windows CMD / Batch Betiği (.bat)',
    bash: 'macOS & Linux Bash Betiği (.sh)'
  };
  document.getElementById('modalTitle').innerText = titles[currentPlatform] || 'Betiği Önizle';
  document.getElementById('modalCode').innerText = code;
  document.getElementById('previewModal').classList.add('open');
}

function closePreviewModal() {
  document.getElementById('previewModal').classList.remove('open');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.innerText = msg;
  t.style.display = 'block';
  setTimeout(() => {
    t.style.display = 'none';
  }, 3500);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function escapeJs(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
