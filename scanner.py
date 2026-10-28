import os
import sys
import hashlib
import time
import json
import sqlite3
import tempfile
import threading
from collections import defaultdict, namedtuple
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed, wait, FIRST_COMPLETED

# Windows konsolunda Unicode karakterlerin (✓ vb.) çökmesini engelle
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try: _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception: pass

# Sabitler: Hızlı Örnek Hash vs Tam SHA-256 Ayrımı ve Önbellek Şeması
SMALL_FILE_FULL_HASH_THRESHOLD = 131072  # 128 KiB
SAMPLE_EDGE_BLOCK_SIZE = 65536           # 64 KiB
FULL_HASH_BLOCK_SIZE = 4 * 1024 * 1024   # 4 MiB

HASH_KIND_FULL = "FULL_SHA256"
HASH_KIND_SAMPLE = "SAMPLE_EDGE_64K"

CACHE_SCHEMA_VERSION = 2
CACHE_HASH_ALGORITHM = "sha256"
RECENT_MTIME_GUARD_NS = 2_000_000_000    # 2 saniye (dosya sistemi zaman damgası çözünürlük koruması)

FileStatSnapshot = namedtuple(
    "FileStatSnapshot",
    ["size", "mtime_ns", "ctime_ns", "dev", "ino"]
)

QuickHashResult = namedtuple(
    "QuickHashResult",
    ["kind", "digest", "stat_snapshot", "status", "error"]
)

FullHashResult = namedtuple(
    "FullHashResult",
    ["digest", "stat_snapshot", "status", "error", "retried"]
)

def _detect_ready_drives():
    ready = []
    for d in ["D:\\", "E:\\", "C:\\"]:
        try:
            if os.path.exists(d):
                os.listdir(d)
                ready.append(d)
        except Exception:
            pass
    return ready or ["C:\\"]

TARGET_DRIVES = _detect_ready_drives()

EXCLUDE_DIRS = {
    "$recycle.bin",
    "system volume information",
    "found.000",
    "found.001",
    "found.002",
    ".trashes",
    ".gemini",
    ".pnpm-store",
    "node_modules",
    ".git",
    "__pycache__"
}

EXCLUDE_FILES = {
    "pagefile.sys",
    "hiberfil.sys",
    "swapfile.sys",
    "dumpstack.log",
    "dumpstack.log.tmp",
    "boottel.dat",
    ".scanner_cache.json",
    ".scanner_cache.sqlite",
    ".scanner_cache.sqlite-wal",
    ".scanner_cache.sqlite-shm"
}

def should_exclude_dir(dir_name):
    """Kök ve alt dizinler için tutarlı klasör hariç tutma kuralı."""
    name_l = dir_name.lower()
    return name_l in EXCLUDE_DIRS or dir_name.startswith("$")

def should_exclude_file(file_name):
    """Kök ve alt dizinler için tutarlı dosya hariç tutma kuralı."""
    name_l = file_name.lower()
    return (
        file_name.startswith("~$")
        or name_l in EXCLUDE_FILES
        or name_l.startswith("dumpstack")
        or name_l.startswith(".scanner_cache.")
    )

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

def format_drives_title(scanned_drives):
    if not scanned_drives:
        return "Tüm Sürücüler"
    clean = [d.rstrip("\\/") for d in scanned_drives]
    if all(len(d) == 2 and d[1] == ':' for d in clean):
        if len(clean) == 1:
            return f"{clean[0]} Diski"
        elif len(clean) == 2:
            return f"{clean[0]} & {clean[1]} Diskleri"
        else:
            return f"{', '.join(clean[:-1])} & {clean[-1]} Diskleri"
    if len(clean) == 1:
        return f"{clean[0]}"
    elif len(clean) == 2:
        return f"{clean[0]} & {clean[1]}"
    else:
        return f"{clean[0]} ve {len(clean)-1} Diğer Dizin"

def normalize_target_path(raw_path):
    """Windows sürücü köklerini (örn. 'D:' -> 'D:\\') ve dizin yollarını normalize eder."""
    p = raw_path.strip().strip('"').strip("'")
    if len(p) == 2 and p[1] == ":":
        return p.upper() + "\\"
    if len(p) == 3 and p[1] == ":" and p[2] in ("\\", "/"):
        return p[:2].upper() + "\\"
    return os.path.abspath(p)

def normalize_cache_key(filepath):
    """Windows/POSIX uyumlu, büyük-küçük harf ve ayraç farklarını gideren önbellek anahtarı."""
    return os.path.normcase(os.path.normpath(os.path.abspath(filepath)))

def extract_drive_label(filepath):
    """Windows sürücü harfini ('D:') veya UNC/POSIX kök etiketini güvenli biçimde döndürür."""
    drive, _ = os.path.splitdrive(os.path.abspath(filepath))
    if drive:
        return drive.upper() if len(drive) == 2 and drive[1] == ":" else drive
    return "ROOT"

def capture_file_stat(filepath):
    """Sembolik bağlantıları takip etmeden dosyanın anlık metadata görüntüsünü alır."""
    try:
        st = os.stat(filepath, follow_symlinks=False)
        return FileStatSnapshot(
            size=st.st_size,
            mtime_ns=getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)),
            ctime_ns=getattr(st, "st_ctime_ns", int(st.st_ctime * 1e9)),
            dev=getattr(st, "st_dev", 0) or 0,
            ino=getattr(st, "st_ino", 0) or 0,
        )
    except (PermissionError, OSError):
        return None

def capture_fd_stat(fd):
    """Açık dosya tanımlayıcısından (fd) metadata görüntüsü alır."""
    try:
        st = os.fstat(fd)
        return FileStatSnapshot(
            size=st.st_size,
            mtime_ns=getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)),
            ctime_ns=getattr(st, "st_ctime_ns", int(st.st_ctime * 1e9)),
            dev=getattr(st, "st_dev", 0) or 0,
            ino=getattr(st, "st_ino", 0) or 0,
        )
    except (PermissionError, OSError):
        return None

def verify_stat_unchanged(before_stat, after_stat, expected_size=None, actual_bytes_read=None):
    """
    Hash hesaplama öncesi ve sonrası metadata bilgilerini karşılaştırır.
    Boyut, mtime_ns veya desteklenen dosya kimliği (dev/ino) değişmişse False döner.
    """
    if before_stat is None or after_stat is None:
        return False
    if expected_size is not None and (before_stat.size != expected_size or after_stat.size != expected_size):
        return False
    if actual_bytes_read is not None and actual_bytes_read != before_stat.size:
        return False
    if before_stat.size != after_stat.size:
        return False
    if before_stat.mtime_ns != after_stat.mtime_ns:
        return False
    if (before_stat.dev or after_stat.dev) and before_stat.dev != after_stat.dev:
        return False
    if (before_stat.ino or after_stat.ino) and before_stat.ino != after_stat.ino:
        return False
    return True

def _is_valid_sha256_hex(val):
    if not isinstance(val, str) or len(val) != 64:
        return False
    try:
        int(val, 16)
        return True
    except ValueError:
        return False

def get_quick_sample_hash_detailed(filepath, file_size, max_retries=1):
    """
    Ön eleme aşaması için hızlı örnek hash veya küçük dosyalar için tam SHA-256 hesaplar.
    - <= 128 KiB: Dosyanın tamamı okunur -> kind = HASH_KIND_FULL ("FULL_SHA256")
    - > 128 KiB : İlk 64 KiB + son 64 KiB okunur -> kind = HASH_KIND_SAMPLE ("SAMPLE_EDGE_64K")
    Okuma öncesi ve sonrası metadata kontrolü yaparak değişen dosyaları yakalar.
    """
    attempts = 0
    while attempts <= max_retries:
        attempts += 1
        stat_before = capture_file_stat(filepath)
        if stat_before is None:
            return QuickHashResult(None, None, None, "READ_ERROR", "stat_failed")
        if stat_before.size != file_size:
            return QuickHashResult(None, None, None, "MODIFIED", "size_changed_before_read")

        try:
            with open(filepath, "rb") as f:
                fd_before = capture_fd_stat(f.fileno())
                if fd_before is not None and not verify_stat_unchanged(stat_before, fd_before, expected_size=file_size):
                    if attempts <= max_retries:
                        continue
                    return QuickHashResult(None, None, None, "MODIFIED", "fd_stat_mismatch")

                h = hashlib.sha256()
                if file_size <= SMALL_FILE_FULL_HASH_THRESHOLD:
                    data = f.read(file_size + 1)
                    if len(data) != file_size:
                        if attempts <= max_retries:
                            continue
                        return QuickHashResult(None, None, None, "MODIFIED", "short_or_long_read")
                    h.update(data)
                    digest = h.hexdigest()
                    kind = HASH_KIND_FULL
                else:
                    head = f.read(SAMPLE_EDGE_BLOCK_SIZE)
                    if len(head) != SAMPLE_EDGE_BLOCK_SIZE:
                        if attempts <= max_retries:
                            continue
                        return QuickHashResult(None, None, None, "MODIFIED", "short_head_read")
                    h.update(head)
                    f.seek(file_size - SAMPLE_EDGE_BLOCK_SIZE)
                    tail = f.read(SAMPLE_EDGE_BLOCK_SIZE)
                    if len(tail) != SAMPLE_EDGE_BLOCK_SIZE:
                        if attempts <= max_retries:
                            continue
                        return QuickHashResult(None, None, None, "MODIFIED", "short_tail_read")
                    h.update(tail)
                    digest = h.hexdigest()
                    kind = HASH_KIND_SAMPLE

            stat_after = capture_file_stat(filepath)
            if not verify_stat_unchanged(stat_before, stat_after, expected_size=file_size):
                if attempts <= max_retries:
                    continue
                return QuickHashResult(None, None, None, "MODIFIED", "stat_changed_after_read")

            return QuickHashResult(kind, digest, stat_after, "OK", None)
        except (PermissionError, OSError) as e:
            return QuickHashResult(None, None, None, "READ_ERROR", str(e))

    return QuickHashResult(None, None, None, "MODIFIED", "max_retries_exceeded")

def get_quick_sample_hash(filepath, file_size):
    """
    128 KiB ve altındaki dosyaların tamamını okuyarak tam SHA-256,
    128 KiB üzerindeki dosyalarda ise ilk ve son 64 KiB üzerinden hızlı örnek hash hesaplar.
    Geriye dönük uyumluluk için hex özeti (veya hata/değişiklik durumunda None) döner.
    Tam/örnek ayrımı için `get_quick_sample_hash_detailed` kullanılır.
    """
    res = get_quick_sample_hash_detailed(filepath, file_size)
    return res.digest if res.status == "OK" else None

# Geriye dönük uyumluluk takma adı
get_fast_edge_hash = get_quick_sample_hash

def get_full_hash_detailed(filepath, expected_size=None, block_size=FULL_HASH_BLOCK_SIZE, max_retries=1, on_chunk_read=None):
    """
    Dosyanın tamamını bloklar halinde okuyarak tam SHA-256 hesaplar.
    - Okuma öncesi ve sonrası boyut, mtime_ns, dev/ino ve okunan toplam bayt sayısını doğrular.
    - Dosya okuma sırasında değiştirilmişse kontrollü olarak yeniden dener veya MODIFIED döndürür.
    """
    attempts = 0
    had_modification = False
    while attempts <= max_retries:
        attempts += 1
        stat_before = capture_file_stat(filepath)
        if stat_before is None:
            return FullHashResult(None, None, "READ_ERROR", "stat_failed", had_modification)
        if expected_size is not None and stat_before.size != expected_size:
            return FullHashResult(None, None, "MODIFIED", "size_mismatch_before_hash", True)

        h = hashlib.sha256()
        bytes_read = 0
        try:
            with open(filepath, "rb") as f:
                fd_before = capture_fd_stat(f.fileno())
                if fd_before is not None and not verify_stat_unchanged(stat_before, fd_before, expected_size=expected_size):
                    had_modification = True
                    if attempts <= max_retries:
                        continue
                    return FullHashResult(None, None, "MODIFIED", "fd_stat_changed", True)

                chunk_idx = 0
                head_canary = None
                while True:
                    buf = f.read(block_size)
                    if not buf:
                        break
                    if head_canary is None:
                        head_canary = hashlib.sha256(buf[:SAMPLE_EDGE_BLOCK_SIZE]).digest()
                    h.update(buf)
                    bytes_read += len(buf)
                    chunk_idx += 1
                    if on_chunk_read is not None:
                        on_chunk_read(filepath, chunk_idx, bytes_read)
                    if bytes_read > stat_before.size:
                        break

                # Aynı zaman damgası dilimi (sub-tick) içinde gerçekleşen eşzamanlı üzerine yazmaları
                # yakalamak için dosya başlangıç bloğunu (canary) okuma sonunda doğrula
                if head_canary is not None and bytes_read > 0:
                    f.seek(0)
                    recheck_buf = f.read(min(SAMPLE_EDGE_BLOCK_SIZE, bytes_read))
                    if hashlib.sha256(recheck_buf).digest() != head_canary:
                        had_modification = True
                        if attempts <= max_retries:
                            continue
                        return FullHashResult(None, None, "MODIFIED", "content_canary_changed_during_hash", True)

            stat_after = capture_file_stat(filepath)
            if not verify_stat_unchanged(
                stat_before,
                stat_after,
                expected_size=expected_size if expected_size is not None else stat_before.size,
                actual_bytes_read=bytes_read,
            ):
                had_modification = True
                if attempts <= max_retries:
                    continue
                return FullHashResult(None, None, "MODIFIED", "stat_changed_during_hash", True)

            return FullHashResult(h.hexdigest(), stat_after, "OK", None, had_modification)
        except (PermissionError, OSError) as e:
            return FullHashResult(None, None, "READ_ERROR", str(e), had_modification)

    return FullHashResult(None, None, "MODIFIED", "max_retries_exceeded", True)

def get_full_hash(filepath, block_size=FULL_HASH_BLOCK_SIZE, expected_size=None, max_retries=1, on_chunk_read=None):
    """Calculates verified full SHA256 in 4MB blocks. Returns None on read error or concurrent modification."""
    res = get_full_hash_detailed(
        filepath,
        expected_size=expected_size,
        block_size=block_size,
        max_retries=max_retries,
        on_chunk_read=on_chunk_read,
    )
    return res.digest if res.status == "OK" else None


class JsonHashCache:
    """
    Şema sürümlü, metadata doğrulamalı ve atomik yazma destekli JSON hash önbelleği (.scanner_cache.json).
    Yalnızca doğrulanmış TAM SHA-256 değerlerini saklar; örnek (sample) hash'leri asla tam SHA-256 olarak kaydetmez.
    """
    def __init__(self, cache_path):
        self.cache_path = Path(cache_path)
        self.entries = {}
        self.was_reset = False
        self.reset_reason = None
        self.hits = 0
        self.misses = 0
        self.invalidations = 0

    def load(self):
        self.entries = {}
        if not self.cache_path.exists():
            return 0
        try:
            with open(self.cache_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if not isinstance(raw, dict):
                self.was_reset = True
                self.reset_reason = "not_a_dict"
                return 0
            if raw.get("schema_version") != CACHE_SCHEMA_VERSION or raw.get("hash_algorithm") != CACHE_HASH_ALGORITHM:
                self.was_reset = True
                self.reset_reason = "incompatible_schema_version"
                return 0
            entries = raw.get("entries")
            if not isinstance(entries, dict):
                self.was_reset = True
                self.reset_reason = "invalid_entries_map"
                return 0
            valid_entries = {}
            for k, v in entries.items():
                if (
                    isinstance(k, str)
                    and isinstance(v, dict)
                    and _is_valid_sha256_hex(v.get("sha256"))
                    and isinstance(v.get("size"), int)
                    and isinstance(v.get("mtime_ns"), int)
                ):
                    valid_entries[k] = v
            self.entries = valid_entries
            return len(self.entries)
        except Exception as e:
            self.was_reset = True
            self.reset_reason = f"corrupt_cache: {e}"
            self.entries = {}
            return 0

    def get_valid_sha256(self, filepath, current_stat, sample_hash=None):
        """
        Önbellek kaydını mevcut dosya metadata'sı (boyut, mtime_ns, ctime_ns, dev, ino) ve
        varsa ön eleme örnek hash'i ile doğrular. Uyuşmazlık varsa kaydı geçersiz sayar.
        """
        if current_stat is None:
            self.misses += 1
            return None
        key = normalize_cache_key(filepath)
        entry = self.entries.get(key)
        if not entry:
            self.misses += 1
            return None

        # 1. Boyut ve değiştirilme zamanı kontrolü
        if entry.get("size") != current_stat.size or entry.get("mtime_ns") != current_stat.mtime_ns:
            self.invalidations += 1
            self.misses += 1
            return None

        # 2. Dosya kimliği (dev / ino) kontrolü (platform destekliyorsa)
        cached_dev = entry.get("dev", 0) or 0
        cached_ino = entry.get("ino", 0) or 0
        if cached_dev and current_stat.dev and cached_dev != current_stat.dev:
            self.invalidations += 1
            self.misses += 1
            return None
        if cached_ino and current_stat.ino and cached_ino != current_stat.ino:
            self.invalidations += 1
            self.misses += 1
            return None

        # 3. Oluşturulma / metadata değişim zamanı (ctime_ns) kontrolü (mtime korunsa bile yakalar)
        cached_ctime = entry.get("ctime_ns", 0) or 0
        if cached_ctime and current_stat.ctime_ns and cached_ctime != current_stat.ctime_ns:
            self.invalidations += 1
            self.misses += 1
            return None

        # 4. Ön eleme örnek hash (sample_hash) kontrolü (aynı boyut ve aynı mtime ile içerik değişimini yakalar)
        cached_sample = entry.get("sample_hash")
        if sample_hash and cached_sample and cached_sample != sample_hash:
            self.invalidations += 1
            self.misses += 1
            return None

        # 5. Zaman damgası çözünürlük / yarış durumu koruması:
        # Dosya önbellek kaydının doğrulanma zamanına çok yakın veya sonrasında değiştirilmişse yeniden doğrula
        verified_at_ns = entry.get("verified_at_ns", 0) or 0
        if verified_at_ns and current_stat.mtime_ns >= verified_at_ns:
            self.invalidations += 1
            self.misses += 1
            return None

        sha256_val = entry.get("sha256")
        if not _is_valid_sha256_hex(sha256_val):
            self.invalidations += 1
            self.misses += 1
            return None

        self.hits += 1
        return sha256_val

    def put_verified_sha256(self, filepath, stat_snapshot, sha256_hex, sample_hash=None):
        if stat_snapshot is None or not _is_valid_sha256_hex(sha256_hex):
            return
        key = normalize_cache_key(filepath)
        now_ns = time.time_ns()
        # Eğer dosyanın mtime_ns değeri şu anki zamana çok yakınsa (aynı milisaniye içinde oluşturulduysa),
        # aynı tick içinde sonradan yapılabilecek değişikliklere karşı verified_at_ns'yi mtime_ns + 1 olarak kaydet.
        verified_at_ns = max(now_ns, stat_snapshot.mtime_ns + 1)
        self.entries[key] = {
            "path": os.path.abspath(filepath),
            "size": stat_snapshot.size,
            "mtime_ns": stat_snapshot.mtime_ns,
            "ctime_ns": stat_snapshot.ctime_ns,
            "dev": stat_snapshot.dev,
            "ino": stat_snapshot.ino,
            "sample_hash": sample_hash,
            "sha256": sha256_hex,
            "verified_at_ns": verified_at_ns,
        }

    def prune_stale_entries(self, scanned_roots=None, existing_norm_paths=None):
        """
        Taranan kök dizinler altındaki silinmiş veya yolu değişmiş eski önbellek kayıtlarını kontrollü temizler.
        """
        if not self.entries:
            return 0
        removed = 0
        norm_roots = [normalize_cache_key(r) for r in (scanned_roots or [])]
        to_delete = []
        for key, entry in self.entries.items():
            in_scope = not norm_roots or any(
                key == nr or key.startswith(nr.rstrip("\\/") + os.sep) for nr in norm_roots
            )
            if not in_scope:
                continue
            if existing_norm_paths is not None:
                if key not in existing_norm_paths and not os.path.exists(entry.get("path", key)):
                    to_delete.append(key)
            elif not os.path.exists(entry.get("path", key)):
                to_delete.append(key)
        for key in to_delete:
            del self.entries[key]
            removed += 1
        return removed

    def save_atomic(self):
        """Geçici dosyaya yazıp os.replace ile atomik olarak günceller (kesinti durumunda bozulmayı önler)."""
        parent = self.cache_path.parent
        parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": CACHE_SCHEMA_VERSION,
            "hash_algorithm": CACHE_HASH_ALGORITHM,
            "updated_at": time.time(),
            "entries": self.entries,
        }
        tmp_fd = None
        tmp_path = None
        try:
            tmp_fd, tmp_path = tempfile.mkstemp(
                prefix=".scanner_cache_",
                suffix=".tmp",
                dir=str(parent),
            )
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                tmp_fd = None
                json.dump(payload, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, self.cache_path)
            tmp_path = None
            return True
        except Exception:
            if tmp_fd is not None:
                try:
                    os.close(tmp_fd)
                except OSError:
                    pass
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            return False


class SqliteHashCache:
    """
    Büyük ölçekli (milyonlarca dosya) taramalar için WAL modlu, toplu işlem (batch transaction) destekli
    SQLite kalıcı hash önbelleği (.scanner_cache.sqlite).
    """
    def __init__(self, db_path):
        self.db_path = Path(db_path)
        self.was_reset = False
        self.reset_reason = None
        self.hits = 0
        self.misses = 0
        self.invalidations = 0
        self._pending_upserts = {}
        self._conn = None

    def _connect(self):
        if self._conn is not None:
            return self._conn
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA temp_store=MEMORY;")
        self._conn = conn
        return conn

    def load(self):
        try:
            conn = self._connect()
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS cache_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            row = conn.execute("SELECT value FROM cache_meta WHERE key = 'schema_version'").fetchone()
            if row is not None and str(row[0]) != str(CACHE_SCHEMA_VERSION):
                conn.execute("DROP TABLE IF EXISTS hash_cache")
                self.was_reset = True
                self.reset_reason = "incompatible_schema_version"

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS hash_cache (
                    norm_path TEXT PRIMARY KEY,
                    path TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    mtime_ns INTEGER NOT NULL,
                    ctime_ns INTEGER NOT NULL,
                    dev INTEGER NOT NULL,
                    ino INTEGER NOT NULL,
                    sample_hash TEXT,
                    sha256 TEXT NOT NULL,
                    verified_at_ns INTEGER NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_hash_cache_size_mtime ON hash_cache(size, mtime_ns)")
            conn.execute(
                "INSERT OR REPLACE INTO cache_meta(key, value) VALUES ('schema_version', ?), ('hash_algorithm', ?)",
                (str(CACHE_SCHEMA_VERSION), CACHE_HASH_ALGORITHM),
            )
            conn.commit()
            cnt = conn.execute("SELECT COUNT(*) FROM hash_cache").fetchone()[0]
            return cnt
        except sqlite3.DatabaseError as e:
            self.was_reset = True
            self.reset_reason = f"corrupt_sqlite: {e}"
            self.close()
            try:
                if self.db_path.exists():
                    self.db_path.unlink()
            except OSError:
                pass
            conn = self._connect()
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS cache_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS hash_cache (
                    norm_path TEXT PRIMARY KEY,
                    path TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    mtime_ns INTEGER NOT NULL,
                    ctime_ns INTEGER NOT NULL,
                    dev INTEGER NOT NULL,
                    ino INTEGER NOT NULL,
                    sample_hash TEXT,
                    sha256 TEXT NOT NULL,
                    verified_at_ns INTEGER NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_hash_cache_size_mtime ON hash_cache(size, mtime_ns)")
            conn.execute(
                "INSERT OR REPLACE INTO cache_meta(key, value) VALUES ('schema_version', ?), ('hash_algorithm', ?)",
                (str(CACHE_SCHEMA_VERSION), CACHE_HASH_ALGORITHM),
            )
            conn.commit()
            return 0

    def get_valid_sha256(self, filepath, current_stat, sample_hash=None):
        if current_stat is None:
            self.misses += 1
            return None
        key = normalize_cache_key(filepath)
        if key in self._pending_upserts:
            p_entry = self._pending_upserts[key]
            if p_entry["size"] == current_stat.size and p_entry["mtime_ns"] == current_stat.mtime_ns:
                self.hits += 1
                return p_entry["sha256"]

        conn = self._connect()
        row = conn.execute(
            "SELECT size, mtime_ns, ctime_ns, dev, ino, sample_hash, sha256, verified_at_ns FROM hash_cache WHERE norm_path = ?",
            (key,),
        ).fetchone()
        if row is None:
            self.misses += 1
            return None

        sz, mtime_ns, ctime_ns, dev, ino, cached_sample, sha256_val, verified_at_ns = row
        if sz != current_stat.size or mtime_ns != current_stat.mtime_ns:
            self.invalidations += 1
            self.misses += 1
            return None
        if dev and current_stat.dev and dev != current_stat.dev:
            self.invalidations += 1
            self.misses += 1
            return None
        if ino and current_stat.ino and ino != current_stat.ino:
            self.invalidations += 1
            self.misses += 1
            return None
        if ctime_ns and current_stat.ctime_ns and ctime_ns != current_stat.ctime_ns:
            self.invalidations += 1
            self.misses += 1
            return None
        if sample_hash and cached_sample and cached_sample != sample_hash:
            self.invalidations += 1
            self.misses += 1
            return None
        if verified_at_ns and current_stat.mtime_ns >= verified_at_ns:
            self.invalidations += 1
            self.misses += 1
            return None
        if not _is_valid_sha256_hex(sha256_val):
            self.invalidations += 1
            self.misses += 1
            return None

        self.hits += 1
        return sha256_val

    def put_verified_sha256(self, filepath, stat_snapshot, sha256_hex, sample_hash=None):
        if stat_snapshot is None or not _is_valid_sha256_hex(sha256_hex):
            return
        key = normalize_cache_key(filepath)
        now_ns = time.time_ns()
        verified_at_ns = max(now_ns, stat_snapshot.mtime_ns + 1)
        self._pending_upserts[key] = {
            "norm_path": key,
            "path": os.path.abspath(filepath),
            "size": stat_snapshot.size,
            "mtime_ns": stat_snapshot.mtime_ns,
            "ctime_ns": stat_snapshot.ctime_ns,
            "dev": stat_snapshot.dev,
            "ino": stat_snapshot.ino,
            "sample_hash": sample_hash,
            "sha256": sha256_hex,
            "verified_at_ns": verified_at_ns,
        }
        if len(self._pending_upserts) >= 2000:
            self.flush()

    def flush(self):
        if not self._pending_upserts:
            return
        conn = self._connect()
        rows = [
            (
                v["norm_path"],
                v["path"],
                v["size"],
                v["mtime_ns"],
                v["ctime_ns"],
                v["dev"],
                v["ino"],
                v["sample_hash"],
                v["sha256"],
                v["verified_at_ns"],
            )
            for v in self._pending_upserts.values()
        ]
        with conn:
            conn.executemany(
                """
                INSERT OR REPLACE INTO hash_cache(
                    norm_path, path, size, mtime_ns, ctime_ns, dev, ino, sample_hash, sha256, verified_at_ns
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        self._pending_upserts.clear()

    def prune_stale_entries(self, scanned_roots=None, existing_norm_paths=None):
        self.flush()
        conn = self._connect()
        norm_roots = [normalize_cache_key(r) for r in (scanned_roots or [])]
        rows = conn.execute("SELECT norm_path, path FROM hash_cache").fetchall()
        to_delete = []
        for norm_path, orig_path in rows:
            in_scope = not norm_roots or any(
                norm_path == nr or norm_path.startswith(nr.rstrip("\\/") + os.sep) for nr in norm_roots
            )
            if not in_scope:
                continue
            if existing_norm_paths is not None:
                if norm_path not in existing_norm_paths and not os.path.exists(orig_path):
                    to_delete.append((norm_path,))
            elif not os.path.exists(orig_path):
                to_delete.append((norm_path,))
        if to_delete:
            with conn:
                conn.executemany("DELETE FROM hash_cache WHERE norm_path = ?", to_delete)
        return len(to_delete)

    def save_atomic(self):
        try:
            self.flush()
            if self._conn is not None:
                self._conn.commit()
            return True
        except Exception:
            return False

    def close(self):
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None


def scan_subtree(root_path):
    """
    Bir alt klasör dalını os.scandir ile hızlı ve rekürsif tarar.
    Sembolik bağlantıları takip etmez; izin hatalarını ve hariç tutulanları ayrı sayar.
    """
    local_size_to_files = defaultdict(list)
    local_zero_files = []
    local_count = 0
    local_bytes = 0
    local_perm_errors = 0
    local_symlinks_skipped = 0
    local_excluded_skipped = 0

    stack = [root_path]
    while stack:
        curr = stack.pop()
        try:
            with os.scandir(curr) as it:
                for entry in it:
                    try:
                        if entry.is_symlink():
                            local_symlinks_skipped += 1
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if should_exclude_dir(entry.name):
                                local_excluded_skipped += 1
                                continue
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            if should_exclude_file(entry.name):
                                local_excluded_skipped += 1
                                continue
                            st = entry.stat(follow_symlinks=False)
                            sz = st.st_size
                            mtime_ns = getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))
                            local_count += 1
                            local_bytes += sz
                            if sz == 0:
                                local_zero_files.append(entry.path)
                            else:
                                local_size_to_files[sz].append((entry.path, mtime_ns))
                    except (PermissionError, OSError):
                        local_perm_errors += 1
                        continue
        except (PermissionError, OSError):
            local_perm_errors += 1
            continue

    return (
        local_size_to_files,
        local_zero_files,
        local_count,
        local_bytes,
        local_perm_errors,
        local_symlinks_skipped,
        local_excluded_skipped,
    )

def discover_drive_branches(drive_path):
    """
    Sürücü/dizin kökündeki ana klasör dallarını ve kök dosyalarını keşfeder.
    Alt klasörlerle birebir aynı sembolik bağlantı ve hariç tutma kurallarını uygular.
    """
    subdirs = []
    root_files = []
    perm_errors = 0
    symlinks_skipped = 0
    excluded_skipped = 0
    try:
        with os.scandir(drive_path) as it:
            for entry in it:
                try:
                    if entry.is_symlink():
                        symlinks_skipped += 1
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if should_exclude_dir(entry.name):
                            excluded_skipped += 1
                            continue
                        subdirs.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        if should_exclude_file(entry.name):
                            excluded_skipped += 1
                            continue
                        st = entry.stat(follow_symlinks=False)
                        mtime_ns = getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))
                        root_files.append((entry.path, st.st_size, mtime_ns))
                except (PermissionError, OSError):
                    perm_errors += 1
                    continue
    except (PermissionError, OSError):
        perm_errors += 1
    return subdirs, root_files, perm_errors, symlinks_skipped, excluded_skipped

def _run_bounded_pool(executor, worker_fn, items, max_pending):
    """
    Milyonlarca aday dosyada tüm görevleri aynı anda belleğe kuyruklamadan ve
    executor.map'in sıra bloklamasına (head-of-line blocking) takılmadan
    sınırlı sayıda bekleyen görevle (sliding window) sonuçları tamamlandıkça üretir.
    """
    it = iter(items)
    pending = set()
    for _ in range(max_pending):
        try:
            item = next(it)
        except StopIteration:
            break
        pending.add(executor.submit(worker_fn, item))

    while pending:
        done, pending = wait(pending, return_when=FIRST_COMPLETED)
        for fut in done:
            yield fut.result()
            try:
                item = next(it)
                pending.add(executor.submit(worker_fn, item))
            except StopIteration:
                pass

def safe_quarantine_or_delete(
    selected_paths,
    duplicates,
    mode="quarantine",
    quarantine_dir_name="_SILINECEK_KOPYALAR",
    user_confirmed=False,
):
    """
    Hash doğrulamasından bağımsız ek güvenlik kontrolleriyle karantinaya taşıma veya silme işlemi:
    1. Açık kullanıcı onayı (`user_confirmed=True`) olmadan hiçbir dosyaya dokunmaz.
    2. Her kopya grubunda en az 1 adet seçilmemiş (korunacak) dosyanın diskte var olduğunu ve
       tam SHA-256 değerinin hâlâ grup hash'i ile eşleştiğini doğrular.
    3. İşlem yapılacak dosyanın boyutunun ve anlık tam SHA-256 hash'inin değişmediğini doğrular.
    4. Karantina modunda aynı isimli dosyaların birbirini ezmesini önlemek için göreli dizin yapısını korur.
    """
    if not user_confirmed:
        return {
            "status": "ABORTED_NO_CONFIRMATION",
            "moved_or_deleted": [],
            "skipped": list(selected_paths),
            "errors": ["Kullanıcı onayı (user_confirmed=True) verilmediği için işlem reddedildi."],
        }

    selected_norm = {normalize_cache_key(p): p for p in selected_paths}
    moved_or_deleted = []
    skipped = []
    errors = []

    for group in duplicates:
        expected_hash = group.get("hash")
        expected_size = group.get("size_bytes")
        group_files = [f["path"] for f in group.get("files", [])]
        if len(group_files) < 2:
            continue

        keepers = [p for p in group_files if normalize_cache_key(p) not in selected_norm]
        targets = [p for p in group_files if normalize_cache_key(p) in selected_norm]
        if not targets:
            continue

        # Güvenlik Kuralı 1: Gruptaki tüm dosyaların silinmesini engelle; en az 1 sağlam kopya kalmalı
        if not keepers:
            for t in targets:
                skipped.append(t)
                errors.append(f"Gruptaki tüm kopyalar seçildiği için güvenlik nedeniyle atlandı: {t}")
            continue

        # Korunacak (keeper) dosyalardan en az birinin diskte sağlam ve aynı SHA-256'da olduğunu doğrula
        verified_keeper = None
        for kp in keepers:
            kp_hash = get_full_hash(kp, expected_size=expected_size)
            if kp_hash == expected_hash:
                verified_keeper = kp
                break

        if verified_keeper is None:
            for t in targets:
                skipped.append(t)
                errors.append(f"Korunacak kopya doğrulanamadığı için işlem iptal edildi: {t}")
            continue

        # Varsa bağımsız sistem koruma motorunu (ProtectionEngine) devreye al
        prot_engine = None
        try:
            from engine.protection_engine import ProtectionEngine
            prot_engine = ProtectionEngine()
        except Exception:
            prot_engine = None

        for target_path in targets:
            if normalize_cache_key(target_path) == normalize_cache_key(verified_keeper):
                skipped.append(target_path)
                continue
            if prot_engine is not None:
                try:
                    prot_engine.assert_can_delete_or_move(target_path)
                except Exception as pe:
                    skipped.append(target_path)
                    errors.append(str(pe))
                    continue

            current_hash = get_full_hash(target_path, expected_size=expected_size)
            if current_hash != expected_hash:
                skipped.append(target_path)
                errors.append(f"Dosya tarama sonrasında değiştiği veya okunamadığı için atlandı: {target_path}")
                continue

            try:
                if mode == "quarantine":
                    drv, tail = os.path.splitdrive(os.path.abspath(target_path))
                    rel_tail = tail.lstrip("\\/")
                    base_root = (drv + "\\") if drv else os.path.dirname(os.path.abspath(target_path))
                    dest_path = os.path.join(base_root, quarantine_dir_name, rel_tail)
                    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                    # Çakışmasız karantina hedefi: mevcut dosyanın üzerine ASLA yazma
                    if os.path.exists(dest_path):
                        stem, ext = os.path.splitext(dest_path)
                        idx = 1
                        while os.path.exists(dest_path):
                            dest_path = f"{stem}_kopya_{idx}{ext}"
                            idx += 1
                    os.replace(target_path, dest_path)
                    moved_or_deleted.append({"source": target_path, "destination": dest_path, "mode": "quarantine"})
                elif mode == "delete":
                    os.remove(target_path)
                    moved_or_deleted.append({"source": target_path, "destination": None, "mode": "delete"})
                else:
                    raise ValueError(f"Bilinmeyen işlem modu: {mode}")
            except OSError as e:
                skipped.append(target_path)
                errors.append(f"İşlem hatası ({target_path}): {e}")

    return {
        "status": "OK",
        "moved_or_deleted": moved_or_deleted,
        "skipped": skipped,
        "errors": errors,
    }

def scan_directories(
    target_drives,
    out_dir=None,
    cache_path=None,
    cache_backend="json",
    num_workers=None,
    max_retries=1,
    on_chunk_read=None,
    include_zero_byte_duplicates=False,
    write_reports=True,
    quiet=False,
):
    """
    Mevcut 6 aşamalı tarama mimarisini koruyarak kopya dosya taramasını yürütür:
    1. os.scandir ile paralel dizin/sürücü taraması
    2. Boyuta göre gruplama
    3. Hızlı örnek hash (<=128 KiB tam SHA-256, >128 KiB ilk+son 64 KiB örnek hash) ile aday azaltma
    4. Tam SHA-256 doğrulaması ve TOCTOU dosya değişikliği kontrolü
    5. Metadata doğrulamalı hash önbelleği (.scanner_cache.json veya SQLite)
    6. JSON, Markdown ve HTML raporlarının üretimi
    """
    start_time = time.time()
    out_dir = Path(out_dir).resolve() if out_dir else Path(__file__).parent.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    target_drives = [normalize_target_path(d) for d in (target_drives or TARGET_DRIVES)]
    if num_workers is None:
        num_workers = min(16, max(2, (os.cpu_count() or 4) * 2))

    def _log(msg="", end="\n"):
        if not quiet:
            print(msg, end=end, flush=True)

    _log(f"[1/4] Seçilen dizin/sürücü paralel taranıyor ({num_workers} iş parçacığı): {', '.join(target_drives)}...")

    # size_to_files[sz] -> list of (filepath, stage1_mtime_ns)
    size_to_files = defaultdict(list)
    total_files = 0
    total_bytes = 0
    zero_files = []
    scanned_valid_drives = []

    permission_errors_count = 0
    symlinks_skipped_count = 0
    excluded_skipped_count = 0
    hash_read_errors_count = 0
    modified_during_scan_count = 0
    skipped_drives_count = 0

    for drive in target_drives:
        try:
            if not os.path.exists(drive):
                skipped_drives_count += 1
                _log(f"Uyarı: {drive} bulunamadı veya takılı değil, atlanıyor.")
                continue
            os.scandir(drive).close()
        except (PermissionError, OSError) as e:
            permission_errors_count += 1
            skipped_drives_count += 1
            _log(f"Uyarı: {drive} sürücüsüne erişilemedi ({e}), atlanıyor.")
            continue

        scanned_valid_drives.append(drive)
        _log(f"  -> {drive} taranıyor...")
        t_d = time.time()
        subdirs, root_files, r_perm, r_sym, r_excl = discover_drive_branches(drive)
        permission_errors_count += r_perm
        symlinks_skipped_count += r_sym
        excluded_skipped_count += r_excl
        _log(f"     Keşfedilen ana dal: {len(subdirs)} klasör, {len(root_files)} kök dosya")

        for p, sz, mtime_ns in root_files:
            total_files += 1
            total_bytes += sz
            if sz == 0:
                zero_files.append(p)
            else:
                size_to_files[sz].append((p, mtime_ns))

        if subdirs:
            with ThreadPoolExecutor(max_workers=num_workers) as executor:
                future_to_dir = {executor.submit(scan_subtree, d): d for d in subdirs}
                done_branches = 0
                for future in as_completed(future_to_dir):
                    branch_dir = future_to_dir[future]
                    done_branches += 1
                    try:
                        (
                            b_sizes,
                            b_zero,
                            b_count,
                            b_bytes,
                            b_perm,
                            b_sym,
                            b_excl,
                        ) = future.result()
                        total_files += b_count
                        total_bytes += b_bytes
                        permission_errors_count += b_perm
                        symlinks_skipped_count += b_sym
                        excluded_skipped_count += b_excl
                        zero_files.extend(b_zero)
                        for sz, path_mtime_list in b_sizes.items():
                            size_to_files[sz].extend(path_mtime_list)
                        _log(f"     [{done_branches}/{len(subdirs)}] Dal tamamlandı: {os.path.basename(branch_dir)} ({b_count} dosya)")
                    except Exception as e:
                        permission_errors_count += 1
                        _log(f"     Hata ({branch_dir}): {e}")

        _log(f"  -> {drive} tamamlandı: ({time.time()-t_d:.2f}s)")

    if scanned_valid_drives:
        target_drives = scanned_valid_drives

    _log(f"Toplam taranan gerçek dosya: {total_files:,} ({format_size(total_bytes)})")

    # Aşama 2: Aynı boyutta en az 2 dosya olan adayları filtrele
    candidates = {s: items for s, items in size_to_files.items() if len(items) > 1}
    cand_count = sum(len(items) for items in candidates.values())
    _log(f"[2/4] Aynı boyutta {cand_count:,} adet potansiyel kopya dosya bulundu ({len(candidates):,} farklı boyut grubu).")

    # Önbellek başlat (JSON varsayılan, SQLite opsiyonel)
    if cache_backend == "sqlite":
        resolved_cache_path = Path(cache_path) if cache_path else (out_dir / ".scanner_cache.sqlite")
        cache = SqliteHashCache(resolved_cache_path)
    else:
        resolved_cache_path = Path(cache_path) if cache_path else (out_dir / ".scanner_cache.json")
        cache = JsonHashCache(resolved_cache_path)

    loaded_cache_count = cache.load()
    if loaded_cache_count > 0:
        _log(f"  Önbellekten {loaded_cache_count:,} doğrulanmış tam SHA-256 kaydı yüklendi.")
    elif cache.was_reset:
        _log(f"  Uyarı: Eski veya bozuk önbellek sıfırlandı ({cache.reset_reason}).")

    # full_hash_groups[(sz, full_sha256)] -> list of (filepath, FileStatSnapshot)
    full_hash_groups = defaultdict(list)

    # Sıfır baytlık dosyalar: Varsayılan olarak ayrı izlenir, istenirse (--include-zero-byte) kopya grubuna dahil edilir
    if include_zero_byte_duplicates and len(zero_files) > 1:
        empty_sha256 = hashlib.sha256(b"").hexdigest()
        for zp in zero_files:
            z_stat = capture_file_stat(zp)
            if z_stat is not None and z_stat.size == 0:
                full_hash_groups[(0, empty_sha256)].append((zp, z_stat))
            elif z_stat is not None and z_stat.size != 0:
                modified_during_scan_count += 1
            else:
                hash_read_errors_count += 1

    if cand_count == 0:
        _log("Mükerrer dosya adayı bulunamadı, temiz rapor oluşturuluyor...")
    else:
        # Aşama 3: Hızlı örnek hash ön elemesi (Baş 64 KiB + Son 64 KiB veya <=128 KiB için Tam SHA-256)
        _log("[3/4] Ön eleme hash kontrolü (Baş + Son 64KB) paralel yürütülüyor...")
        all_cand_items = [(p, sz, st1_mtime) for sz, items in candidates.items() for (p, st1_mtime) in items]
        # Gruplama anahtarı (sz, hash_kind, digest) olarak tutulur; örnek hash ile tam hash asla karışmaz
        edge_hash_groups = defaultdict(list)
        processed_edges = 0
        total_edges = len(all_cand_items)
        t_edge_start = time.time()
        last_edge_print = t_edge_start
        max_pending = max(16, num_workers * 4)

        def _calc_edge(item):
            p, sz, st1_mtime = item
            qres = get_quick_sample_hash_detailed(p, sz, max_retries=max_retries)
            # Aşama 1 (boyut keşfi) ile Aşama 3 (örnek hash) arasında dosyanın mtime_ns değerinin değişmediğini doğrula
            if qres.status == "OK" and qres.stat_snapshot is not None and st1_mtime is not None:
                if qres.stat_snapshot.mtime_ns != st1_mtime:
                    qres = QuickHashResult(None, None, None, "MODIFIED", "mtime_changed_since_stage1")
            return p, sz, qres

        with ThreadPoolExecutor(max_workers=num_workers) as executor:
            for p, sz, qres in _run_bounded_pool(executor, _calc_edge, all_cand_items, max_pending=max_pending):
                processed_edges += 1
                if qres.status == "OK" and qres.digest:
                    edge_hash_groups[(sz, qres.kind, qres.digest)].append((p, qres.stat_snapshot))
                elif qres.status == "MODIFIED":
                    modified_during_scan_count += 1
                else:
                    hash_read_errors_count += 1

                now = time.time()
                if now - last_edge_print >= 1.0 or processed_edges == total_edges:
                    pct = (processed_edges / total_edges) * 100
                    elapsed_edge = max(now - t_edge_start, 1e-6)
                    speed = processed_edges / elapsed_edge
                    eta = (total_edges - processed_edges) / speed if speed > 0 else 0
                    _log(
                        f"\r  Ön Eleme Hash: %{pct:.1f} ({processed_edges:,}/{total_edges:,}) | Hız: {int(speed):,} dosya/sn | Kalan: ~{int(eta)}sn   ",
                        end="",
                    )
                    last_edge_print = now
        _log()

        potential_full = {k: items for k, items in edge_hash_groups.items() if len(items) > 1}
        full_count = sum(len(items) for items in potential_full.values())
        _log(f"[4/4] Birebir eşleşen {full_count:,} aday dosya için tam SHA-256 doğrulaması yapılıyor...")

        files_to_hash = []
        processed = 0

        for (sz, hash_kind, edge_digest), item_list in potential_full.items():
            if hash_kind == HASH_KIND_FULL and sz <= SMALL_FILE_FULL_HASH_THRESHOLD:
                # 128 KiB ve altındaki dosyaların tamamı okundu ve doğrulandı.
                # Ancak Aşama 3 ile Aşama 4 arasında dosyanın değişmediğini tekrar kontrol et:
                for p, stage3_stat in item_list:
                    now_stat = capture_file_stat(p)
                    if verify_stat_unchanged(stage3_stat, now_stat, expected_size=sz):
                        processed += 1
                        full_hash_groups[(sz, edge_digest)].append((p, now_stat))
                        cache.put_verified_sha256(p, now_stat, edge_digest, sample_hash=edge_digest)
                    else:
                        # Aşama 3 sonrasında dosya değişmiş; yeniden tam doğrulamaya sok
                        files_to_hash.append((p, sz, None))
                continue

            # > 128 KiB dosyalar: edge_digest yalnızca SAMPLE_EDGE_64K örneğidir, ASLA tam SHA-256 kabul edilmez!
            for p, stage3_stat in item_list:
                now_stat = capture_file_stat(p)
                if not verify_stat_unchanged(stage3_stat, now_stat, expected_size=sz):
                    # Ön eleme ile tam doğrulama arasında değişen dosya
                    files_to_hash.append((p, sz, edge_digest))
                    continue

                cached_sha256 = cache.get_valid_sha256(p, now_stat, sample_hash=edge_digest)
                if cached_sha256:
                    processed += 1
                    full_hash_groups[(sz, cached_sha256)].append((p, now_stat))
                else:
                    files_to_hash.append((p, sz, edge_digest))

        t_hash_start = time.time()
        last_hash_print = t_hash_start
        total_to_hash = len(files_to_hash)

        def _calc_full(item):
            p, sz, sample_h = item
            fres = get_full_hash_detailed(
                p,
                expected_size=sz,
                block_size=FULL_HASH_BLOCK_SIZE,
                max_retries=max_retries,
                on_chunk_read=on_chunk_read,
            )
            return p, sz, sample_h, fres

        if files_to_hash:
            _log(f"  {total_to_hash:,} dosya için çok iş parçacıklı tam SHA-256 hesaplanıyor...")
            newly_hashed = 0
            with ThreadPoolExecutor(max_workers=num_workers) as executor:
                for p, sz, sample_h, fres in _run_bounded_pool(executor, _calc_full, files_to_hash, max_pending=max_pending):
                    processed += 1
                    newly_hashed += 1
                    if fres.retried:
                        modified_during_scan_count += 1
                    if fres.status == "OK" and fres.digest:
                        full_hash_groups[(sz, fres.digest)].append((p, fres.stat_snapshot))
                        cache.put_verified_sha256(p, fres.stat_snapshot, fres.digest, sample_hash=sample_h)
                    elif fres.status == "MODIFIED":
                        if not fres.retried:
                            modified_during_scan_count += 1
                    else:
                        hash_read_errors_count += 1

                    now = time.time()
                    if now - last_hash_print >= 1.0 or processed == full_count:
                        pct = (processed / full_count) * 100 if full_count else 100.0
                        elapsed_hash = max(now - t_hash_start, 1e-6)
                        speed = newly_hashed / elapsed_hash
                        eta = (full_count - processed) / speed if speed > 0 else 0
                        _log(
                            f"\r  Tam Doğrulama: %{pct:.1f} ({processed:,}/{full_count:,}) | Hız: {int(speed):,} dosya/sn | Kalan: ~{int(eta)}sn   ",
                            end="",
                        )
                        last_hash_print = now
            _log()

        _log(f"Hash doğrulama tamamlandı ({time.time() - t_hash_start:.2f}s)")

    # Eski/silinmiş önbellek kayıtlarını kontrollü temizle ve atomik kaydet
    pruned_count = cache.prune_stale_entries(scanned_roots=target_drives)
    cache.save_atomic()
    if hasattr(cache, "close"):
        cache.close()

    # Aşama 6: Kopya gruplarını ve kurtarılabilir alanı (teorik vs fiziksel/hardlink) hesapla
    duplicates = []
    total_wasted = 0
    total_physical_wasted = 0
    hardlink_groups_count = 0
    group_idx = 1

    for (sz, fh), path_stat_list in full_hash_groups.items():
        # Aynı dosya yolunun mükerrer eklenmesini önle
        dedup_by_norm = {}
        for p, st_snap in path_stat_list:
            nk = normalize_cache_key(p)
            if nk not in dedup_by_norm:
                dedup_by_norm[nk] = (p, st_snap)

        if len(dedup_by_norm) > 1:
            items = list(dedup_by_norm.values())
            count = len(items)
            wasted = sz * (count - 1)
            total_wasted += wasted

            # Hardlink / inode analizi: Aynı (dev, ino) değerini paylaşan dosyalar fiziksel olarak tek yer kaplar
            unique_physical_keys = set()
            unknown_ino_idx = 0
            file_entries = []
            drives = set()

            for p, st_snap in items:
                drv = extract_drive_label(p)
                drives.add(drv)
                if st_snap is None:
                    st_snap = capture_file_stat(p)
                if st_snap and st_snap.ino != 0:
                    unique_physical_keys.add((st_snap.dev, st_snap.ino))
                else:
                    unknown_ino_idx += 1
                    unique_physical_keys.add(("no_ino", unknown_ino_idx))

                try:
                    mtime_sec = (st_snap.mtime_ns / 1e9) if st_snap else os.path.getmtime(p)
                    mtime_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime_sec))
                except Exception:
                    mtime_str = "-"

                file_entries.append({
                    "path": p,
                    "filename": os.path.basename(p),
                    "directory": os.path.dirname(p),
                    "drive": drv,
                    "modified": mtime_str,
                    "extension": os.path.splitext(p)[1].lower() or "uzantısız",
                })

            unique_physical_count = len(unique_physical_keys)
            has_hardlinks = unique_physical_count < count
            if has_hardlinks:
                hardlink_groups_count += 1
            physical_wasted = sz * max(0, unique_physical_count - 1)
            total_physical_wasted += physical_wasted

            file_entries.sort(key=lambda x: x["path"])
            duplicates.append({
                "group_id": group_idx,
                "hash": fh,
                "hash_algorithm": CACHE_HASH_ALGORITHM,
                "size_bytes": sz,
                "size_formatted": format_size(sz),
                "count": count,
                "wasted_bytes": wasted,
                "wasted_formatted": format_size(wasted),
                "physical_wasted_bytes": physical_wasted,
                "physical_wasted_formatted": format_size(physical_wasted),
                "unique_physical_copies": unique_physical_count,
                "has_hardlinks": has_hardlinks,
                "is_cross_drive": len(drives) > 1,
                "drives": sorted(list(drives)),
                "files": file_entries,
            })
            group_idx += 1

    # Boşa harcanan alana göre azalan sırala ve group_id'leri sıralamaya göre yeniden numaralandır
    duplicates.sort(key=lambda x: x["wasted_bytes"], reverse=True)
    for idx, g in enumerate(duplicates, 1):
        g["group_id"] = idx

    elapsed = round(time.time() - start_time, 2)
    cross_groups = [g for g in duplicates if g["is_cross_drive"]]
    only_d = [g for g in duplicates if g["drives"] == ["D:"]]
    only_e = [g for g in duplicates if g["drives"] == ["E:"]]
    large_groups = [g for g in duplicates if g["size_bytes"] >= 10 * 1024 * 1024]
    drives_title = format_drives_title(target_drives)
    report_title = f"{drives_title} Kopya Dosya Raporu"

    is_complete_scan = (
        permission_errors_count == 0
        and hash_read_errors_count == 0
        and modified_during_scan_count == 0
        and skipped_drives_count == 0
    )
    scan_status = "COMPLETE" if is_complete_scan else "PARTIAL_WITH_ERRORS"

    summary = {
        "report_title": report_title,
        "drives_title": drives_title,
        "scan_date": time.strftime("%Y-%m-%d %H:%M:%S"),
        "elapsed_seconds": elapsed,
        "scan_status": scan_status,
        "is_complete_scan": is_complete_scan,
        "scanned_drives": target_drives,
        "skipped_drives_count": skipped_drives_count,
        "total_files_scanned": total_files,
        "total_bytes_scanned": total_bytes,
        "total_size_scanned_formatted": format_size(total_bytes),
        "zero_byte_files_count": len(zero_files),
        "zero_byte_policy": "included_in_duplicates" if include_zero_byte_duplicates else "tracked_separately_0B_waste",
        "zero_byte_files_sample": zero_files[:100],
        "duplicate_groups_count": len(duplicates),
        "duplicate_files_count": sum(g["count"] for g in duplicates),
        "total_wasted_bytes": total_wasted,
        "total_wasted_formatted": format_size(total_wasted),
        "total_physical_wasted_bytes": total_physical_wasted,
        "total_physical_wasted_formatted": format_size(total_physical_wasted),
        "hardlink_groups_count": hardlink_groups_count,
        "cross_drive_groups_count": len(cross_groups),
        "cross_drive_wasted_formatted": format_size(sum(g["wasted_bytes"] for g in cross_groups)),
        "only_d_groups_count": len(only_d),
        "only_e_groups_count": len(only_e),
        "large_groups_count": len(large_groups),
        "permission_errors_count": permission_errors_count,
        "hash_read_errors_count": hash_read_errors_count,
        "modified_during_scan_count": modified_during_scan_count,
        "symlinks_skipped_count": symlinks_skipped_count,
        "excluded_skipped_count": excluded_skipped_count,
        "cache_backend": cache_backend,
        "cache_hits_count": cache.hits,
        "cache_misses_count": cache.misses,
        "cache_invalidations_count": cache.invalidations,
        "cache_pruned_count": pruned_count,
        "cache_was_reset": cache.was_reset,
    }

    if write_reports:
        json_path = out_dir / "duplicate_report.json"
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump({"summary": summary, "duplicates": duplicates}, f, ensure_ascii=False, indent=2)
        _log(f"✓ JSON rapor kaydedildi: {json_path}")

        md_path = out_dir / "duplicate_report.md"
        generate_md(summary, duplicates, md_path)
        _log(f"✓ Markdown rapor kaydedildi: {md_path}")

        report_dir = out_dir / "rapor_kopya"
        html_path = out_dir / "duplicate_report.html"
        generate_report_bundle(summary, duplicates, report_dir, html_path)
        _log(f"✓ Hızlı & Lazy-Loaded Rapor Klasörü oluşturuldu: {report_dir / 'index.html'}")
        _log(f"✓ HTML rapor yönlendirmesi kaydedildi: {html_path}")

        _log(f"\nİşlem Başarıyla Tamamlandı! Toplam Süre: {elapsed} sn | Durum: {scan_status}")
        _log(f"Bulunan Kopya Grup Sayısı: {len(duplicates)} adet")
        _log(f"Teorik Kurtarılabilir Alan (İsraf): {format_size(total_wasted)}")
        if total_physical_wasted != total_wasted:
            _log(f"Fiziksel Kurtarılabilir Alan (Hardlink Hariç): {format_size(total_physical_wasted)}")

    return {"summary": summary, "duplicates": duplicates, "zero_byte_files": zero_files}


def main():
    cli_paths = []
    cache_backend = "json"
    num_workers = None
    include_zero_byte = False
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--kaynak", "--dizin", "--hedef", "-d", "-p") and i + 1 < len(args):
            cli_paths.append(normalize_target_path(args[i + 1]))
            i += 2
            continue
        elif arg == "--sqlite-cache":
            cache_backend = "sqlite"
            i += 1
            continue
        elif arg in ("--include-zero-byte", "--sifir-bayt-dahil"):
            include_zero_byte = True
            i += 1
            continue
        elif arg in ("--workers", "-w") and i + 1 < len(args):
            try:
                num_workers = max(1, int(args[i + 1]))
            except ValueError:
                pass
            i += 2
            continue
        elif not arg.startswith("-"):
            cli_paths.append(normalize_target_path(arg))
        i += 1

    target_drives = cli_paths if cli_paths else TARGET_DRIVES
    scan_directories(
        target_drives=target_drives,
        cache_backend=cache_backend,
        num_workers=num_workers,
        include_zero_byte_duplicates=include_zero_byte,
        write_reports=True,
    )

def generate_md(s, duplicates, md_path):
    report_title = s.get("report_title", "Kopya Dosya Analiz Raporu")
    status_label = "✅ Tam Tarama (Eksiksiz)" if s.get("is_complete_scan", True) else "⚠️ Kısmi Tarama (Erişim/Doğrulama Uyarıları Mevcut)"
    lines = [
        f"# {report_title}\n",
        f"- **Tarama Durumu:** {status_label}",
        f"- **Tarama Tarihi:** {s['scan_date']}",
        f"- **Tarama Süresi:** {s['elapsed_seconds']} saniye",
        f"- **Taranan Dizinler:** {', '.join(s.get('scanned_drives', []))}",
        f"- **Taranan Toplam Dosya:** {s['total_files_scanned']:,} dosya ({s['total_size_scanned_formatted']})",
        f"- **Sıfır Baytlık (Boş) Dosyalar:** {s.get('zero_byte_files_count', 0)} adet *(Politika: {s.get('zero_byte_policy', 'tracked_separately_0B_waste')})*",
        f"- **Toplam Kopya Dosya Grubu:** {s['duplicate_groups_count']}",
        f"- **Toplam Kopya Dosya Sayısı:** {s['duplicate_files_count']}",
        f"- **Teorik Kurtarılabilir Toplam Alan (İsraf):** **{s['total_wasted_formatted']}**",
    ]
    if "total_physical_wasted_formatted" in s and s.get("total_physical_wasted_bytes") != s.get("total_wasted_bytes"):
        lines.append(f"- **Fiziksel Açılabilir Tahmini Alan (Hardlink Hariç):** **{s['total_physical_wasted_formatted']}**")
    if not s.get("is_complete_scan", True):
        lines.append(
            f"- **⚠️ Eksik / Doğrulanamayan Öğeler:** Erişim hatası: {s.get('permission_errors_count', 0)}, "
            f"Hash okuma hatası: {s.get('hash_read_errors_count', 0)}, "
            f"Tarama sırasında değiştiği için dışlanan: {s.get('modified_during_scan_count', 0)}, "
            f"Erişilemeyen sürücü/kök: {s.get('skipped_drives_count', 0)}"
        )
    if s.get("cross_drive_groups_count", 0) > 0:
        lines.append(f"- **Çapraz Disk Kopyaları:** {s['cross_drive_groups_count']} grup ({s['cross_drive_wasted_formatted']})")

    all_drives = sorted(list(set(d for g in duplicates for d in g.get("drives", []))))
    for drv in all_drives:
        cnt = len([g for g in duplicates if g.get("drives") == [drv]])
        lines.append(f"- **Yalnızca {drv} Diskinde Bulunan Kopyalar:** {cnt} grup")
    lines.append("")
    lines.append("> **Not:** Hesaplanan kurtarılabilir alan teorik (`(N - 1) × boyut`) değerdir; hard link'ler, sıkıştırma ve dosya sistemi ayırma birimleri nedeniyle fiziksel açılacak alan farklılık gösterebilir.\n")
    lines.append("## 🏆 En Fazla Alan İsrafına Neden Olan İlk 20 Kopya\n")
    lines.append("| No | Dosya Adı | Tekil Boyut | Kopya Sayısı | Teorik Boşa Harcanan Alan | Diskler | SHA-256 (Kısa) |")
    lines.append("| :--- | :--- | :--- | :--- | :--- | :--- | :--- |")
    for idx, g in enumerate(duplicates[:20], 1):
        name = g["files"][0]["filename"]
        drives = ", ".join(g["drives"])
        hash_short = g["hash"][:12] + "..."
        lines.append(f"| {idx} | `{name}` | {g['size_formatted']} | {g['count']} | **{g['wasted_formatted']}** | {drives} | `{hash_short}` |")

    lines.append("\n## 📂 Detaylı Kopya Dosya Yolları (İlk 30 Grup)\n")
    for idx, g in enumerate(duplicates[:30], 1):
        name = g["files"][0]["filename"]
        lines.append(f"### {idx}. `{name}` — {g['size_formatted']} × {g['count']} adet (**{g['wasted_formatted']} teorik israf**)")
        lines.append(f"> SHA-256: `{g['hash']}`\n")
        for f in g["files"]:
            lines.append(f"- `[{f['drive']}]` `{f['path']}` *(Tarih: {f['modified']})*")
        lines.append("")

    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

def generate_report_bundle(s, duplicates, report_dir, html_path):
    report_dir = Path(report_dir)
    report_dir.mkdir(parents=True, exist_ok=True)
    
    # 1. Write Data.js (Instant offline file:/// loading without CORS)
    dups_json = json.dumps(duplicates, ensure_ascii=False)
    summary_json = json.dumps(s, ensure_ascii=False)
    data_js_content = f"window.SUMMARY_DATA = {summary_json};\nwindow.DUPLICATE_DATA = {dups_json};\n"
    with open(report_dir / "data.js", "w", encoding="utf-8") as f:
        f.write(data_js_content)
    
    # 2. Copy style.css and app.js from templates/kopya_raporu/
    tpl_dir = Path(__file__).parent / "templates" / "kopya_raporu"
    css_src = tpl_dir / "style.css"
    js_src = tpl_dir / "app.js"
    
    if css_src.exists():
        with open(css_src, "r", encoding="utf-8") as f_in, open(report_dir / "style.css", "w", encoding="utf-8") as f_out:
            f_out.write(f_in.read())
    if js_src.exists():
        with open(js_src, "r", encoding="utf-8") as f_in, open(report_dir / "app.js", "w", encoding="utf-8") as f_out:
            f_out.write(f_in.read())

    # 3. Dynamic Filters for HTML
    all_drives = sorted(list(set(d for g in duplicates for d in g.get("drives", []))))
    filter_btns = []
    if s.get("cross_drive_groups_count", 0) > 0:
        cross_lbl = "Hem D hem E" if set(all_drives) == {"D:", "E:"} else "Çapraz Diskler"
        filter_btns.append(f'<button class="filter-btn" data-filter="cross">{cross_lbl} ({s["cross_drive_groups_count"]})</button>')
    for drv in all_drives:
        cnt = len([g for g in duplicates if g.get("drives") == [drv]])
        drv_key = drv.replace(":", "").lower()
        filter_btns.append(f'<button class="filter-btn" data-filter="{drv_key}">Sadece {drv} ({cnt})</button>')
    dynamic_filters_html = "\n        ".join(filter_btns)

    report_title = s.get("report_title", "Kopya Dosya Analiz Raporu")
    is_complete = s.get("is_complete_scan", True)
    status_badge_html = (
        '<span style="color:#4ade80; font-weight:600;">✓ Tam Tarama</span>'
        if is_complete
        else '<span style="color:#fbbf24; font-weight:700;">⚠️ Kısmi Tarama (Uyarılar Var)</span>'
    )
    partial_warning_html = ""
    if not is_complete:
        partial_warning_html = f"""
    <div style="background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.4); color:#fde68a; padding:1rem 1.25rem; border-radius:12px; margin-bottom:1.5rem; font-size:0.9rem;">
      <strong>⚠️ Kısmi / Eksik Tarama Uyarısı:</strong> Tarama sırasında bazı öğelere erişilemedi veya dosyalar değiştiği için doğrulama dışı bırakıldı
      (Erişim hatası: <strong>{s.get('permission_errors_count', 0)}</strong> |
      Hash okuma hatası: <strong>{s.get('hash_read_errors_count', 0)}</strong> |
      Tarama sırasında değişen: <strong>{s.get('modified_during_scan_count', 0)}</strong> |
      Atlanan kök/sürücü: <strong>{s.get('skipped_drives_count', 0)}</strong>).
      Rapor yalnızca tam SHA-256 doğrulamasından geçen dosyaları içerir.
    </div>"""

    # 4. Generate clean, lightweight index.html (<15KB)
    index_html = f"""<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{report_title} | Arşiv 360</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="toast" id="toast">✓ İşlem tamamlandı!</div>

  <div class="container">
    <header>
      <div class="header-left">
        <h1>{report_title}</h1>
        <p>SHA-256 Hash Bütünlüğü ile Doğrulanmış Mükerrer Dosya ve Alan Kurtarma Analizi</p>
      </div>
      <div class="header-badge">
        {status_badge_html} • <span>🕒 {s['scan_date']}</span> • <span>⚡ {s['elapsed_seconds']} sn</span>
      </div>
    </header>
{partial_warning_html}
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-title">Teorik Kurtarılabilir Alan (İsraf)</div>
        <div class="stat-value highlight-danger">{s['total_wasted_formatted']}</div>
        <div class="stat-sub">Teorik (N-1) kazanım (hardlink/FS hariç: {s.get('total_physical_wasted_formatted', s['total_wasted_formatted'])})</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Kopya Dosya Grubu</div>
        <div class="stat-value highlight-accent">{s['duplicate_groups_count']}</div>
        <div class="stat-sub">Toplam {s['duplicate_files_count']} mükerrer dosya</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Çapraz / Farklı Disk Kopyaları</div>
        <div class="stat-value highlight-warning">{s['cross_drive_groups_count']} grup</div>
        <div class="stat-sub">{s['cross_drive_wasted_formatted']} ortak alan israfı</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Taranan Toplam Boyut</div>
        <div class="stat-value highlight-success">{s['total_size_scanned_formatted']}</div>
        <div class="stat-sub">{s['total_files_scanned']:,} dosya ({s.get('zero_byte_files_count', 0)} boş dosya)</div>
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
          <strong>💾 2. Çapraz Disk Senkronizasyonu</strong>
          <p>Yedek disklerdeki mükerrer kopyalarda her iki diskte de değişiklik yapıyorsanız en güncel olanı tutup diğerini güvenli karantinaya alabilirsiniz.</p>
        </div>
        <div class="advice-item">
          <strong>🛡️ 3. Güvenli Silme (Karantina Klasörü)</strong>
          <p>Dosyaları kalıcı olarak silmeden önce bir <code>_SILINECEK_KOPYALAR</code> klasörüne taşımak veri kaybı riskini tamamen ortadan kaldırır.</p>
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
        <button class="batch-btn" id="btnViewToggle" onclick="toggleViewMode()" title="Klasör ağacı ile tam liste arasında geçiş yap">
          🌳 Ağaç Görünümü (Aktif)
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
        <span class="filter-match-count" id="filterMatchCount">{s['duplicate_groups_count']} grup</span>
        <button class="filter-btn active" data-filter="all">Tümü ({s['duplicate_groups_count']})</button>
        {dynamic_filters_html}
        <button class="filter-btn" data-filter="large">Büyükler (>10MB) ({s['large_groups_count']})</button>
      </div>
    </div>

    <!-- LİSTE (LAZY LOADED) -->
    <div class="groups-list" id="groupsList"></div>

    <!-- LAZY LOADING TETİKLEYİCİSİ & LOAD MORE -->
    <div class="load-more-wrap">
      <div id="sentinel">
        <div class="sentinel-spinner"></div>
      </div>
      <p id="renderedCountText" style="color:var(--text-muted); font-size:0.85rem; margin-bottom:0.75rem;"></p>
      <button class="btn-load-more" id="loadMoreBtn" style="display:none;">Daha Fazla Göster</button>
    </div>

    <div class="footer">
      <p>Bu rapor Arşiv 360 tarafından SHA-256 hash doğrulaması ve Lazy Loading mimarisi ile üretilmiştir.</p>
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

  <script src="data.js"></script>
  <script src="app.js"></script>
</body>
</html>
"""
    with open(report_dir / "index.html", "w", encoding="utf-8") as f:
        f.write(index_html)

    # 5. Redirect wrapper in duplicate_report.html
    redirect_html = f"""<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0; url=rapor_kopya/index.html">
  <script>window.location.replace("rapor_kopya/index.html");</script>
  <title>{report_title} | Arşiv 360</title>
</head>
<body style="font-family:'Segoe UI', sans-serif; background:#0b0f19; color:#f3f4f6; padding:3rem; text-align:center;">
  <h2>Arşiv 360 - {report_title}</h2>
  <p>Yüksek performanslı ve Lazy-Loaded rapor klasörüne yönlendiriliyorsunuz...</p>
  <p><a href="rapor_kopya/index.html" style="color:#818cf8; text-decoration:underline;">Açılmazsa buraya tıklayın (rapor_kopya/index.html)</a></p>
</body>
</html>
"""
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(redirect_html)

def generate_html(s, duplicates, html_path):
    report_dir = Path(html_path).parent / "rapor_kopya"
    generate_report_bundle(s, duplicates, report_dir, html_path)


if __name__ == "__main__":
    main()
