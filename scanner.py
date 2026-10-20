import os
import sys
import hashlib
import time
import json
from collections import defaultdict
from pathlib import Path

# Windows konsolunda Unicode karakterlerin (✓ vb.) çökmesini engelle
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try: _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception: pass

TARGET_DRIVES = ["E:\\"]

EXCLUDE_DIRS = {
    "$recycle.bin",
    "system volume information",
    "found.000",
    "found.001",
    "found.002",
    ".trashes",
    ".gemini"
}

EXCLUDE_FILES = {
    "pagefile.sys",
    "hiberfil.sys",
    "swapfile.sys",
    "dumpstack.log",
    "dumpstack.log.tmp",
    "boottel.dat"
}

def format_size(size_bytes):
    if size_bytes == 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB", "TB"]
    i = 0
    size = float(size_bytes)
    while size >= 1024.0 and i < len(units) - 1:
        size /= 1024.0
        i += 1
    return f"{size:.2f} {units[i]}"

def get_quick_sample_hash(filepath, file_size):
    """
    Reads 64KB from start and 64KB from end of file for instant filtering.
    """
    try:
        with open(filepath, "rb") as f:
            h = hashlib.sha256()
            # head
            head = f.read(65536)
            h.update(head)
            # tail if larger
            if file_size > 131072:
                f.seek(file_size - 65536)
                tail = f.read(65536)
                h.update(tail)
            return h.hexdigest()
    except (PermissionError, OSError):
        return None

def get_full_hash(filepath, block_size=4*1024*1024):
    """Calculates full SHA256 in 4MB blocks."""
    h = hashlib.sha256()
    try:
        with open(filepath, "rb") as f:
            while True:
                buf = f.read(block_size)
                if not buf:
                    break
                h.update(buf)
        return h.hexdigest()
    except (PermissionError, OSError):
        return None

def main():
    start_time = time.time()
    
    target_drives = TARGET_DRIVES
    # Check for CLI arguments: python scanner.py <path1> <path2> ...
    cli_paths = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    if cli_paths:
        target_drives = cli_paths

    print(f"[1/4] Hedef dizinler taranıyor: {', '.join(target_drives)}...", flush=True)

    size_to_files = defaultdict(list)
    total_files = 0
    total_bytes = 0
    zero_files = []

    for drive in target_drives:
        if not os.path.exists(drive):
            print(f"Uyarı: {drive} erişilemedi!", flush=True)
            continue
        print(f"  -> {drive} taranıyor...", flush=True)
        t_d = time.time()
        count_d = 0
        for root, dirs, files in os.walk(drive):
            dirs[:] = [d for d in dirs if d.lower() not in EXCLUDE_DIRS and not d.startswith("$")]
            for f in files:
                f_lower = f.lower()
                if f_lower in EXCLUDE_FILES or f.startswith("~$") or f_lower.startswith("dumpstack"):
                    continue
                p = os.path.join(root, f)
                try:
                    st = os.stat(p)
                    sz = st.st_size
                    total_files += 1
                    total_bytes += sz
                    count_d += 1
                    if sz == 0:
                        zero_files.append(p)
                    else:
                        size_to_files[sz].append(p)
                except (PermissionError, OSError):
                    pass
        print(f"  -> {drive} tamamlandı: {count_d} dosya ({time.time()-t_d:.2f}s)", flush=True)

    print(f"Toplam taranan dosya: {total_files} ({format_size(total_bytes)})", flush=True)

    # Filter candidate sizes
    candidates = {s: paths for s, paths in size_to_files.items() if len(paths) > 1}
    cand_count = sum(len(p) for p in candidates.values())
    print(f"[2/4] Aynı boyutta {cand_count} adet potansiyel kopya dosya bulundu ({len(candidates)} farklı boyut grubu).", flush=True)

    # Step 2: Quick head+tail sample hash
    print(f"[3/4] Hızlı örnek hash (Baş + Son 64KB) kontrolü yapılıyor...", flush=True)
    sample_hash_groups = defaultdict(list)
    for sz, paths in candidates.items():
        for p in paths:
            sh = get_quick_sample_hash(p, sz)
            if sh:
                sample_hash_groups[(sz, sh)].append(p)

    potential_full = {k: paths for k, paths in sample_hash_groups.items() if len(paths) > 1}
    full_count = sum(len(p) for p in potential_full.values())
    print(f"[4/4] Birebir eşleşen {full_count} aday dosya için tam SHA-256 doğrulaması yapılıyor...", flush=True)

    full_hash_groups = defaultdict(list)
    processed = 0
    t_hash_start = time.time()

    for (sz, sh), paths in potential_full.items():
        # Optimization: for files < 100KB, sample hash was already entire file!
        if sz <= 131072:
            for p in paths:
                processed += 1
                full_hash_groups[(sz, sh)].append(p)
            continue

        for p in paths:
            processed += 1
            if processed % 50 == 0 or processed == full_count:
                print(f"  Doğrulanıyor: {processed}/{full_count} ({format_size(sz)})...", flush=True)
            fh = get_full_hash(p)
            if fh:
                full_hash_groups[(sz, fh)].append(p)

    print(f"Hash doğrulama tamamlandı ({time.time() - t_hash_start:.2f}s)", flush=True)

    # Process duplicates
    duplicates = []
    total_wasted = 0
    group_idx = 1

    for (sz, fh), paths in full_hash_groups.items():
        if len(paths) > 1:
            wasted = sz * (len(paths) - 1)
            total_wasted += wasted
            file_entries = []
            drives = set()

            for p in paths:
                drv = p[:2].upper()
                drives.add(drv)
                try:
                    mtime = os.path.getmtime(p)
                    mtime_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime))
                except:
                    mtime_str = "-"
                file_entries.append({
                    "path": p,
                    "filename": os.path.basename(p),
                    "directory": os.path.dirname(p),
                    "drive": drv,
                    "modified": mtime_str,
                    "extension": os.path.splitext(p)[1].lower() or "uzantısız"
                })
            
            file_entries.sort(key=lambda x: x["path"])
            duplicates.append({
                "group_id": group_idx,
                "hash": fh,
                "size_bytes": sz,
                "size_formatted": format_size(sz),
                "count": len(paths),
                "wasted_bytes": wasted,
                "wasted_formatted": format_size(wasted),
                "is_cross_drive": len(drives) > 1,
                "drives": sorted(list(drives)),
                "files": file_entries
            })
            group_idx += 1

    # Sort duplicates by wasted space descending
    duplicates.sort(key=lambda x: x["wasted_bytes"], reverse=True)

    elapsed = round(time.time() - start_time, 2)
    cross_groups = [g for g in duplicates if g["is_cross_drive"]]
    only_d = [g for g in duplicates if g["drives"] == ["D:"]]
    only_e = [g for g in duplicates if g["drives"] == ["E:"]]

    summary = {
        "scan_date": time.strftime("%Y-%m-%d %H:%M:%S"),
        "elapsed_seconds": elapsed,
        "scanned_drives": TARGET_DRIVES,
        "total_files_scanned": total_files,
        "total_bytes_scanned": total_bytes,
        "total_size_scanned_formatted": format_size(total_bytes),
        "zero_byte_files_count": len(zero_files),
        "duplicate_groups_count": len(duplicates),
        "duplicate_files_count": sum(g["count"] for g in duplicates),
        "total_wasted_bytes": total_wasted,
        "total_wasted_formatted": format_size(total_wasted),
        "cross_drive_groups_count": len(cross_groups),
        "cross_drive_wasted_formatted": format_size(sum(g["wasted_bytes"] for g in cross_groups)),
        "only_d_groups_count": len(only_d),
        "only_e_groups_count": len(only_e),
    }

    out_dir = Path(__file__).parent.resolve()
    
    # Save JSON
    json_path = out_dir / "duplicate_report.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "duplicates": duplicates}, f, ensure_ascii=False, indent=2)
    print(f"✓ JSON rapor kaydedildi: {json_path}", flush=True)

    # Generate Markdown
    md_path = out_dir / "duplicate_report.md"
    generate_md(summary, duplicates, md_path)
    print(f"✓ Markdown rapor kaydedildi: {md_path}", flush=True)

    # Generate HTML
    html_path = out_dir / "duplicate_report.html"
    generate_html(summary, duplicates, html_path)
    print(f"✓ HTML rapor kaydedildi: {html_path}", flush=True)

    print(f"\nİşlem Başarıyla Tamamlandı! Toplam Süre: {elapsed} sn", flush=True)
    print(f"Bulunan Kopya Grup Sayısı: {len(duplicates)} adet", flush=True)
    print(f"Kurtarılabilir Alan (İsraf): {format_size(total_wasted)}", flush=True)

def generate_md(s, duplicates, md_path):
    lines = [
        "# D: ve E: Diskleri Çift (Mükerrer) Dosya Analiz Raporu\n",
        f"- **Tarama Tarihi:** {s['scan_date']}",
        f"- **Tarama Süresi:** {s['elapsed_seconds']} saniye",
        f"- **Taranan Toplam Dosya:** {s['total_files_scanned']:,} dosya ({s['total_size_scanned_formatted']})",
        f"- **Toplam Kopya Dosya Grubu:** {s['duplicate_groups_count']}",
        f"- **Toplam Kopya Dosya Sayısı:** {s['duplicate_files_count']}",
        f"- **Kurtarılabilir Toplam Alan (İsraf):** **{s['total_wasted_formatted']}**",
        f"- **D ↔ E Çapraz Disk Kopyaları:** {s['cross_drive_groups_count']} grup ({s['cross_drive_wasted_formatted']})",
        f"- **Yalnızca D: Diskinde Bulunan Kopyalar:** {s['only_d_groups_count']} grup",
        f"- **Yalnızca E: Diskinde Bulunan Kopyalar:** {s['only_e_groups_count']} grup\n",
        "## 🏆 En Fazla Alan İsrafına Neden Olan İlk 20 Kopya\n",
        "| No | Dosya Adı | Tekil Boyut | Kopya Sayısı | Boşa Harcanan Alan | Diskler | SHA-256 (Kısa) |",
        "| :--- | :--- | :--- | :--- | :--- | :--- | :--- |"
    ]
    for idx, g in enumerate(duplicates[:20], 1):
        name = g["files"][0]["filename"]
        drives = ", ".join(g["drives"])
        hash_short = g["hash"][:12] + "..."
        lines.append(f"| {idx} | `{name}` | {g['size_formatted']} | {g['count']} | **{g['wasted_formatted']}** | {drives} | `{hash_short}` |")

    lines.append("\n## 📂 Detaylı Kopya Dosya Yolları (İlk 30 Grup)\n")
    for idx, g in enumerate(duplicates[:30], 1):
        name = g["files"][0]["filename"]
        lines.append(f"### {idx}. `{name}` — {g['size_formatted']} × {g['count']} adet (**{g['wasted_formatted']} boşa**)")
        lines.append(f"> SHA-256: `{g['hash']}`\n")
        for f in g["files"]:
            lines.append(f"- `[{f['drive']}]` `{f['path']}` *(Tarih: {f['modified']})*")
        lines.append("")

    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

def generate_html(s, duplicates, html_path):
    dups_json = json.dumps(duplicates, ensure_ascii=False)
    summary_json = json.dumps(s, ensure_ascii=False)

    html = f"""<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>D: & E: Diskleri Kopya Dosya Raporu</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {{
      --bg: #0b0f19;
      --card-bg: rgba(18, 24, 38, 0.9);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #6366f1;
      --primary-light: #818cf8;
      --accent: #06b6d4;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
    }}

    * {{ box-sizing: border-box; margin: 0; padding: 0; }}

    body {{
      font-family: 'Plus Jakarta Sans', sans-serif;
      background-color: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2.5rem 1.5rem 5rem;
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.15) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(6, 182, 212, 0.12) 0px, transparent 50%);
      background-attachment: fixed;
      min-height: 100vh;
    }}

    .container {{
      max-width: 1400px;
      margin: 0 auto;
    }}

    header {{
      margin-bottom: 2.5rem;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      flex-wrap: wrap;
      gap: 1.5rem;
    }}

    .header-left h1 {{
      font-size: 2.2rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      background: linear-gradient(135deg, #ffffff 40%, var(--primary-light) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }}

    .header-left p {{
      color: var(--text-muted);
      font-size: 0.95rem;
      margin-top: 0.35rem;
    }}

    .header-badge {{
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 9999px;
      font-size: 0.85rem;
      color: var(--accent);
      font-weight: 600;
    }}

    .stats-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1.25rem;
      margin-bottom: 2.5rem;
    }}

    .stat-card {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 1.5rem;
      border-radius: 16px;
      backdrop-filter: blur(12px);
      transition: transform 0.2s, border-color 0.2s;
    }}

    .stat-card:hover {{
      transform: translateY(-2px);
      border-color: rgba(99, 102, 241, 0.4);
    }}

    .stat-title {{
      font-size: 0.82rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }}

    .stat-value {{
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #fff;
    }}

    .stat-value.highlight-danger {{ color: #f87171; }}
    .stat-value.highlight-accent {{ color: #38bdf8; }}
    .stat-value.highlight-warning {{ color: #fbbf24; }}
    .stat-value.highlight-success {{ color: #34d399; }}

    .stat-sub {{
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: 0.35rem;
    }}

    .advice-section {{
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(6, 182, 212, 0.1) 100%);
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 20px;
      padding: 1.75rem 2rem;
      margin-bottom: 2.5rem;
    }}

    .advice-title {{
      font-size: 1.25rem;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin-bottom: 1.2rem;
    }}

    .advice-list {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 1.25rem;
    }}

    .advice-item {{
      background: rgba(11, 15, 25, 0.65);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 1.2rem;
    }}

    .advice-item strong {{
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
      font-size: 0.95rem;
    }}

    .advice-item p {{
      font-size: 0.88rem;
      color: #d1d5db;
    }}

    .controls {{
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.5rem;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 1rem 1.25rem;
      border-radius: 14px;
    }}

    .search-box {{
      flex: 1;
      min-width: 280px;
      position: relative;
    }}

    .search-box input {{
      width: 100%;
      background: rgba(11, 15, 25, 0.8);
      border: 1px solid var(--card-border);
      padding: 0.65rem 1rem 0.65rem 2.5rem;
      border-radius: 8px;
      color: #fff;
      font-size: 0.9rem;
      outline: none;
    }}

    .search-box input:focus {{
      border-color: var(--primary);
    }}

    .search-icon {{
      position: absolute;
      left: 0.85rem;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      font-size: 0.9rem;
    }}

    .filter-group {{
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
    }}

    .filter-btn {{
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 0.45rem 0.9rem;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }}

    .filter-btn:hover {{
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }}

    .filter-btn.active {{
      background: var(--primary);
      border-color: var(--primary);
      color: #fff;
    }}

    .groups-list {{
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }}

    .group-card {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      overflow: hidden;
    }}

    .group-header {{
      padding: 1.1rem 1.4rem;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }}

    .group-title {{
      font-weight: 700;
      font-size: 1.05rem;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }}

    .badge {{
      display: inline-block;
      padding: 0.25rem 0.65rem;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 700;
    }}

    .badge-cross {{
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }}

    .badge-single {{
      background: rgba(99, 102, 241, 0.2);
      color: #a5b4fc;
      border: 1px solid rgba(99, 102, 241, 0.3);
    }}

    .badge-wasted {{
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.25);
    }}

    .group-meta {{
      display: flex;
      align-items: center;
      gap: 1rem;
      font-size: 0.85rem;
      color: var(--text-muted);
    }}

    .hash-code {{
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      background: rgba(0, 0, 0, 0.3);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      color: #94a3b8;
    }}

    .file-items {{
      padding: 0.75rem 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }}

    .batch-toolbar {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 0.9rem 1.25rem;
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1rem;
    }}

    .batch-title {{
      font-size: 0.9rem;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }}

    .batch-btn-group {{
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }}

    .batch-btn {{
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--card-border);
      color: #e2e8f0;
      padding: 0.4rem 0.85rem;
      border-radius: 8px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }}

    .batch-btn:hover {{
      background: rgba(99, 102, 241, 0.25);
      border-color: var(--primary-light);
      color: #fff;
    }}

    .batch-btn.primary {{
      background: rgba(99, 102, 241, 0.2);
      border-color: rgba(99, 102, 241, 0.4);
      color: #a5b4fc;
    }}

    .file-row {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.65rem 0.9rem;
      background: rgba(11, 15, 25, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 10px;
      font-size: 0.85rem;
      gap: 1rem;
      transition: all 0.2s;
    }}

    .file-row:hover {{
      background: rgba(255, 255, 255, 0.03);
    }}

    .file-row.is-selected {{
      background: rgba(239, 68, 68, 0.12);
      border-color: rgba(239, 68, 68, 0.35);
    }}

    .file-chk-label {{
      display: flex;
      align-items: center;
      gap: 0.6rem;
      cursor: pointer;
      user-select: none;
    }}

    .file-chk {{
      width: 1.15rem;
      height: 1.15rem;
      accent-color: #ef4444;
      cursor: pointer;
    }}

    .file-path {{
      font-family: 'JetBrains Mono', monospace;
      color: #e2e8f0;
      word-break: break-all;
      flex: 1;
    }}

    .file-row.is-selected .file-path {{
      color: #fca5a5;
      text-decoration: line-through;
      opacity: 0.85;
    }}

    .status-badge {{
      display: inline-flex;
      align-items: center;
      padding: 0.2rem 0.55rem;
      border-radius: 6px;
      font-size: 0.72rem;
      font-weight: 700;
      white-space: nowrap;
    }}

    .status-keep {{
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }}

    .status-del {{
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.4);
    }}

    .drive-tag {{
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-weight: 700;
      font-size: 0.75rem;
      margin-right: 0.5rem;
    }}

    .drive-d {{ background: #0284c7; color: #fff; }}
    .drive-e {{ background: #7c3aed; color: #fff; }}

    .file-time {{
      color: var(--text-muted);
      white-space: nowrap;
      font-size: 0.8rem;
    }}

    .btn-copy {{
      background: rgba(255, 255, 255, 0.08);
      border: none;
      color: var(--text-muted);
      padding: 0.3rem 0.6rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.75rem;
      transition: background 0.2s, color 0.2s;
    }}

    .btn-copy:hover {{
      background: var(--primary);
      color: #fff;
    }}

    /* STICKY BOTTOM SCRIPT GENERATOR BAR */
    .sticky-script-bar {{
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(16px);
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 -10px 35px rgba(0, 0, 0, 0.6);
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1.25rem;
      transform: translateY(0);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }}

    .bar-summary {{
      display: flex;
      align-items: center;
      gap: 1.25rem;
    }}

    .bar-stat {{
      display: flex;
      flex-direction: column;
    }}

    .bar-stat-lbl {{
      font-size: 0.72rem;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.05em;
    }}

    .bar-stat-val {{
      font-size: 1.25rem;
      font-weight: 800;
      color: #fff;
      font-family: 'JetBrains Mono', monospace;
    }}

    .bar-stat-val.red {{ color: #f87171; }}
    .bar-stat-val.green {{ color: #34d399; }}

    .platform-selector {{
      display: flex;
      align-items: center;
      gap: 0.4rem;
      background: rgba(0, 0, 0, 0.35);
      padding: 0.35rem;
      border-radius: 12px;
      border: 1px solid var(--card-border);
    }}

    .plat-tab {{
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 0.45rem 0.85rem;
      border-radius: 8px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      transition: all 0.2s;
    }}

    .plat-tab:hover {{
      color: #fff;
      background: rgba(255, 255, 255, 0.05);
    }}

    .plat-tab.active {{
      background: var(--primary);
      color: #fff;
      font-weight: 700;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.35);
    }}

    .safe-mode-wrap {{
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.82rem;
      color: #cbd5e1;
      cursor: pointer;
      user-select: none;
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.25);
      padding: 0.45rem 0.85rem;
      border-radius: 10px;
    }}

    .safe-mode-wrap input {{
      accent-color: #f59e0b;
      cursor: pointer;
    }}

    .bar-actions {{
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }}

    .btn-act {{
      padding: 0.6rem 1.15rem;
      border-radius: 10px;
      font-size: 0.88rem;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: all 0.2s;
      border: none;
    }}

    .btn-copy-all {{
      background: linear-gradient(135deg, #06b6d4, #0284c7);
      color: #fff;
      box-shadow: 0 4px 14px rgba(6, 182, 212, 0.3);
    }}

    .btn-copy-all:hover {{
      filter: brightness(1.1);
      transform: translateY(-1px);
    }}

    .btn-download {{
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      color: #fff;
      box-shadow: 0 4px 14px rgba(99, 102, 241, 0.3);
    }}

    .btn-download:hover {{
      filter: brightness(1.1);
      transform: translateY(-1px);
    }}

    .btn-preview {{
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid var(--card-border);
      color: #fff;
    }}

    .btn-preview:hover {{
      background: rgba(255, 255, 255, 0.18);
    }}

    /* MODAL */
    .modal-overlay {{
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 2000;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }}

    .modal-overlay.open {{ display: flex; }}

    .modal-box {{
      background: #111827;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 20px;
      max-width: 900px;
      width: 100%;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.8);
    }}

    .modal-head {{
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }}

    .modal-head h3 {{
      font-size: 1.15rem;
      font-weight: 700;
      color: #fff;
    }}

    .modal-close {{
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 1.5rem;
      cursor: pointer;
    }}

    .modal-body {{
      padding: 1.5rem;
      overflow-y: auto;
      flex: 1;
    }}

    .code-block {{
      background: #030712;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 1.25rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.82rem;
      color: #7dd3fc;
      white-space: pre;
      overflow-x: auto;
      line-height: 1.5;
    }}

    .toast {{
      position: fixed;
      top: 2rem;
      right: 2rem;
      z-index: 3000;
      background: #10b981;
      color: #fff;
      padding: 0.9rem 1.5rem;
      border-radius: 12px;
      font-weight: 700;
      box-shadow: 0 10px 25px rgba(16, 185, 129, 0.4);
      display: none;
      animation: fadeIn 0.3s;
    }}

    @keyframes fadeIn {{
      from {{ opacity: 0; transform: translateY(-10px); }}
      to {{ opacity: 1; transform: translateY(0); }}
    }}

    .footer {{
      margin-top: 3.5rem;
      padding-bottom: 5rem;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.85rem;
    }}
  </style>
</head>
<body>
  <div class="toast" id="toast">✓ Komutlar panoya kopyalandı!</div>

  <div class="container">
    <header>
      <div class="header-left">
        <h1>D: & E: Diskleri Kopya Dosya Raporu</h1>
        <p>SHA-256 Hash Bütünlüğü ile Doğrulanmış Mükerrer Dosya ve Alan Kurtarma Analizi</p>
      </div>
      <div class="header-badge">
        <span>🕒 {s['scan_date']}</span> • <span>⚡ {s['elapsed_seconds']} sn</span>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-title">Kurtarılabilir Alan (İsraf)</div>
        <div class="stat-value highlight-danger">{s['total_wasted_formatted']}</div>
        <div class="stat-sub">Kopyalar temizlendiğinde açılacak yer</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Kopya Dosya Grubu</div>
        <div class="stat-value highlight-accent">{s['duplicate_groups_count']}</div>
        <div class="stat-sub">Toplam {s['duplicate_files_count']} mükerrer dosya</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">D ↔ E Çapraz Kopyalar</div>
        <div class="stat-value highlight-warning">{s['cross_drive_groups_count']} grup</div>
        <div class="stat-sub">İki diskte birden olan ortak dosyalar</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Taranan Toplam Boyut</div>
        <div class="stat-value highlight-success">{s['total_size_scanned_formatted']}</div>
        <div class="stat-sub">{s['total_files_scanned']:,} dosya incelendi</div>
      </div>
    </div>

    <!-- TAVSİYELER BÖLÜMÜ -->
    <div class="advice-section">
      <div class="advice-title">
        <span>💡</span> Ne Yapmalısınız? Size Özel Temizlik & Optimizasyon Önerileri
      </div>
      <div class="advice-list">
        <div class="advice-item">
          <strong>📂 1. Klasör Düzeyinde Kopya Tespiti (Önemli!)</strong>
          <p>Raporu incelediğinizde bazı projelerin (örn. video veya proje yedek klasörleri) tüm alt klasörleriyle birlikte birden fazla yere kopyalandığını görebilirsiniz. Tek tek dosya silmek yerine bu mükerrer klasörleri tek hamlede yönetebilirsiniz.</p>
        </div>
        <div class="advice-item">
          <strong>💾 2. Çapraz Disk (D ↔ E) Senkronizasyonu</strong>
          <p>E: sürücüsü genellikle harici/yedek disk olarak kullanılır. Eğer D:'deki veriyi E:'ye yedeklediyseniz bu normaldir; ancak her iki diskte de çalışıp değişiklik yapıyorsanız en güncel olanı tutup diğerini arşivleyebilirsiniz.</p>
        </div>
        <div class="advice-item">
          <strong>🛡️ 3. Güvenli Silme (Dry-Run ve Çöp Kutusu)</strong>
          <p>Dosyaları kalıcı olarak silmeden önce bir <code>_SILINECEKLER</code> klasörüne taşıyıp sisteminizi birkaç gün test etmek veri kaybı riskini tamamen ortadan kaldırır.</p>
        </div>
      </div>
    </div>

    <!-- AKILLI TOPLU SEÇİM ARAÇ ÇUBUĞU -->
    <div class="batch-toolbar">
      <div class="batch-title">
        <span>⚡</span> Akıllı Silme Seçimi:
      </div>
      <div class="batch-btn-group">
        <button class="batch-btn primary" onclick="autoSelectKeepFirst()" title="Her gruptaki ilk dosyayı saklar, geri kalan mükerrer kopyaları silmek üzere işaretler">
          ✨ İlkini Tut, Kalanları Seç (Önerilen)
        </button>
        <button class="batch-btn" onclick="autoSelectKeepNewest()" title="Her grupta en son düzenlenen dosyayı saklar, eski tarihli kopyaları siler">
          🕒 En Yeniyi Tut, Eskileri Seç
        </button>
        <button class="batch-btn" onclick="autoSelectKeepOldest()" title="En eski orijinal dosyayı saklar, sonradan kopyalananları seçer">
          📁 En Eskiyi Tut, Yenileri Seç
        </button>
        <button class="batch-btn" onclick="clearAllSelections()" title="İşaretlenen tüm dosyaları sıfırlar">
          ❌ Seçimleri Temizle
        </button>
      </div>
    </div>

    <!-- KONTROLLER -->
    <div class="controls">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" id="searchInput" placeholder="Dosya adı, yol, uzantı (.mp4, .pdf) veya SHA-256 ara...">
      </div>
      <div class="filter-group">
        <button class="filter-btn active" data-filter="all">Tümü ({s['duplicate_groups_count']})</button>
        <button class="filter-btn" data-filter="cross">Hem D hem E ({s['cross_drive_groups_count']})</button>
        <button class="filter-btn" data-filter="d">Sadece D ({s['only_d_groups_count']})</button>
        <button class="filter-btn" data-filter="e">Sadece E ({s['only_e_groups_count']})</button>
        <button class="filter-btn" data-filter="large">Büyükler (>10MB)</button>
      </div>
    </div>

    <!-- LİSTE -->
    <div class="groups-list" id="groupsList"></div>

    <div class="footer">
      <p>Bu rapor Arşiv 360 tarafından SHA-256 hash doğrulaması ile üretilmiştir.</p>
    </div>
  </div>

  <!-- SABİT ALT KOMUT BETİĞİ OLUŞTURUCU ÇUBUĞU -->
  <div class="sticky-script-bar" id="scriptBar">
    <div class="bar-summary">
      <div class="bar-stat">
        <span class="bar-stat-lbl">Silinecek Kopya</span>
        <span class="bar-stat-val red" id="selCount">0 dosya</span>
      </div>
      <div class="bar-stat">
        <span class="bar-stat-lbl">Açılacak Alan</span>
        <span class="bar-stat-val green" id="selSize">0 B</span>
      </div>
      <label class="safe-mode-wrap" title="İşaretli dosyaları kalıcı olarak silmek yerine diskin kökündeki _SILINECEK_KOPYALAR klasörüne taşır.">
        <input type="checkbox" id="safeModeChbox" checked onchange="updateScriptStats()">
        <span>🛡️ Güvenli Mod (_SILINECEK_KOPYALAR klasörüne taşı)</span>
      </label>
    </div>

    <!-- PLATFORM SEÇİMİ -->
    <div class="platform-selector">
      <button class="plat-tab active" data-plat="powershell" onclick="setPlatform('powershell')">
        <span>🟦 PowerShell (.ps1)</span>
      </button>
      <button class="plat-tab" data-plat="cmd" onclick="setPlatform('cmd')">
        <span>⬛ Windows CMD (.bat)</span>
      </button>
      <button class="plat-tab" data-plat="bash" onclick="setPlatform('bash')">
        <span>🍏 macOS / Linux (.sh)</span>
      </button>
    </div>

    <div class="bar-actions">
      <button class="btn-act btn-preview" onclick="openPreviewModal()">
        👁️ Önizle
      </button>
      <button class="btn-act btn-copy-all" onclick="copyScriptToClipboard()">
        📋 Komutları Kopyala
      </button>
      <button class="btn-act btn-download" onclick="downloadScript()">
        💾 Betiği İndir
      </button>
    </div>
  </div>

  <!-- MODAL: SCRIPT PREVIEW -->
  <div class="modal-overlay" id="previewModal">
    <div class="modal-box">
      <div class="modal-head">
        <h3 id="modalTitle">PowerShell Temizleme Betiği Önizleme</h3>
        <button class="modal-close" onclick="closePreviewModal()">&times;</button>
      </div>
      <div class="modal-body">
        <p style="font-size:0.85rem; color:#94a3b8; margin-bottom:1rem;">
          Aşağıdaki komutları terminalinize kopyalayıp çalıştırabilir veya doğrudan dosya olarak indirebilirsiniz:
        </p>
        <div class="code-block" id="modalCode"></div>
      </div>
      <div class="modal-head" style="border-top:1px solid var(--card-border); border-bottom:none; justify-content:flex-end; gap:0.5rem;">
        <button class="btn-act btn-preview" onclick="closePreviewModal()">Kapat</button>
        <button class="btn-act btn-copy-all" onclick="copyScriptToClipboard()">📋 Kopyala</button>
        <button class="btn-act btn-download" onclick="downloadScript()">💾 İndir</button>
      </div>
    </div>
  </div>

  <script>
    const duplicateData = {dups_json};
    let currentFilter = 'all';
    let searchQuery = '';
    let currentPlatform = 'powershell';

    // Set of selected file paths for deletion
    const selectedPaths = new Set();

    function formatBytes(bytes) {{
      if (!bytes || bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
    }}

    function renderList() {{
      const container = document.getElementById('groupsList');
      container.innerHTML = '';

      const filtered = duplicateData.filter(g => {{
        if (currentFilter === 'cross' && !g.is_cross_drive) return false;
        if (currentFilter === 'd' && (g.is_cross_drive || g.drives[0] !== 'D:')) return false;
        if (currentFilter === 'e' && (g.is_cross_drive || g.drives[0] !== 'E:')) return false;
        if (currentFilter === 'large' && g.size_bytes < 10 * 1024 * 1024) return false;

        if (searchQuery) {{
          const q = searchQuery.toLowerCase();
          const matchHash = g.hash.toLowerCase().includes(q);
          const matchFile = g.files.some(f => f.path.toLowerCase().includes(q) || f.filename.toLowerCase().includes(q));
          if (!matchHash && !matchFile) return false;
        }}
        return true;
      }});

      if (filtered.length === 0) {{
        container.innerHTML = '<div style="text-align:center; padding:3rem; color:var(--text-muted); background:var(--card-bg); border-radius:16px;">Arama kriterlerine uygun kopya dosya bulunamadı.</div>';
        return;
      }}

      filtered.forEach((group, idx) => {{
        const card = document.createElement('div');
        card.className = 'group-card';
        card.id = 'group-' + group.group_id;

        const crossBadge = group.is_cross_drive 
          ? '<span class="badge badge-cross">Çapraz Disk (D ↔ E)</span>'
          : '<span class="badge badge-single">Disk: ' + group.drives.join(', ') + '</span>';

        // Check how many in this group are selected
        const selCountInGroup = group.files.filter(f => selectedPaths.has(f.path)).length;
        const allSelected = selCountInGroup === group.files.length;

        const fileRows = group.files.map((f, fIdx) => {{
          const driveClass = f.drive === 'D:' ? 'drive-d' : 'drive-e';
          const isSelected = selectedPaths.has(f.path);
          const rowClass = isSelected ? 'file-row is-selected' : 'file-row';
          const statusHtml = isSelected
            ? '<span class="status-badge status-del">Silinecek</span>'
            : '<span class="status-badge status-keep">Saklanacak</span>';

          return `
            <div class="${{rowClass}}" id="row-${{idx}}-${{fIdx}}">
              <label class="file-chk-label">
                <input type="checkbox" class="file-chk" ${{isSelected ? 'checked' : ''}} 
                  onchange="toggleFileSelection('${{escapeJs(f.path)}}', this.checked)">
                ${{statusHtml}}
              </label>
              <div class="file-path">
                <span class="drive-tag ${{driveClass}}">${{f.drive}}</span>${{escapeHtml(f.path)}}
              </div>
              <div class="file-time">${{f.modified}}</div>
              <button class="btn-copy" onclick="navigator.clipboard.writeText('${{escapeJs(f.path)}}'); showToast('Dosya yolu kopyalandı!')">Yolu Kopyala</button>
            </div>
          `;
        }}).join('');

        const warningBanner = allSelected
          ? '<span style="font-size:0.75rem; color:#f87171; font-weight:700; background:rgba(239,68,68,0.15); padding:0.2rem 0.5rem; border-radius:6px; border:1px solid rgba(239,68,68,0.3);">⚠️ DİKKAT: Gruptaki tüm kopyalar seçili!</span>'
          : '';

        card.innerHTML = `
          <div class="group-header">
            <div class="group-title">
              <span>${{idx + 1}}. ${{escapeHtml(group.files[0].filename)}}</span>
              ${{crossBadge}}
              <span class="badge badge-wasted">-${{group.wasted_formatted}} israf</span>
              ${{warningBanner}}
            </div>
            <div class="group-meta">
              <span>Tekil: <strong>${{group.size_formatted}}</strong></span>
              <span>Adet: <strong>${{group.count}}</strong></span>
              <span class="hash-code" title="${{group.hash}}">SHA: ${{group.hash.substring(0, 14)}}...</span>
            </div>
          </div>
          <div class="file-items">
            ${{fileRows}}
          </div>
        `;
        container.appendChild(card);
      }});

      updateScriptStats();
    }}

    function toggleFileSelection(path, isChecked) {{
      if (isChecked) {{
        selectedPaths.add(path);
      }} else {{
        selectedPaths.delete(path);
      }}
      renderList();
    }}

    function autoSelectKeepFirst() {{
      selectedPaths.clear();
      duplicateData.forEach(g => {{
        // Keep file 0, select files 1..N
        for (let i = 1; i < g.files.length; i++) {{
          selectedPaths.add(g.files[i].path);
        }}
      }});
      renderList();
      showToast('Her gruptan 1 orijinal saklandı, kalan ' + selectedPaths.size + ' kopya seçildi!');
    }}

    function autoSelectKeepNewest() {{
      selectedPaths.clear();
      duplicateData.forEach(g => {{
        // Sort files descending by modified date
        const sorted = [...g.files].sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
        // Keep sorted[0] (newest), delete sorted[1..N]
        for (let i = 1; i < sorted.length; i++) {{
          selectedPaths.add(sorted[i].path);
        }}
      }});
      renderList();
      showToast('En yeni kopyalar saklandı, eski kopyalar seçildi!');
    }}

    function autoSelectKeepOldest() {{
      selectedPaths.clear();
      duplicateData.forEach(g => {{
        const sorted = [...g.files].sort((a, b) => (a.modified || '').localeCompare(b.modified || ''));
        for (let i = 1; i < sorted.length; i++) {{
          selectedPaths.add(sorted[i].path);
        }}
      }});
      renderList();
      showToast('En eski kopyalar saklandı, yeni kopyalar seçildi!');
    }}

    function clearAllSelections() {{
      selectedPaths.clear();
      renderList();
      showToast('Tüm seçimler temizlendi.');
    }}

    function calculateSelectedSize() {{
      let total = 0;
      duplicateData.forEach(g => {{
        g.files.forEach(f => {{
          if (selectedPaths.has(f.path)) {{
            total += g.size_bytes;
          }}
        }});
      }});
      return total;
    }}

    function updateScriptStats() {{
      const count = selectedPaths.size;
      const sizeBytes = calculateSelectedSize();

      document.getElementById('selCount').innerText = count + ' dosya';
      document.getElementById('selSize').innerText = formatBytes(sizeBytes);
    }}

    function setPlatform(plat) {{
      currentPlatform = plat;
      document.querySelectorAll('.plat-tab').forEach(t => {{
        t.classList.toggle('active', t.dataset.plat === plat);
      }});
      if (document.getElementById('previewModal').classList.contains('open')) {{
        openPreviewModal();
      }}
    }}

    function generateScriptText() {{
      const paths = Array.from(selectedPaths);
      const isSafe = document.getElementById('safeModeChbox').checked;
      const totalSize = formatBytes(calculateSelectedSize());
      const now = new Date().toLocaleString('tr-TR');

      if (paths.length === 0) {{
        return '# Henuz silinecek dosya secilmedi.\\n# Lutfen yukaridaki dosyalardan secin veya \"Ilkini Tut, Kalanlari Sec\" butonuna tiklayin.';
      }}

      if (currentPlatform === 'powershell') {{
        if (isSafe) {{
          return `# ========================================================\\n` +
                 `# Arşiv 360 - Güvenli Kopya Taşıma Betiği (PowerShell)\\n` +
                 `# Tarih: ${{now}}\\n` +
                 `# Taşınacak Dosya: ${{paths.length}} adet (${{totalSize}})\\n` +
                 `# ========================================================\\n` +
                 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\\n` +
                 `$ErrorActionPreference = \"Continue\"\\n\\n` +
                 `$targetRoot = \"_SILINECEK_KOPYALAR\"\\n` +
                 `Write-Host \"Kopya dosyalar güvenli karantinaya taşınıyor...\" -ForegroundColor Cyan\\n\\n` +
                 `$files = @(\\n` +
                 paths.map(p => `    \"${{p.replace(/`/g, '``').replace(/\\$/g, '`$')}}\"`).join(',\\n') +
                 `\\n)\\n\\n` +
                 `$success = 0; $fail = 0\\n` +
                 `foreach ($f in $files) {{\\n` +
                 `    if (Test-Path -LiteralPath $f) {{\\n` +
                 `        try {{\\n` +
                 `            $drive = (Get-Item -LiteralPath $f).PSDrive.Name + \":\\\\\"\\n` +
                 `            $destFolder = Join-Path $drive $targetRoot\\n` +
                 `            if (-not (Test-Path -LiteralPath $destFolder)) {{ New-Item -ItemType Directory -Path $destFolder -Force | Out-Null }}\\n` +
                 `            Move-Item -LiteralPath $f -Destination $destFolder -Force -ErrorAction Stop\\n` +
                 `            Write-Host \"  [✓ Taşındı] $f -> $destFolder\" -ForegroundColor Green\\n` +
                 `            $success++\\n` +
                 `        }} catch {{\\n` +
                 `            Write-Host \"  [X Hata] $f ($($_.Exception.Message))\" -ForegroundColor Red\\n` +
                 `            $fail++\\n` +
                 `        }}\\n` +
                 `    }} else {{\\n` +
                 `        Write-Host \"  [-] Bulunamadı: $f\" -ForegroundColor Yellow\\n` +
                 `    }}\\n` +
                 `}}\\n\\n` +
                 `Write-Host \"\\nİşlem Tamamlandı! Başarılı: $success | Hata: $fail\" -ForegroundColor Cyan\\n` +
                 `Write-Host \"Dosyalarınız disk kökündeki '_SILINECEK_KOPYALAR' klasörüne taşındı.\" -ForegroundColor Yellow\\n` +
                 `pause\\n`;
        }} else {{
          return `# ========================================================\\n` +
                 `# Arşiv 360 - Kalıcı Kopya Silme Betiği (PowerShell)\\n` +
                 `# Tarih: ${{now}}\\n` +
                 `# Silinecek Dosya: ${{paths.length}} adet (${{totalSize}})\\n` +
                 `# ========================================================\\n` +
                 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\\n` +
                 `$ErrorActionPreference = \"Continue\"\\n\\n` +
                 `$confirm = Read-Host \"${{paths.length}} adet kopya dosya KALICI OLARAK silinecektir. Devam etmek için 'EVET' yazın\"\\n` +
                 `if ($confirm -ne 'EVET') {{ Write-Host 'İşlem iptal edildi.' -ForegroundColor Yellow; exit }}\\n\\n` +
                 `$files = @(\\n` +
                 paths.map(p => `    \"${{p.replace(/`/g, '``').replace(/\\$/g, '`$')}}\"`).join(',\\n') +
                 `\\n)\\n\\n` +
                 `$deleted = 0\\n` +
                 `foreach ($f in $files) {{\\n` +
                 `    if (Test-Path -LiteralPath $f) {{\\n` +
                 `        try {{\\n` +
                 `            Remove-Item -LiteralPath $f -Force -ErrorAction Stop\\n` +
                 `            Write-Host \"  [✓ Silindi] $f\" -ForegroundColor Green\\n` +
                 `            $deleted++\\n` +
                 `        }} catch {{\\n` +
                 `            Write-Host \"  [X Hata] $f ($($_.Exception.Message))\" -ForegroundColor Red\\n` +
                 `        }}\\n` +
                 `    }}\\n` +
                 `}}\\n\\n` +
                 `Write-Host \"\\nToplam Silinen: $deleted dosya.\" -ForegroundColor Cyan\\npause\\n`;
        }}
      }}

      if (currentPlatform === 'cmd') {{
        if (isSafe) {{
          const lines = [
            `@echo off`,
            `chcp 65001 > nul`,
            `title Arşiv 360 - Kopya Taşıma`,
            `echo ========================================================`,
            `echo Arşiv 360 - Kopya Dosyaları _SILINECEKLER Klasörüne Taşıma`,
            `echo Taşınacak Dosya: ${{paths.length}} adet (${{totalSize}})`,
            `echo ========================================================`,
            `echo.`,
            `pause`
          ];
          paths.forEach(p => {{
            const drv = p.substring(0, 2);
            lines.push(`if not exist \"${{drv}}\\_SILINECEK_KOPYALAR\" mkdir \"${{drv}}\\_SILINECEK_KOPYALAR\" >nul 2>&1`);
            lines.push(`move /y \"${{p}}\" \"${{drv}}\\_SILINECEK_KOPYALAR\\\" >nul 2>&1 && echo [OK] ${{p}} || echo [HATA] ${{p}}`);
          }});
          lines.push(`echo.`, `echo İşlem tamamlandı. Dosyalar _SILINECEK_KOPYALAR klasörüne taşındı.`, `pause`);
          return lines.join('\\n');
        }} else {{
          const lines = [
            `@echo off`,
            `chcp 65001 > nul`,
            `title Arşiv 360 - Kalıcı Kopya Silme`,
            `echo ========================================================`,
            `echo DİKKAT: ${{paths.length}} adet dosya kalıcı olarak silinecek!`,
            `echo Kurtarılacak Alan: ${{totalSize}}`,
            `echo ========================================================`,
            `set /p onay=\"Onaylıyor musunuz? (E/H): \"`,
            `if /i not \"%onay%\"==\"E\" exit /b`,
            `echo.`
          ];
          paths.forEach(p => {{
            lines.push(`del /f /q \"${{p}}\" 2>nul && echo [SILINDI] ${{p}} || echo [BULUNAMADI/HATA] ${{p}}`);
          }});
          lines.push(`echo.`, `echo Tamamlandı.`, `pause`);
          return lines.join('\\n');
        }}
      }}

      if (currentPlatform === 'bash') {{
        const lines = [
          `#!/usr/bin/env bash`,
          `# ========================================================`,
          `# Arşiv 360 - Kopya Dosya Temizleme Betiği (macOS & Linux)`,
          `# Dosya Sayısı: ${{paths.length}} adet (${{totalSize}})`,
          `# ========================================================`,
          `set -euo pipefail`,
          `echo \"Toplam ${{paths.length}} dosya işlenecek...\"`
        ];
        if (isSafe) {{
          lines.push(
            `mkdir -p \"./_SILINECEK_KOPYALAR\"`,
            `echo \"Dosyalar ./_SILINECEK_KOPYALAR klasörüne taşınıyor...\"`
          );
          paths.forEach(p => {{
            // Convert Windows path to slash if needed
            const posixPath = p.replace(/\\\\/g, '/');
            lines.push(`mv -f \"${{posixPath}}\" \"./_SILINECEK_KOPYALAR/\" 2>/dev/null || true`);
          }});
        }} else {{
          lines.push(
            `read -p \"Dosyaları kalıcı olarak silmek istiyor musunuz? (e/h): \" onay`,
            `if [[ \"$onay\" != \"e\" && \"$onay\" != \"E\" ]]; then echo \"İptal edildi.\"; exit 0; fi`
          );
          paths.forEach(p => {{
            const posixPath = p.replace(/\\\\/g, '/');
            lines.push(`rm -f \"${{posixPath}}\"`);
          }});
        }}
        lines.push(`echo \"İşlem tamamlandı!\"`);
        return lines.join('\\n');
      }}

      return '';
    }}

    function copyScriptToClipboard() {{
      const text = generateScriptText();
      navigator.clipboard.writeText(text).then(() => {{
        showToast('✓ ' + currentPlatform.toUpperCase() + ' komutları panoya kopyalandı!');
      }});
    }}

    function downloadScript() {{
      const text = generateScriptText();
      const ext = currentPlatform === 'powershell' ? 'ps1' : currentPlatform === 'cmd' ? 'bat' : 'sh';
      const filename = `arsiv360_kopya_temizle_${{Date.now()}}.${{ext}}`;
      
      const blob = new Blob([text], {{ type: 'text/plain;charset=utf-8' }});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showToast('✓ ' + filename + ' dosyası indirildi!');
    }}

    function openPreviewModal() {{
      const code = generateScriptText();
      const titles = {{
        powershell: 'Windows PowerShell Betiği (.ps1)',
        cmd: 'Windows CMD / Batch Betiği (.bat)',
        bash: 'macOS & Linux Bash Betiği (.sh)'
      }};
      document.getElementById('modalTitle').innerText = titles[currentPlatform] || 'Betiği Önizle';
      document.getElementById('modalCode').innerText = code;
      document.getElementById('previewModal').classList.add('open');
    }}

    function closePreviewModal() {{
      document.getElementById('previewModal').classList.remove('open');
    }}

    function showToast(msg) {{
      const t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(() => {{
        t.style.display = 'none';
      }}, 3500);
    }}

    function escapeHtml(str) {{
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }}

    function escapeJs(str) {{
      return str.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
    }}

    document.querySelectorAll('.filter-btn').forEach(btn => {{
      btn.addEventListener('click', () => {{
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderList();
      }});
    }});

    document.getElementById('searchInput').addEventListener('input', (e) => {{
      searchQuery = e.target.value.trim();
      renderList();
    }});

    // Initial render
    renderList();
  </script>
</body>
</html>
"""
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)


if __name__ == "__main__":
    main()
