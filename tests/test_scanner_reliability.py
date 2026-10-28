import os
import sys
import json
import time
import shutil
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent))

import scanner


class TestScannerReliability(unittest.TestCase):
    """
    Arşiv 360 — Kopya Dosya Tarayıcısı Güvenilirlik ve Performans Test Paketi.
    Tüm testler izole geçici dizinlerde (tempfile.TemporaryDirectory) çalışır;
    gerçek kullanıcı dosyalarına kesinlikle dokunmaz.
    """

    def setUp(self):
        self.tmp_ctx = tempfile.TemporaryDirectory(prefix="arsiv360_test_")
        self.root = Path(self.tmp_ctx.name)
        self.scan_dir = self.root / "workspace"
        self.out_dir = self.root / "reports"
        self.scan_dir.mkdir(parents=True, exist_ok=True)
        self.out_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self.tmp_ctx.cleanup()

    def _write_bytes(self, rel_path: str, data: bytes) -> Path:
        p = self.scan_dir / rel_path
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)
        return p

    # 1. İçerikleri ve boyutları aynı iki dosya
    def test_01_identical_size_and_content(self):
        payload = b"Arsiv360-Tam-Kopya-Icerigi-" * 8000  # ~216 KB (> 128 KiB)
        f1 = self._write_bytes("klasor_a/rapor1.bin", payload)
        f2 = self._write_bytes("klasor_b/rapor2.bin", payload)

        res = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertEqual(res["summary"]["duplicate_groups_count"], 1)
        grp = res["duplicates"][0]
        self.assertEqual(grp["count"], 2)
        self.assertEqual(grp["size_bytes"], len(payload))
        self.assertEqual(grp["wasted_bytes"], len(payload))
        self.assertEqual(grp["hash"], hashlib.sha256(payload).hexdigest())
        found_paths = {os.path.abspath(f["path"]) for f in grp["files"]}
        self.assertEqual(found_paths, {os.path.abspath(str(f1)), os.path.abspath(str(f2))})

    # 2. Boyutları aynı fakat içerikleri farklı iki dosya
    def test_02_same_size_different_content(self):
        size = 200 * 1024
        self._write_bytes("a.bin", b"A" * size)
        self._write_bytes("b.bin", b"B" * size)

        res = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertEqual(res["summary"]["duplicate_groups_count"], 0)
        self.assertEqual(len(res["duplicates"]), 0)

    # 3. İlk ve son 64 KiB'ı aynı, ortası farklı büyük dosyalar
    def test_03_same_head_and_tail_64k_different_middle(self):
        head = b"H" * 65536
        tail = b"T" * 65536
        mid_a = b"M_BIRINCI_DOSYA_" * 4096  # 64 KiB
        mid_b = b"M_IKINCI__DOSYA_" * 4096  # 64 KiB (aynı uzunluk, farklı orta blok)

        f1 = self._write_bytes("video_v1.mp4", head + mid_a + tail)
        f2 = self._write_bytes("video_v2.mp4", head + mid_b + tail)

        # Ön eleme örnek hash'leri aynı olmalı ve SAMPLE_EDGE_64K olarak etiketlenmeli
        q1 = scanner.get_quick_sample_hash_detailed(str(f1), f1.stat().st_size)
        q2 = scanner.get_quick_sample_hash_detailed(str(f2), f2.stat().st_size)
        self.assertEqual(q1.kind, scanner.HASH_KIND_SAMPLE)
        self.assertEqual(q2.kind, scanner.HASH_KIND_SAMPLE)
        self.assertEqual(q1.digest, q2.digest)

        # Ancak tam SHA-256 doğrulaması bunların kopya OLMADIĞINI tespit etmeli
        res = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertEqual(res["summary"]["duplicate_groups_count"], 0)
        self.assertEqual(res["summary"]["total_wasted_bytes"], 0)

    # 4. Tam hash'i aynı olan küçük dosyalar (<= 128 KiB: gereksiz yeniden okuma yapılmamalı)
    def test_04_small_files_full_hash_without_redundant_reread(self):
        small_payload = b"Kucuk-Dosya-Tam-SHA256-Testi\n" * 1024  # ~29 KB <= 128 KiB
        f1 = self._write_bytes("kucuk1.txt", small_payload)
        f2 = self._write_bytes("kucuk2.txt", small_payload)

        q1 = scanner.get_quick_sample_hash_detailed(str(f1), len(small_payload))
        self.assertEqual(q1.kind, scanner.HASH_KIND_FULL)
        self.assertEqual(q1.digest, hashlib.sha256(small_payload).hexdigest())

        with mock.patch("scanner.get_full_hash_detailed", wraps=scanner.get_full_hash_detailed) as spy_full:
            res = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
            # Değişmeyen <=128 KiB dosyalar Aşama 3'te zaten tam okunduğu için Aşama 4'te tekrar okunmamalı
            self.assertEqual(spy_full.call_count, 0)

        self.assertEqual(res["summary"]["duplicate_groups_count"], 1)
        self.assertEqual(res["duplicates"][0]["hash"], hashlib.sha256(small_payload).hexdigest())

    # 5. Önceden hash'i önbelleğe alınmış ve daha sonra içeriği değiştirilen dosya
    def test_05_cached_file_modified_later(self):
        payload_orig = b"Orijinal-Buyuk-Blok-" * 10000  # ~200 KB
        f1 = self._write_bytes("belge_a.dat", payload_orig)
        f2 = self._write_bytes("belge_b.dat", payload_orig)

        # 1. Tarama: Önbelleğe yazılır
        res1 = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertEqual(res1["summary"]["duplicate_groups_count"], 1)

        # f2 dosyasının içeriğini ve boyutunu değiştir
        f2.write_bytes(payload_orig + b"-EK-VERI")

        # 2. Tarama: Eski önbellek geçersiz sayılmalı, kopya çıkmamalı
        res2 = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertEqual(res2["summary"]["duplicate_groups_count"], 0)

    # 6. Aynı boyutta değiştirilmiş dosya (önbellek + zaman damgası / sample hash kontrolü)
    def test_06_cached_file_modified_with_same_size(self):
        payload_1 = b"A" * 65536 + b"X" * 65536 + b"Z" * 65536  # 192 KiB
        payload_2 = b"A" * 65536 + b"Y" * 65536 + b"Z" * 65536  # 192 KiB (aynı boyut, aynı baş/son 64K, farklı orta!)

        f1 = self._write_bytes("ortak1.bin", payload_1)
        f2 = self._write_bytes("ortak2.bin", payload_1)

        # 1. Tarama: İkisi de önbelleğe alınır
        res1 = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertEqual(res1["summary"]["duplicate_groups_count"], 1)

        # f2 dosyasını aynı boyutta farklı orta içerikle değiştir
        time.sleep(0.02)
        f2.write_bytes(payload_2)

        # 2. Tarama: Önbellek f2'nin değiştiğini yakalamalı ve f1 ile f2'yi kopya saymamalı
        res2 = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertEqual(res2["summary"]["duplicate_groups_count"], 0)
        self.assertGreaterEqual(res2["summary"]["cache_invalidations_count"], 1)

    # 7. Silinmiş veya yolu değişmiş dosya
    def test_07_deleted_or_moved_file_cache_pruning(self):
        payload = b"Tasinan-Dosya-Verisi-" * 9000  # ~189 KB
        f1 = self._write_bytes("klasor1/dosya1.bin", payload)
        f2 = self._write_bytes("klasor2/dosya2.bin", payload)

        res1 = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertEqual(res1["summary"]["duplicate_groups_count"], 1)

        # f2'yi sil, f3 olarak başka yola taşı/oluştur ve ardından f3'ü de sil
        f2.unlink()
        res2 = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertEqual(res2["summary"]["duplicate_groups_count"], 0)
        self.assertGreaterEqual(res2["summary"]["cache_pruned_count"], 1)

        # Önbellek dosyasında silinmiş f2 kaydının kalmadığını doğrula
        cache_data = json.loads((self.out_dir / ".scanner_cache.json").read_text(encoding="utf-8"))
        self.assertNotIn(scanner.normalize_cache_key(str(f2)), cache_data["entries"])

    # 8. Hash sırasında değiştirilen dosya
    def test_08_file_modified_during_hashing(self):
        # 2 blokluk (8 MiB üzeri veya özel blok boyutlu) büyük dosya
        payload = b"D" * (200 * 1024)
        f1 = self._write_bytes("sabit.bin", payload)
        f2 = self._write_bytes("degisken.bin", payload)

        # Okuma sırasında f2 dosyasını değiştiren kanca (on_chunk_read)
        def mutate_mid_hash(filepath, chunk_idx, bytes_read):
            if os.path.abspath(filepath) == os.path.abspath(str(f2)) and chunk_idx == 1:
                # Okuma devam ederken dosyayı farklı içerikle değiştir
                with open(f2, "wb") as wf:
                    wf.write(b"E" * (200 * 1024))

        # max_retries=0 ile okuma ortasında değişen dosyanın MODIFIED olarak reddedildiğini doğrula
        fres = scanner.get_full_hash_detailed(
            str(f2),
            expected_size=len(payload),
            block_size=65536,
            max_retries=0,
            on_chunk_read=mutate_mid_hash,
        )
        self.assertEqual(fres.status, "MODIFIED")
        self.assertIsNone(fres.digest)

        # Tam tarama sırasında değiştiğinde sayaca yansıdığını ve yanlış kopya grubu oluşmadığını doğrula
        f2.write_bytes(payload)

        def mutate_in_scan(filepath, chunk_idx, bytes_read):
            if os.path.abspath(filepath) == os.path.abspath(str(f2)) and chunk_idx == 1:
                with open(f2, "wb") as wf:
                    wf.write(b"F" * (200 * 1024) + b"BOYUT_DEGISTI")

        res = scanner.scan_directories(
            [str(self.scan_dir)],
            out_dir=self.out_dir,
            max_retries=1,
            on_chunk_read=mutate_in_scan,
            write_reports=False,
            quiet=True,
        )
        self.assertEqual(res["summary"]["duplicate_groups_count"], 0)
        self.assertGreaterEqual(res["summary"]["modified_during_scan_count"], 1)

    # 9. Okuma izni olmayan dosya
    def test_09_unreadable_file_does_not_abort_scan(self):
        payload = b"Okunabilir-Kopya-Verisi-" * 8000
        f1 = self._write_bytes("ok1.bin", payload)
        f2 = self._write_bytes("ok2.bin", payload)
        f_locked = self._write_bytes("kilitli.bin", payload)

        orig_open = open

        def selective_open(file, *args, **kwargs):
            if str(file).endswith("kilitli.bin") and ("rb" in args or kwargs.get("mode") == "rb"):
                raise PermissionError("Simulated permission denied on kilitli.bin")
            return orig_open(file, *args, **kwargs)

        with mock.patch("builtins.open", side_effect=selective_open):
            res = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)

        # Kilitli dosya hatası sayılmalı, ancak ok1 ve ok2 kopya grubu başarıyla bulunmalı
        self.assertGreaterEqual(res["summary"]["hash_read_errors_count"], 1)
        self.assertEqual(res["summary"]["duplicate_groups_count"], 1)
        self.assertEqual(res["duplicates"][0]["count"], 2)

    # 10. Bozuk veya eski sürüm önbellek
    def test_10_corrupt_or_legacy_cache_recovery(self):
        payload = b"Cache-Test-Verisi-" * 9000
        self._write_bytes("c1.bin", payload)
        self._write_bytes("c2.bin", payload)

        cache_file = self.out_dir / ".scanner_cache.json"

        # Durum A: Bozuk JSON
        cache_file.write_text("{bozuk_json_icerigi...", encoding="utf-8")
        res_corrupt = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertTrue(res_corrupt["summary"]["cache_was_reset"])
        self.assertEqual(res_corrupt["summary"]["duplicate_groups_count"], 1)

        # Durum B: Eski şema (v1 düz {yol: sahte_hash})
        fake_v1 = {str(self.scan_dir / "c1.bin"): "0" * 64, str(self.scan_dir / "c2.bin"): "1" * 64}
        cache_file.write_text(json.dumps(fake_v1), encoding="utf-8")
        res_v1 = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertTrue(res_v1["summary"]["cache_was_reset"])
        # Sahte v1 önbelleği reddedildiği için gerçek SHA-256 hesaplanmalı ve 1 kopya grubu bulunmalı
        self.assertEqual(res_v1["summary"]["duplicate_groups_count"], 1)
        self.assertEqual(res_v1["duplicates"][0]["hash"], hashlib.sha256(payload).hexdigest())

    # 11. Sıfır baytlık dosyalar
    def test_11_zero_byte_files(self):
        self._write_bytes("bos1.txt", b"")
        self._write_bytes("bos2.txt", b"")
        self._write_bytes("alt/bos3.log", b"")

        res = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertEqual(res["summary"]["zero_byte_files_count"], 3)
        self.assertEqual(res["summary"]["total_files_scanned"], 3)
        self.assertEqual(res["summary"]["duplicate_groups_count"], 0)
        self.assertEqual(res["summary"]["total_wasted_bytes"], 0)

    # 12. Farklı sürücülerdeki / kök dizinlerdeki aynı içerikli dosyalar
    def test_12_cross_drive_or_multi_root_duplicates(self):
        payload = b"Capraz-Surucu-Test-Verisi-" * 6000
        dir_d = self.root / "disk_d"
        dir_e = self.root / "disk_e"
        dir_d.mkdir(parents=True, exist_ok=True)
        dir_e.mkdir(parents=True, exist_ok=True)

        p1 = dir_d / "arsiv.zip"
        p2 = dir_e / "yedek_arsiv.zip"
        p1.write_bytes(payload)
        p2.write_bytes(payload)

        # Sürücü etiketi ayrıştırmasını D: ve E: olarak simüle et
        def fake_drive_label(fp):
            return "D:" if "disk_d" in str(fp) else "E:"

        with mock.patch("scanner.extract_drive_label", side_effect=fake_drive_label):
            res = scanner.scan_directories([str(dir_d), str(dir_e)], out_dir=self.out_dir, write_reports=False, quiet=True)

        self.assertEqual(res["summary"]["duplicate_groups_count"], 1)
        self.assertEqual(res["summary"]["cross_drive_groups_count"], 1)
        self.assertTrue(res["duplicates"][0]["is_cross_drive"])
        self.assertEqual(res["duplicates"][0]["drives"], ["D:", "E:"])

    # 13. Aynı içeriğin üç veya daha fazla kopyası (N - 1 alan hesabı)
    def test_13_three_or_more_copies_wasted_space_math(self):
        payload = b"Coklu-Kopya-Hesaplama-" * 5000  # 110,000 bayt
        for i in range(4):
            self._write_bytes(f"kopya_{i}.dat", payload)

        res = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        self.assertEqual(res["summary"]["duplicate_groups_count"], 1)
        grp = res["duplicates"][0]
        self.assertEqual(grp["count"], 4)
        # N=4 kopya için fazladan kopya sayısı N - 1 = 3 olmalıdır
        self.assertEqual(grp["wasted_bytes"], 3 * len(payload))
        self.assertEqual(res["summary"]["total_wasted_bytes"], 3 * len(payload))

    # 14. Sembolik bağlantılar ve hariç tutulan sistem klasörleri (kök ve alt dizin tutarlılığı)
    def test_14_symlinks_and_excluded_system_items(self):
        payload = b"Gercek-Dosya-Verisi-" * 4000
        real_file = self._write_bytes("gercek.dat", payload)

        # Hariç tutulan sistem dosyaları ve klasörleri (hem kökte hem alt klasörde)
        self._write_bytes("pagefile.sys", payload)
        self._write_bytes("~$gecici_word.docx", payload)
        self._write_bytes("dumpstack.log.tmp", payload)
        self._write_bytes("$RECYCLE.BIN/silinmis.dat", payload)
        self._write_bytes("System Volume Information/restore.dat", payload)
        self._write_bytes("node_modules/paket/index.js", payload)
        self._write_bytes("alt_klasor/~$gecici_excel.xlsx", payload)
        self._write_bytes("alt_klasor/dumpstack.log", payload)

        # Sembolik bağlantı oluşturmayı dene (Windows'ta yetki varsa oluşturur)
        sym_path = self.scan_dir / "sembolik_kopya.dat"
        symlink_created = False
        try:
            os.symlink(str(real_file), str(sym_path))
            symlink_created = True
        except OSError:
            pass

        res = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        # Hariç tutulan hiçbir dosya veya sembolik bağlantı taranmış sayılmamalı ve kopya oluşturmamalı!
        self.assertEqual(res["summary"]["total_files_scanned"], 1)
        self.assertEqual(res["summary"]["duplicate_groups_count"], 0)
        self.assertGreaterEqual(res["summary"]["excluded_skipped_count"], 8)
        if symlink_created:
            self.assertGreaterEqual(res["summary"]["symlinks_skipped_count"], 1)

    # 15. Tarama sırasında hata alınması ve rapor üretiminin tutarlılığı (JSON, MD, HTML)
    def test_15_error_resilience_and_report_consistency(self):
        payload = b"Rapor-Tutarlilik-Verisi-" * 7000
        self._write_bytes("dizin1/belge.pdf", payload)
        self._write_bytes("dizin2/belge_kopya.pdf", payload)

        res = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=True, quiet=True)

        json_path = self.out_dir / "duplicate_report.json"
        md_path = self.out_dir / "duplicate_report.md"
        html_path = self.out_dir / "duplicate_report.html"
        bundle_index = self.out_dir / "rapor_kopya" / "index.html"
        bundle_data = self.out_dir / "rapor_kopya" / "data.js"

        self.assertTrue(json_path.exists())
        self.assertTrue(md_path.exists())
        self.assertTrue(html_path.exists())
        self.assertTrue(bundle_index.exists())
        self.assertTrue(bundle_data.exists())

        saved_json = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual(saved_json["summary"]["duplicate_groups_count"], 1)
        self.assertEqual(saved_json["summary"]["total_wasted_bytes"], len(payload))
        self.assertIn("Teorik Kurtarılabilir", md_path.read_text(encoding="utf-8"))
        self.assertIn("Teorik Kurtarılabilir Alan", bundle_index.read_text(encoding="utf-8"))

    # 16. Hardlink (aynı inode) tespiti ve fiziksel vs teorik alan ayrımı + Güvenli Karantina
    def test_16_hardlinks_and_safe_quarantine(self):
        payload = b"Hardlink-ve-Karantina-Testi-" * 6000
        f1 = self._write_bytes("orijinal.bin", payload)
        f2 = self.scan_dir / "hardlink_kopya.bin"
        f3 = self._write_bytes("bagimsiz_kopya.bin", payload)

        hardlink_supported = False
        try:
            os.link(str(f1), str(f2))
            hardlink_supported = True
        except OSError:
            self._write_bytes("hardlink_kopya.bin", payload)

        res = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        grp = res["duplicates"][0]
        self.assertEqual(grp["count"], 3)
        self.assertEqual(grp["wasted_bytes"], 2 * len(payload))
        if hardlink_supported:
            self.assertTrue(grp["has_hardlinks"])
            self.assertEqual(grp["unique_physical_copies"], 2)
            self.assertEqual(grp["physical_wasted_bytes"], 1 * len(payload))

        # Kullanıcı onayı olmadan silme/karantina reddedilmeli
        abort_res = scanner.safe_quarantine_or_delete([str(f3)], res["duplicates"], mode="quarantine", user_confirmed=False)
        self.assertEqual(abort_res["status"], "ABORTED_NO_CONFIRMATION")
        self.assertTrue(f3.exists())

        # Gruptaki tüm dosyalar seçilirse güvenlik kontrolü işlemi engellemeli
        all_paths = [str(f1), str(f2), str(f3)]
        all_sel_res = scanner.safe_quarantine_or_delete(all_paths, res["duplicates"], mode="delete", user_confirmed=True)
        self.assertEqual(len(all_sel_res["moved_or_deleted"]), 0)
        self.assertTrue(f1.exists() and f3.exists())

        # Yalnızca f3 seçildiğinde ve onay verildiğinde güvenli şekilde karantinaya taşınmalı
        ok_res = scanner.safe_quarantine_or_delete(
            [str(f3)],
            res["duplicates"],
            mode="quarantine",
            quarantine_dir_name=str(self.out_dir / "_KARANTINA"),
            user_confirmed=True,
        )
        self.assertEqual(len(ok_res["moved_or_deleted"]), 1)
        self.assertFalse(f3.exists())
        self.assertTrue(Path(ok_res["moved_or_deleted"][0]["destination"]).exists())

    # 17. SQLite önbellek doğruluk ve bozuk veritabanı kurtarma testi
    def test_17_sqlite_cache_backend(self):
        payload = b"SQLite-Cache-Verisi-" * 9000
        f1 = self._write_bytes("sq1.bin", payload)
        f2 = self._write_bytes("sq2.bin", payload)

        res1 = scanner.scan_directories(
            [str(self.scan_dir)],
            out_dir=self.out_dir,
            cache_backend="sqlite",
            write_reports=False,
            quiet=True,
        )
        self.assertEqual(res1["summary"]["duplicate_groups_count"], 1)
        self.assertEqual(res1["summary"]["cache_hits_count"], 0)

        # İkinci taramada SQLite önbellekten isabet (cache hit) almalı
        res2 = scanner.scan_directories(
            [str(self.scan_dir)],
            out_dir=self.out_dir,
            cache_backend="sqlite",
            write_reports=False,
            quiet=True,
        )
        self.assertEqual(res2["summary"]["duplicate_groups_count"], 1)
        self.assertEqual(res2["summary"]["cache_hits_count"], 2)

    # 18. Karantina hedefinde çakışma olduğunda üzerine yazmama (_kopya_1 soneki) testi
    def test_18_quarantine_collision_no_overwrite(self):
        payload = b"Karantina-Cakisma-Testi-" * 5000
        f_keep = self._write_bytes("ana/belge.txt", payload)
        f_dup = self._write_bytes("yedek/belge.txt", payload)

        res = scanner.scan_directories([str(self.scan_dir)], out_dir=self.out_dir, write_reports=False, quiet=True)
        q_root = self.out_dir / "_KARANTINA_TEST"

        # Karantina hedefinde önceden aynı yolda farklı bir dosya bulunduğunu simüle et
        drv, tail = os.path.splitdrive(os.path.abspath(str(f_dup)))
        expected_rel = tail.lstrip("\\/")
        preexisting_dest = Path(os.path.join((drv + "\\") if drv else str(self.out_dir), str(q_root), expected_rel))
        preexisting_dest.parent.mkdir(parents=True, exist_ok=True)
        preexisting_dest.write_bytes(b"ONCEDEN_KARANTINADA_VAR_OLAN_DOSYA")

        q_res = scanner.safe_quarantine_or_delete(
            [str(f_dup)],
            res["duplicates"],
            mode="quarantine",
            quarantine_dir_name=str(q_root),
            user_confirmed=True,
        )
        self.assertEqual(len(q_res["moved_or_deleted"]), 1)
        moved_dest = Path(q_res["moved_or_deleted"][0]["destination"])
        # Mevcut dosyanın üzerine YAZILMAMIŞ olmalı (_kopya_1 olarak kaydedilmeli)
        self.assertNotEqual(moved_dest, preexisting_dest)
        self.assertIn("_kopya_1", moved_dest.name)
        self.assertEqual(preexisting_dest.read_bytes(), b"ONCEDEN_KARANTINADA_VAR_OLAN_DOSYA")
        self.assertEqual(moved_dest.read_bytes(), payload)

    # 19. Temizleme betiğinde güvenli yol kaçışları (PowerShell, CMD, Bash) ve üzerine yazmama kuralları
    def test_19_script_escaping_and_no_clobber_in_app_js(self):
        app_js_path = Path(__file__).parent.parent / "templates" / "kopya_raporu" / "app.js"
        content = app_js_path.read_text(encoding="utf-8")

        # Üç platform için ayrı kaçış fonksiyonları ve çakışmasız hedef oluşturucular bulunmalı
        self.assertIn("function escapePsLiteral(", content)
        self.assertIn("function escapeCmdLiteral(", content)
        self.assertIn("function escapeBashLiteral(", content)
        self.assertIn("function buildQuarantineTargetWin(", content)
        self.assertIn("function buildQuarantineTargetPosix(", content)

        # Tehlikeli üzerine yazma bayrakları (move /y, mv -f, Move-Item ... -Force) kullanılmamalı
        self.assertNotIn("move /y", content)
        self.assertNotIn("mv -f", content)
        self.assertNotIn("Move-Item -LiteralPath $f -Destination $destFile -Force", content)
        self.assertNotIn("Move-Item -LiteralPath $f -Destination $destFolder -Force", content)
        self.assertIn("move /-y", content)
        self.assertIn('mv -n "$src" "$dst"', content)

    # 20. Sıfır baytlık dosya opsiyonu (--include-zero-byte) ve Eksik vs Tam Tarama durumu (scan_status)
    def test_20_zero_byte_include_option_and_partial_scan_status(self):
        self._write_bytes("bos_a.txt", b"")
        self._write_bytes("bos_b.txt", b"")

        # Varsayılan: 0 baytlık dosyalar ayrı izlenir, tam tarama COMPLETE olarak işaretlenir
        res_default = scanner.scan_directories(
            [str(self.scan_dir)],
            out_dir=self.out_dir,
            include_zero_byte_duplicates=False,
            write_reports=False,
            quiet=True,
        )
        self.assertEqual(res_default["summary"]["scan_status"], "COMPLETE")
        self.assertTrue(res_default["summary"]["is_complete_scan"])
        self.assertEqual(res_default["summary"]["duplicate_groups_count"], 0)
        self.assertEqual(res_default["summary"]["zero_byte_policy"], "tracked_separately_0B_waste")

        # Opsiyonel (--include-zero-byte): 0 baytlık dosyalar kopya grubuna dahil edilir
        res_incl = scanner.scan_directories(
            [str(self.scan_dir)],
            out_dir=self.out_dir,
            include_zero_byte_duplicates=True,
            write_reports=False,
            quiet=True,
        )
        self.assertEqual(res_incl["summary"]["duplicate_groups_count"], 1)
        self.assertEqual(res_incl["duplicates"][0]["size_bytes"], 0)
        self.assertEqual(res_incl["duplicates"][0]["count"], 2)

        # Var olmayan bir kök eklendiğinde kısmi tarama (PARTIAL_WITH_ERRORS) olarak raporlanmalı
        res_partial = scanner.scan_directories(
            [str(self.scan_dir), str(self.root / "olmayan_dizin")],
            out_dir=self.out_dir,
            write_reports=True,
            quiet=True,
        )
        self.assertEqual(res_partial["summary"]["scan_status"], "PARTIAL_WITH_ERRORS")
        self.assertFalse(res_partial["summary"]["is_complete_scan"])
        self.assertIn("Kısmi Tarama", (self.out_dir / "duplicate_report.md").read_text(encoding="utf-8"))
        self.assertIn("Kısmi / Eksik Tarama Uyarısı", (self.out_dir / "rapor_kopya" / "index.html").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
