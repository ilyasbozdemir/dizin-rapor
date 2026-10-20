import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowUp,
  ArrowUpDown,
  BarChart2,
  Calendar,
  CheckCircle2,
  ChevronRight,
  Code,
  CornerDownLeft,
  Database,
  Edit3,
  ExternalLink,
  Eye,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  Filter,
  Folder,
  FolderKanban,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Image,
  Layers,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PieChart,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  Tag,
  Terminal,
  Video,
  X,
} from "lucide-react";
import api, { isElectron, SystemDrive } from "./lib/api";
import {
  analyzeArchiveFiles,
  DynamicAnalysisResult,
  extractYear,
} from "@arsiv/core";

function parseBreadcrumbs(pathStr: string): { name: string; path: string }[] {
  if (!pathStr) return [];
  const normalized = pathStr.replace(/\//g, "\\");
  const parts = normalized.split("\\").filter(Boolean);
  const crumbs: { name: string; path: string }[] = [];

  let currentPath = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0 && part.includes(":")) {
      currentPath = `${part}\\`;
      crumbs.push({ name: currentPath, path: currentPath });
    } else {
      currentPath = currentPath.endsWith("\\")
        ? `${currentPath}${part}`
        : `${currentPath}\\${part}`;
      crumbs.push({ name: part, path: currentPath });
    }
  }
  return crumbs;
}

interface FileItem {
  name: string;
  cleanName: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  ext: string;
  tags: string[];
}

const PRESET_MUNICIPAL_TOPICS = [
  "00_KURUMSAL_MEDYA",
  "01_GENEL-YAZISMALAR",
  "02_TAŞINMAZ_İŞLEMLERİ",
  "03_KAMULAŞTIRMA",
  "04_İMAR_UYGULAMALARI",
  "05_İFRAZ_TEVHİD-YOLA_TERK",
  "06_İHALE_ve_ALIM_İŞLERİ",
  "07_ALTYAPI_YOL_KANAL",
  "08_PARK_SPOR_SOSYAL_TESİS",
  "09_ZABİTA_DENETİM",
  "10_PERSONEL_İDARİ",
  "11_KİŞİSEL_DİĞER",
  "99_SINIFLANAMAYAN",
];

const TAG_STYLES: Record<string, { dark: string; light: string }> = {
  ihale: {
    dark: "bg-amber-950/50 text-amber-300 border-amber-700/50",
    light: "bg-amber-50 text-amber-800 border-amber-300",
  },
  imar: {
    dark: "bg-emerald-950/50 text-emerald-300 border-emerald-700/50",
    light: "bg-emerald-50 text-emerald-800 border-emerald-300",
  },
  kurumsal: {
    dark: "bg-blue-950/50 text-blue-300 border-blue-700/50",
    light: "bg-blue-50 text-blue-800 border-blue-300",
  },
  cad: {
    dark: "bg-purple-950/50 text-purple-300 border-purple-700/50",
    light: "bg-purple-50 text-purple-800 border-purple-300",
  },
  onemli: {
    dark: "bg-rose-950/50 text-rose-300 border-rose-700/50",
    light: "bg-rose-50 text-rose-800 border-rose-300",
  },
  sozlesme: {
    dark: "bg-cyan-950/50 text-cyan-300 border-cyan-700/50",
    light: "bg-cyan-50 text-cyan-800 border-cyan-300",
  },
  hakedis: {
    dark: "bg-amber-950/50 text-amber-300 border-amber-700/50",
    light: "bg-amber-50 text-amber-800 border-amber-300",
  },
  belge: {
    dark: "bg-indigo-950/50 text-indigo-300 border-indigo-700/50",
    light: "bg-indigo-50 text-indigo-800 border-indigo-300",
  },
  varsayilan: {
    dark: "bg-slate-800/80 text-slate-300 border-slate-700",
    light: "bg-slate-100 text-slate-700 border-slate-300",
  },
};

function getTagClass(tag: string, theme: "dark" | "light"): string {
  const lower = tag.toLowerCase();
  for (const [key, conf] of Object.entries(TAG_STYLES)) {
    if (lower.includes(key)) return conf[theme];
  }
  return TAG_STYLES.varsayilan[theme];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function getParentDir(p: string): string | null {
  const normalized = p.replace(/[\\/]+$/, "");
  const lastSlash = Math.max(
    normalized.lastIndexOf("\\"),
    normalized.lastIndexOf("/"),
  );
  if (lastSlash > 0) {
    const parent = normalized.substring(0, lastSlash);
    return parent.endsWith(":") ? parent + "\\" : parent;
  }
  return null;
}

export default function App() {
  // Theme Management (Dark / Light)
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("arsiv_theme") as "dark" | "light") || "dark";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem("arsiv_theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  // Layout State
  const [activeTab, setActiveTab] = useState<"explorer" | "runner" | "reports">(
    "explorer",
  );
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);

  // Dynamic Active Explorer Directory
  const [baseDir, setBaseDir] = useState<string>("D:\\E_BIRLESTIRME");
  const [pathInput, setPathInput] = useState<string>("D:\\E_BIRLESTIRME");
  const [isEditingPath, setIsEditingPath] = useState<boolean>(false);
  const [scanDepth, setScanDepth] = useState<number>(2);
  const [systemDrives, setSystemDrives] = useState<SystemDrive[]>([]);
  const [recentFolders, setRecentFolders] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("recent_folders");
      if (saved) return JSON.parse(saved);
    } catch {}
    return ["E:\\", "D:\\E_BIRLESTIRME"];
  });

  // Dynamic Python Runner Source & Target Directories
  const [runnerSourceDir, setRunnerSourceDir] = useState<string>("E:\\");
  const [runnerTargetDir, setRunnerTargetDir] = useState<string>(
    "D:\\E_BIRLESTIRME",
  );
  const [runnerScheme, setRunnerScheme] = useState<string>("konu-tip");

  const [files, setFiles] = useState<FileItem[]>([]);
  const [realSubfolders, setRealSubfolders] = useState<
    { name: string; path: string; fileCount: number }[]
  >([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [newTagInput, setNewTagInput] = useState<string>("");
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");

  // Dynamic Categorization Perspectives
  const [perspective, setPerspective] = useState<
    "topics" | "folders" | "years" | "formats" | "preset"
  >("topics");
  const [activeFilter, setActiveFilter] = useState<
    { type: string; value: string; label: string } | null
  >(null);

  // Python Runner State
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Reports State
  const [reports, setReports] = useState<any>(null);

  // Fetch detected system drives on mount
  useEffect(() => {
    api.getSystemDrives()
      .then((drives) => {
        if (drives && drives.length > 0) {
          setSystemDrives(drives);
        }
      })
      .catch(() => {});
  }, []);

  // Navigate to directory
  const changeDirectory = (newPath: string) => {
    if (!newPath || !newPath.trim()) return;
    const clean = newPath.trim();
    setBaseDir(clean);
    setPathInput(clean);
    setIsEditingPath(false);
    setRecentFolders((prev) => {
      const next = [
        clean,
        ...prev.filter((p) => p.toLowerCase() !== clean.toLowerCase()),
      ].slice(0, 6);
      try {
        localStorage.setItem("recent_folders", JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // Load directory items
  const loadFiles = async (folderPath: string, depth = scanDepth) => {
    setLoading(true);
    try {
      const res = await api.listDirectory(folderPath, { maxDepth: depth });
      if (res && res.success) {
        setFiles(res.items || []);
        if (res.subfolders) {
          setRealSubfolders(res.subfolders);
        }
        if (res.targetDir && res.targetDir !== baseDir) {
          setBaseDir(res.targetDir);
          setPathInput(res.targetDir);
        }
      }
    } catch (err) {
      console.error("Error loading files:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFiles(baseDir, scanDepth);
    setPathInput(baseDir);
    setActiveFilter(null);
  }, [baseDir, scanDepth]);

  // Custom folder picker for explorer
  const handleSelectFolder = async () => {
    try {
      const selected = await api.selectFolder();
      if (selected) {
        changeDirectory(selected);
      }
    } catch (err) {
      console.error("Error selecting folder:", err);
    }
  };

  // Custom folder picker for Python runner source
  const handleSelectRunnerSource = async () => {
    try {
      const selected = await api.selectFolder();
      if (selected) setRunnerSourceDir(selected);
    } catch (err) {
      console.error("Error selecting runner source folder:", err);
    }
  };

  // Custom folder picker for Python runner target
  const handleSelectRunnerTarget = async () => {
    try {
      const selected = await api.selectFolder();
      if (selected) setRunnerTargetDir(selected);
    } catch (err) {
      console.error("Error selecting runner target folder:", err);
    }
  };

  // Load Reports
  useEffect(() => {
    api.getMigrationReports().then((data) => {
      if (data) setReports(data);
    }).catch((err) => {
      console.error("Failed to load migration reports:", err);
    });
  }, []);

  // Subscribe to Python Process Output
  useEffect(() => {
    const unsubOutput = api.onPythonOutput((data) => {
      setTerminalLogs((prev) => [...prev, data.text]);
    });

    const unsubExit = api.onPythonExit((data) => {
      setTerminalLogs((
        prev,
      ) => [...prev, `\n[Süreç Tamamlandı: Çıkış Kodu ${data.code}]\n`]);
      setRunningTaskId(null);
      // refresh reports & files
      api.getMigrationReports().then((rep) => setReports(rep)).catch(
        console.error,
      );
      loadFiles(baseDir);
    });

    return () => {
      unsubOutput();
      unsubExit();
    };
  }, [baseDir]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [terminalLogs]);

  // Dynamic Universal Semantic Analysis
  const analysis: DynamicAnalysisResult = useMemo(() => {
    return analyzeArchiveFiles(files, baseDir);
  }, [files, baseDir]);

  // Run Python Script Action
  const runScript = async (
    taskId: string,
    scriptName: string,
    args: string[],
  ) => {
    setRunningTaskId(taskId);
    setTerminalLogs((prev) => [
      ...prev,
      `\n=======================================================\n` +
      `[BAŞLATILIYOR] ${scriptName} ${args.join(" ")}\n` +
      `=======================================================\n`,
    ]);
    setActiveTab("runner");
    const res = await api.runPythonTask({ taskId, scriptName, args });
    if (!res.success) {
      setTerminalLogs((
        prev,
      ) => [...prev, `\n[HATA] ${res.message || "İşlem başlatılamadı"}\n`]);
      setRunningTaskId(null);
    }
  };

  const stopScript = async (taskId: string) => {
    await api.stopPythonTask({ taskId });
    setRunningTaskId(null);
    setTerminalLogs((
      prev,
    ) => [...prev, `\n[KULLANICI TARAFINDAN DURDURULDU]\n`]);
  };

  // Tag management
  const handleAddTag = async (file: FileItem) => {
    if (!newTagInput.trim()) return;
    const tag = newTagInput.trim();
    const res = await api.addFileTag({ filePath: file.path, tag });
    if (res.success) {
      setFiles((prev) =>
        prev.map((f) => (f.path === file.path ? { ...f, tags: res.tags } : f))
      );
      if (selectedFile?.path === file.path) {
        setSelectedFile({ ...selectedFile, tags: res.tags });
      }
      setNewTagInput("");
    }
  };

  const handleRemoveTag = async (file: FileItem, tag: string) => {
    const res = await api.removeFileTag({ filePath: file.path, tag });
    if (res.success) {
      setFiles((prev) =>
        prev.map((f) => (f.path === file.path ? { ...f, tags: res.tags } : f))
      );
      if (selectedFile?.path === file.path) {
        setSelectedFile({ ...selectedFile, tags: res.tags });
      }
    }
  };

  // File icons
  const getFileIcon = (ext: string) => {
    switch (ext) {
      case ".pdf":
      case ".doc":
      case ".docx":
      case ".txt":
        return 
        <FileText className="w-8 h-8 text-blue-500 dark:text-blue-400" />;
      case ".xls":
      case ".xlsx":
      case ".csv":
        return (
          <FileSpreadsheet className="w-8 h-8 text-emerald-600 dark:text-emerald-400" />
        );
      case ".jpg":
      case ".jpeg":
      case ".png":
      case ".webp":
      case ".gif":
        return <Image className="w-8 h-8 text-pink-500 dark:text-pink-400" />;
      case ".mp4":
      case ".avi":
      case ".mov":
      case ".mkv":
        return <Video className="w-8 h-8 text-rose-500 dark:text-rose-400" />;
      case ".zip":
      case ".rar":
      case ".7z":
        return (
          <Archive className="w-8 h-8 text-amber-500 dark:text-amber-400" />
        );
      case ".dwg":
      case ".dxf":
      case ".ncz":
        return (
          <Layers className="w-8 h-8 text-purple-500 dark:text-purple-400" />
        );
      default:
        return <Code className="w-8 h-8 text-slate-400" />;
    }
  };

  // Dynamic Filtering Logic
  const filteredFiles = useMemo(() => {
    return files.filter((f) => {
      // 1. Text Search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matches = f.name.toLowerCase().includes(q) ||
          f.tags.some((t) => t.toLowerCase().includes(q));
        if (!matches) return false;
      }

      // 2. Tag Filter
      if (selectedTag && !f.tags.includes(selectedTag)) {
        return false;
      }

      // 3. Dynamic Perspective Cluster Filter
      if (activeFilter) {
        if (activeFilter.type === "topic") {
          return f.name.toLowerCase().includes(
            activeFilter.value.toLowerCase(),
          );
        }
        if (activeFilter.type === "folder") {
          return f.path.includes(activeFilter.value);
        }
        if (activeFilter.type === "year") {
          return extractYear(f.name) === activeFilter.value;
        }
        if (activeFilter.type === "format") {
          const cluster = analysis.formatClusters.find((c) =>
            c.id === activeFilter.value
          );
          return cluster
            ? cluster.files.some((cf) => cf.path === f.path)
            : true;
        }
        if (activeFilter.type === "preset") {
          return f.path.includes(activeFilter.value);
        }
      }

      return true;
    });
  }, [files, searchQuery, selectedTag, activeFilter, analysis]);

  const allUniqueTags = Array.from(new Set(files.flatMap((f) => f.tags)));

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-50 dark:bg-[#080c18] text-slate-800 dark:text-gray-100 transition-colors duration-200">
      {/* Top Navbar with Dynamic Path Navigator */}
      <header className="h-14 border-b border-slate-200 dark:border-white/10 px-4 flex items-center justify-between bg-white/95 dark:bg-[#0f172a]/95 backdrop-blur-md z-10 transition-colors">
        <div className="flex items-center gap-3">
          {/* Sidebar Toggle Button */}
          {activeTab === "explorer" && (
            <button
              onClick={() => setIsSidebarOpen((prev) => !prev)}
              className="p-1.5 rounded-xl border border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/5 text-slate-500 dark:text-gray-400 transition"
              title={isSidebarOpen
                ? "Kenar Çubuğunu Daralt"
                : "Kenar Çubuğunu Genişlet"}
            >
              {isSidebarOpen
                ? <PanelLeftClose className="w-4 h-4" />
                : <PanelLeftOpen className="w-4 h-4" />}
            </button>
          )}

          {/* Logo Badge */}
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-cyan-500 flex items-center justify-center font-black text-xs text-white shadow-md shadow-indigo-500/20 tracking-wider">
            360
          </div>

          <div>
            <h1 className="font-bold text-sm leading-tight text-slate-900 dark:text-white flex items-center gap-1.5">
              <span>Arşiv 360</span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60 font-semibold">
                PRO
              </span>
              {isElectron && (
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.2 rounded bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30">
                  DESKTOP (F12)
                </span>
              )}
            </h1>
          </div>
        </div>

        {/* Dynamic Drive & Folder Selector Buttons */}
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {systemDrives.length > 0
            ? (
              systemDrives.map((drive) => {
                const isSelected = baseDir.toLowerCase().startsWith(
                  drive.letter.toLowerCase() + ":",
                );
                return (
                  <button
                    key={drive.path}
                    onClick={() => changeDirectory(drive.path)}
                    className={`px-2.5 py-1 text-xs rounded-lg border font-mono font-bold flex items-center gap-1.5 transition ${
                      isSelected
                        ? "bg-cyan-50 dark:bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 border-cyan-300 dark:border-cyan-500/40 shadow-xs"
                        : "border-slate-200 dark:border-white/10 text-slate-600 dark:text-gray-400 hover:bg-slate-100 dark:hover:bg-white/5"
                    }`}
                    title={`${drive.label} (${drive.path})`}
                  >
                    <HardDrive className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                    <span>{drive.letter}:</span>
                  </button>
                );
              })
            )
            : (
              <>
                <button
                  onClick={() => changeDirectory("C:\\")}
                  className={`px-2.5 py-1 text-xs rounded-lg border font-mono font-bold flex items-center gap-1.5 transition ${
                    baseDir.toLowerCase().startsWith("c:")
                      ? "bg-cyan-50 dark:bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 border-cyan-300 dark:border-cyan-500/40 shadow-xs"
                      : "border-slate-200 dark:border-white/10 text-slate-600 dark:text-gray-400 hover:bg-slate-100 dark:hover:bg-white/5"
                  }`}
                  title="Yerel Disk (C:\)"
                >
                  <HardDrive className="w-3.5 h-3.5 text-cyan-500" />
                  C:
                </button>
                <button
                  onClick={() => changeDirectory("D:\\E_BIRLESTIRME")}
                  className={`px-2.5 py-1 text-xs rounded-lg border font-mono font-bold flex items-center gap-1.5 transition ${
                    baseDir.toLowerCase().startsWith("d:")
                      ? "bg-indigo-50 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-500/40 shadow-xs"
                      : "border-slate-200 dark:border-white/10 text-slate-600 dark:text-gray-400 hover:bg-slate-100 dark:hover:bg-white/5"
                  }`}
                  title="Arşiv (D:\E_BIRLESTIRME)"
                >
                  <HardDrive className="w-3.5 h-3.5 text-indigo-500" />
                  D:
                </button>
                <button
                  onClick={() => changeDirectory("E:\\")}
                  className={`px-2.5 py-1 text-xs rounded-lg border font-mono font-bold flex items-center gap-1.5 transition ${
                    baseDir.toLowerCase().startsWith("e:")
                      ? "bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/40 shadow-xs"
                      : "border-slate-200 dark:border-white/10 text-slate-600 dark:text-gray-400 hover:bg-slate-100 dark:hover:bg-white/5"
                  }`}
                  title="USB / Disk (E:\)"
                >
                  <HardDrive className="w-3.5 h-3.5 text-emerald-500" />
                  E:
                </button>
              </>
            )}

          {/* Prominent Browse Folder Button */}
          <button
            onClick={handleSelectFolder}
            className="px-2.5 py-1 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1.5 shadow-xs transition shrink-0"
            title="Bilgisayarınızdaki herhangi bir klasörü seçip anında derinlemesine tara"
          >
            <FolderSearch className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Klasör Seç...</span>
          </button>
        </div>

        {/* Dynamic Interactive Path Navigator (Breadcrumb / Editable Bar) */}
        <div className="flex items-center gap-1.5 flex-1 max-w-xl mx-3 min-w-0">
          {getParentDir(baseDir) && (
            <button
              onClick={() => changeDirectory(getParentDir(baseDir)!)}
              className="p-1.5 rounded-xl border border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/5 text-slate-600 dark:text-gray-300 transition shrink-0"
              title={`Üst Klasöre Çık: ${getParentDir(baseDir)}`}
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          )}

          {!isEditingPath
            ? (
              <div className="flex-1 flex items-center gap-1 bg-slate-100 dark:bg-[#141d30] border border-slate-200 dark:border-white/10 rounded-xl px-2.5 py-1 min-w-0 shadow-inner">
                <Folder className="w-3.5 h-3.5 text-indigo-500 shrink-0 mr-1" />
                <div className="flex items-center gap-1 flex-1 overflow-x-auto scrollbar-none py-0.5">
                  {parseBreadcrumbs(baseDir).map((crumb, idx, arr) => (
                    <div
                      key={crumb.path}
                      className="flex items-center shrink-0"
                    >
                      <button
                        onClick={() => changeDirectory(crumb.path)}
                        className={`text-xs px-1.5 py-0.5 rounded-md hover:bg-white dark:hover:bg-white/10 transition truncate max-w-[140px] ${
                          idx === arr.length - 1
                            ? "font-bold text-indigo-700 dark:text-indigo-300"
                            : "text-slate-600 dark:text-gray-400 font-medium"
                        }`}
                        title={crumb.path}
                      >
                        {crumb.name}
                      </button>
                      {idx < arr.length - 1 && (
                        <ChevronRight className="w-3 h-3 text-slate-400 dark:text-gray-600 shrink-0" />
                      )}
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => setIsEditingPath(true)}
                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-gray-200 hover:bg-slate-200 dark:hover:bg-white/10 rounded transition shrink-0"
                  title="Dizin Yolunu Elle Düzenle"
                >
                  <Edit3 className="w-3 h-3" />
                </button>
              </div>
            )
            : (
              <div className="relative flex-1 flex items-center min-w-0">
                <HardDrive className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400 absolute left-3 pointer-events-none shrink-0" />
                <input
                  type="text"
                  autoFocus
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") changeDirectory(pathInput);
                    if (e.key === "Escape") setIsEditingPath(false);
                  }}
                  placeholder="Dizin yolu girin veya seçin... (Örn: E:\, D:\Arsiv)"
                  className="w-full bg-slate-100 dark:bg-[#141d30] border border-indigo-500 rounded-xl pl-9 pr-16 py-1.5 text-xs text-slate-800 dark:text-gray-200 font-mono focus:outline-none transition shadow-inner"
                />
                <div className="absolute right-1 flex items-center gap-1">
                  <button
                    onClick={() => changeDirectory(pathInput)}
                    className="px-2 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[11px] font-semibold"
                    title="Git"
                  >
                    Git
                  </button>
                  <button
                    onClick={() => setIsEditingPath(false)}
                    className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-gray-200 rounded"
                    title="İptal"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

          {/* Quick Access Recent Pills */}
          <div className="hidden xl:flex items-center gap-1 shrink-0">
            {recentFolders.slice(0, 2).map((rf) => (
              <button
                key={rf}
                onClick={() => changeDirectory(rf)}
                className={`px-2 py-1 text-[11px] font-mono rounded-lg border transition truncate max-w-[95px] ${
                  baseDir.toLowerCase() === rf.toLowerCase()
                    ? "bg-cyan-50 dark:bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 border-cyan-300 dark:border-cyan-500/40 font-bold"
                    : "border-slate-200 dark:border-white/10 text-slate-600 dark:text-gray-400 hover:bg-slate-100 dark:hover:bg-white/5"
                }`}
                title={rf}
              >
                {rf}
              </button>
            ))}
          </div>
        </div>

        {/* Tab Navigation Center */}
        <div className="flex items-center gap-1 bg-slate-100 dark:bg-[#141c2e] p-1 rounded-xl border border-slate-200 dark:border-white/5 shrink-0">
          <button
            onClick={() => setActiveTab("explorer")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
              activeTab === "explorer"
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-white/5"
            }`}
          >
            <Folder className="w-3.5 h-3.5" />
            Dosya Gezgini
          </button>
          <button
            onClick={() => setActiveTab("runner")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
              activeTab === "runner"
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-white/5"
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            Python Motoru
            {runningTaskId && (
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping ml-1" />
            )}
          </button>
          <button
            onClick={() => setActiveTab("reports")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
              activeTab === "reports"
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-white/5"
            }`}
          >
            <BarChart2 className="w-3.5 h-3.5" />
            Raporlar & Analiz
          </button>

          {/* Theme Toggle Button */}
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-lg border border-slate-200 dark:border-white/10 hover:bg-slate-200/70 dark:hover:bg-white/5 text-slate-600 dark:text-amber-400 transition ml-1"
            title={theme === "dark" ? "Açık Temaya Geç" : "Koyu Temaya Geç"}
          >
            {theme === "dark"
              ? <Sun className="w-4 h-4" />
              : <Moon className="w-4 h-4 text-slate-700" />}
          </button>
        </div>
      </header>

      {/* Main Body */}
      {activeTab === "explorer" && (
        <div className="flex-1 flex overflow-hidden">
          {/* Modern Collapsible Left Sidebar */}
          {isSidebarOpen && (
            <aside className="w-72 border-r border-slate-200 dark:border-white/10 bg-white dark:bg-[#0c1222] flex flex-col justify-between transition-all duration-200 shadow-sm">
              <div className="p-3 overflow-y-auto flex-1">
                {/* Perspective Switcher Segmented Control */}
                <div className="mb-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-gray-400 uppercase tracking-wider">
                      Kategori Perspektifi
                    </span>
                    <SlidersHorizontal className="w-3 h-3 text-cyan-600 dark:text-cyan-400" />
                  </div>
                  <div className="grid grid-cols-2 gap-1 bg-slate-100 dark:bg-[#141d30] p-1 rounded-xl border border-slate-200 dark:border-white/5 text-[11px]">
                    <button
                      onClick={() => setPerspective("topics")}
                      className={`py-1 px-1.5 rounded-lg flex items-center justify-center gap-1 transition ${
                        perspective === "topics"
                          ? "bg-cyan-600 text-white font-bold shadow-sm"
                          : "text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white"
                      }`}
                    >
                      <Sparkles className="w-3 h-3" />
                      Konular
                    </button>
                    <button
                      onClick={() => setPerspective("folders")}
                      className={`py-1 px-1.5 rounded-lg flex items-center justify-center gap-1 transition ${
                        perspective === "folders"
                          ? "bg-cyan-600 text-white font-bold shadow-sm"
                          : "text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white"
                      }`}
                    >
                      <Folder className="w-3 h-3" />
                      Klasörler
                    </button>
                    <button
                      onClick={() => setPerspective("years")}
                      className={`py-1 px-1.5 rounded-lg flex items-center justify-center gap-1 transition ${
                        perspective === "years"
                          ? "bg-cyan-600 text-white font-bold shadow-sm"
                          : "text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white"
                      }`}
                    >
                      <Calendar className="w-3 h-3" />
                      Zaman
                    </button>
                    <button
                      onClick={() => setPerspective("formats")}
                      className={`py-1 px-1.5 rounded-lg flex items-center justify-center gap-1 transition ${
                        perspective === "formats"
                          ? "bg-cyan-600 text-white font-bold shadow-sm"
                          : "text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white"
                      }`}
                    >
                      <Layers className="w-3 h-3" />
                      Türler
                    </button>
                  </div>

                  <div className="mt-1 flex justify-end">
                    <button
                      onClick={() =>
                        setPerspective(
                          perspective === "preset" ? "topics" : "preset",
                        )}
                      className={`text-[10px] flex items-center gap-1 px-2 py-0.5 rounded transition ${
                        perspective === "preset"
                          ? "bg-indigo-100 dark:bg-indigo-600/40 text-indigo-700 dark:text-indigo-300 font-bold border border-indigo-300 dark:border-indigo-500/40"
                          : "text-slate-500 dark:text-gray-400 hover:text-slate-800 dark:hover:text-gray-200"
                      }`}
                    >
                      <FolderKanban className="w-3 h-3" />
                      Kurumsal Şablon ({PRESET_MUNICIPAL_TOPICS.length})
                    </button>
                  </div>
                </div>

                {/* Active Filter Clear Bar */}
                {activeFilter && (
                  <div className="mb-2.5 p-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-700/40 flex items-center justify-between text-xs">
                    <div className="truncate pr-1">
                      <span className="text-[10px] text-slate-500 dark:text-gray-400 block font-medium">
                        Seçili Filtre:
                      </span>
                      <span className="font-bold text-indigo-700 dark:text-indigo-200 truncate block">
                        {activeFilter.label}
                      </span>
                    </div>
                    <button
                      onClick={() => setActiveFilter(null)}
                      className="p-1 hover:bg-slate-200 dark:hover:bg-white/10 rounded-lg text-slate-600 dark:text-gray-300"
                      title="Filtreyi Temizle"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {/* All Files Button */}
                <button
                  onClick={() => setActiveFilter(null)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition mb-2 ${
                    !activeFilter
                      ? "bg-indigo-50 dark:bg-indigo-600/30 text-indigo-700 dark:text-indigo-300 font-bold border border-indigo-300 dark:border-indigo-500/30 shadow-xs"
                      : "text-slate-600 dark:text-gray-400 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-900 dark:hover:text-gray-200"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-indigo-500" />
                    <span>Tüm Dosyalar</span>
                  </div>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-200/70 dark:bg-white/10 text-slate-700 dark:text-gray-300 font-mono font-bold">
                    {files.length}
                  </span>
                </button>

                {/* PERSPECTIVE 1: DYNAMIC TOPICS */}
                {perspective === "topics" && (
                  <div className="space-y-0.5">
                    <div className="text-[10px] font-bold text-cyan-600 dark:text-cyan-400 uppercase tracking-wider py-1 flex items-center gap-1">
                      <Sparkles className="w-3 h-3" />
                      İsimlerden Analiz Edilen Konular
                    </div>
                    {analysis.smartTopics.length === 0
                      ? (
                        <p className="text-xs text-slate-500 dark:text-gray-500 italic p-2">
                          Tekrarlayan konu anahtarı tespit edilemedi.
                        </p>
                      )
                      : (
                        analysis.smartTopics.map((topic) => {
                          const isActive = activeFilter?.type === "topic" &&
                            activeFilter.value === topic.label;
                          return (
                            <button
                              key={topic.id}
                              onClick={() =>
                                setActiveFilter(
                                  isActive
                                    ? null
                                    : {
                                      type: "topic",
                                      value: topic.label,
                                      label: `Konu: ${topic.label}`,
                                    },
                                )}
                              className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition ${
                                isActive
                                  ? "bg-cyan-50 dark:bg-cyan-600/30 text-cyan-800 dark:text-cyan-200 font-bold border border-cyan-300 dark:border-cyan-500/40"
                                  : "text-slate-700 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-900 dark:hover:text-white"
                              }`}
                            >
                              <div className="flex items-center gap-2 truncate">
                                <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 shrink-0" />
                                <span className="truncate">{topic.label}</span>
                              </div>
                              <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-200/60 dark:bg-white/5 text-slate-600 dark:text-gray-400 font-mono">
                                {topic.count}
                              </span>
                            </button>
                          );
                        })
                      )}
                  </div>
                )}

                {/* PERSPECTIVE 2: REAL FOLDERS */}
                {perspective === "folders" && (
                  <div className="space-y-0.5">
                    <div className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider py-1 flex items-center gap-1">
                      <Folder className="w-3 h-3" />
                      Gerçek Klasörler
                    </div>
                    {(realSubfolders.length > 0
                      ? realSubfolders
                      : analysis.realFolders).map((f: any) => {
                        const name = f.name || f.label;
                        const isActive = activeFilter?.type === "folder" &&
                          activeFilter.value === name;
                        const count = f.fileCount !== undefined
                          ? f.fileCount
                          : f.count;
                        return (
                          <button
                            key={name}
                            onClick={() =>
                              setActiveFilter(
                                isActive
                                  ? null
                                  : {
                                    type: "folder",
                                    value: name,
                                    label: `Klasör: ${name}`,
                                  },
                              )}
                            className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition ${
                              isActive
                                ? "bg-amber-50 dark:bg-amber-600/30 text-amber-800 dark:text-amber-200 font-bold border border-amber-300 dark:border-amber-500/40"
                                : "text-slate-700 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-900 dark:hover:text-white"
                            }`}
                          >
                            <div className="flex items-center gap-2 truncate">
                              <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                              <span className="truncate">{name}</span>
                            </div>
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-200/60 dark:bg-white/5 text-slate-600 dark:text-gray-400 font-mono">
                              {count}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                )}

                {/* PERSPECTIVE 3: YEARS */}
                {perspective === "years" && (
                  <div className="space-y-0.5">
                    <div className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider py-1 flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      Zaman & Yıl Çizelgesi
                    </div>
                    {analysis.yearClusters.map((cluster) => {
                      const yr = cluster.badge || cluster.label;
                      const isActive = activeFilter?.type === "year" &&
                        activeFilter.value === yr;
                      return (
                        <button
                          key={cluster.id}
                          onClick={() =>
                            setActiveFilter(
                              isActive
                                ? null
                                : {
                                  type: "year",
                                  value: yr,
                                  label: `${yr} Yılı Belgeleri`,
                                },
                            )}
                          className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition ${
                            isActive
                              ? "bg-emerald-50 dark:bg-emerald-600/30 text-emerald-800 dark:text-emerald-200 font-bold border border-emerald-300 dark:border-emerald-500/40"
                              : "text-slate-700 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-900 dark:hover:text-white"
                          }`}
                        >
                          <div className="flex items-center gap-2 truncate">
                            <Calendar className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                            <span className="truncate">{yr} Yılı</span>
                          </div>
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-200/60 dark:bg-white/5 text-slate-600 dark:text-gray-400 font-mono">
                            {cluster.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* PERSPECTIVE 4: FORMATS */}
                {perspective === "formats" && (
                  <div className="space-y-0.5">
                    <div className="text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wider py-1 flex items-center gap-1">
                      <Layers className="w-3 h-3" />
                      Dosya Türü & Format Kümeleri
                    </div>
                    {analysis.formatClusters.map((cluster) => {
                      const isActive = activeFilter?.type === "format" &&
                        activeFilter.value === cluster.id;
                      return (
                        <button
                          key={cluster.id}
                          onClick={() =>
                            setActiveFilter(
                              isActive
                                ? null
                                : {
                                  type: "format",
                                  value: cluster.id,
                                  label: cluster.label,
                                },
                            )}
                          className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition ${
                            isActive
                              ? "bg-purple-50 dark:bg-purple-600/30 text-purple-800 dark:text-purple-200 font-bold border border-purple-300 dark:border-purple-500/40"
                              : "text-slate-700 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-900 dark:hover:text-white"
                          }`}
                        >
                          <div className="flex items-center gap-2 truncate">
                            <Layers className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                            <span className="truncate">{cluster.label}</span>
                          </div>
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-200/60 dark:bg-white/5 text-slate-600 dark:text-gray-400 font-mono">
                            {cluster.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* PERSPECTIVE 5: PRESET */}
                {perspective === "preset" && (
                  <div className="space-y-0.5">
                    <div className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider py-1 flex items-center gap-1">
                      <FolderKanban className="w-3 h-3" />
                      Kurumsal Şablon (13 Konu)
                    </div>
                    {PRESET_MUNICIPAL_TOPICS.map((topic) => {
                      const isActive = activeFilter?.type === "preset" &&
                        activeFilter.value === topic;
                      return (
                        <button
                          key={topic}
                          onClick={() =>
                            setActiveFilter(
                              isActive
                                ? null
                                : {
                                  type: "preset",
                                  value: topic,
                                  label: `Şablon: ${topic}`,
                                },
                            )}
                          className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs truncate flex items-center gap-2 transition ${
                            isActive
                              ? "bg-indigo-50 dark:bg-indigo-600/30 text-indigo-800 dark:text-indigo-300 font-bold border border-indigo-300 dark:border-indigo-500/30"
                              : "text-slate-600 dark:text-gray-400 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-900 dark:hover:text-gray-200"
                          }`}
                        >
                          <Folder className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span className="truncate">{topic}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Tags Filter */}
                <div className="mt-6 pt-4 border-t border-slate-200 dark:border-white/10">
                  <div className="text-[10px] font-bold text-slate-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Tag className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
                      Akıllı Etiketler
                    </span>
                    {selectedTag && (
                      <button
                        onClick={() => setSelectedTag(null)}
                        className="text-[10px] text-slate-500 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white"
                      >
                        Temizle
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {allUniqueTags.length === 0
                      ? (
                        <p className="text-[11px] text-slate-400 dark:text-gray-500 italic">
                          Henüz etiket eklenmedi.
                        </p>
                      )
                      : (
                        allUniqueTags.map((t) => (
                          <button
                            key={t}
                            onClick={() =>
                              setSelectedTag(selectedTag === t ? null : t)}
                            className={`text-[11px] px-2 py-0.5 rounded-full border transition flex items-center gap-1 font-medium ${
                              selectedTag === t
                                ? "bg-cyan-600 text-white border-cyan-500 shadow-xs"
                                : getTagClass(t, theme)
                            }`}
                          >
                            #{t}
                          </button>
                        ))
                      )}
                  </div>
                </div>
              </div>

              {/* Sidebar Footer Info Card */}
              <div className="p-3 border-t border-slate-200 dark:border-white/10 bg-slate-50/80 dark:bg-[#080c16]/80 text-xs">
                <div className="flex items-center justify-between text-slate-500 dark:text-gray-400 mb-1">
                  <span>Görüntülenen:</span>
                  <b className="text-cyan-700 dark:text-cyan-400 font-mono font-bold">
                    {filteredFiles.length} / {files.length} dosya
                  </b>
                </div>
                {reports?.duplicate?.summary && (
                  <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-gray-400 pt-1 border-t border-slate-200/60 dark:border-white/5">
                    <span>Kurtarılan Alan:</span>
                    <span className="text-emerald-600 dark:text-emerald-400 font-bold font-mono">
                      {reports.duplicate.summary.total_wasted_formatted}
                    </span>
                  </div>
                )}
              </div>
            </aside>
          )}

          {/* Central File Area */}
          <main className="flex-1 flex flex-col bg-slate-50 dark:bg-[#080c18] transition-colors">
            {/* Search and View Bar */}
            <div className="h-12 border-b border-slate-200 dark:border-white/10 px-4 flex items-center justify-between gap-4 bg-white/70 dark:bg-[#0e1628]/40 backdrop-blur-xs">
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 text-slate-400 dark:text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Dosya adı veya etiket ara... (#ihale, .pdf, ada, metraj)"
                  className="w-full bg-slate-100 dark:bg-[#151f33] border border-slate-200 dark:border-white/10 rounded-xl pl-9 pr-3 py-1.5 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-400 focus:outline-none focus:border-indigo-500 transition"
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => loadFiles(baseDir)}
                  className="p-1.5 text-slate-500 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-white/5 transition"
                  title="Yenile"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
                <div className="border-l border-slate-200 dark:border-white/10 h-5" />
                <button
                  onClick={() => setViewMode("grid")}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition ${
                    viewMode === "grid"
                      ? "bg-indigo-600 text-white shadow-xs"
                      : "text-slate-600 dark:text-gray-400 hover:bg-slate-100 dark:hover:bg-white/5"
                  }`}
                >
                  Grid
                </button>
                <button
                  onClick={() => setViewMode("table")}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition ${
                    viewMode === "table"
                      ? "bg-indigo-600 text-white shadow-xs"
                      : "text-slate-600 dark:text-gray-400 hover:bg-slate-100 dark:hover:bg-white/5"
                  }`}
                >
                  Tablo
                </button>
              </div>
            </div>

            {/* Subfolders & Deep Scanning Toolbar */}
            <div className="border-b border-slate-200 dark:border-white/10 bg-white/70 dark:bg-[#0c1424]/70 px-4 py-2.5 backdrop-blur-xs">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <Folder className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                  <span className="text-xs font-bold text-slate-800 dark:text-gray-100">
                    İç Dizinler ({realSubfolders.length} Alt Klasör)
                  </span>
                  <span className="text-[11px] text-slate-500 dark:text-gray-400 hidden sm:inline">
                    — İçeri girmek veya taramak için tıklayın
                  </span>
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[11px] text-slate-500 dark:text-gray-400">
                    Tarama Derinliği:
                  </span>
                  <div className="flex bg-slate-100 dark:bg-[#141d30] p-0.5 rounded-lg border border-slate-200 dark:border-white/5 text-[11px]">
                    <button
                      onClick={() => {
                        setScanDepth(1);
                        loadFiles(baseDir, 1);
                      }}
                      className={`px-2 py-0.5 rounded-md transition ${
                        scanDepth === 1
                          ? "bg-indigo-600 text-white font-bold shadow-xs"
                          : "text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white"
                      }`}
                      title="Yalnızca bu dizindeki dosyalar"
                    >
                      1 Seviye
                    </button>
                    <button
                      onClick={() => {
                        setScanDepth(2);
                        loadFiles(baseDir, 2);
                      }}
                      className={`px-2 py-0.5 rounded-md transition ${
                        scanDepth === 2
                          ? "bg-indigo-600 text-white font-bold shadow-xs"
                          : "text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white"
                      }`}
                      title="Varsayılan: 2 seviye alt klasörler taranır"
                    >
                      2 Seviye
                    </button>
                    <button
                      onClick={() => {
                        setScanDepth(3);
                        loadFiles(baseDir, 3);
                      }}
                      className={`px-2 py-0.5 rounded-md transition ${
                        scanDepth === 3
                          ? "bg-indigo-600 text-white font-bold shadow-xs"
                          : "text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white"
                      }`}
                      title="3 seviye derin tarama"
                    >
                      3 Seviye
                    </button>
                  </div>

                  <button
                    onClick={() => {
                      setRunnerSourceDir(baseDir);
                      setActiveTab("runner");
                    }}
                    className="px-2.5 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/60 font-semibold text-[11px] flex items-center gap-1 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition shadow-2xs"
                    title="Bu klasörü Python Motoruna aktar ve derin analiz / birleştirme yap"
                  >
                    <Terminal className="w-3 h-3 text-indigo-500" />
                    Python ile Tara
                  </button>
                </div>
              </div>

              {/* Subfolders horizontal scroll */}
              {realSubfolders.length > 0
                ? (
                  <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin">
                    {realSubfolders.map((sf) => (
                      <button
                        key={sf.path}
                        onClick={() => changeDirectory(sf.path)}
                        className="group px-2.5 py-1.5 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121c2e] hover:border-cyan-500/50 hover:bg-cyan-500/5 transition flex items-center gap-2 shrink-0 text-left shadow-2xs"
                        title={`${sf.path} içine gir ve tara`}
                      >
                        <Folder className="w-4 h-4 text-amber-500 group-hover:scale-110 transition-transform shrink-0" />
                        <div className="min-w-0 max-w-[170px]">
                          <div className="text-xs font-semibold text-slate-800 dark:text-gray-200 truncate group-hover:text-cyan-600 dark:group-hover:text-cyan-300">
                            {sf.name}
                          </div>
                          <div className="text-[10px] text-slate-400 dark:text-gray-500 font-mono">
                            {sf.fileCount} öğe
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )
                : (
                  <div className="text-[11px] text-slate-400 dark:text-gray-500 italic py-0.5">
                    Bu dizinde doğrudan alt klasör bulunmuyor, dosyalar aşağıda
                    listeleniyor.
                  </div>
                )}
            </div>

            {/* Content Display: Files Grid / Table */}
            <div className="flex-1 p-4 overflow-y-auto">
              {loading
                ? (
                  <div className="h-full flex items-center justify-center flex-col gap-3 text-slate-500 dark:text-gray-400">
                    <RefreshCw className="w-8 h-8 animate-spin text-indigo-500" />
                    <p className="text-xs">
                      Dizin taranıyor ve semantik kümeler analiz ediliyor...
                    </p>
                  </div>
                )
                : filteredFiles.length === 0
                ? (
                  <div className="h-full flex items-center justify-center flex-col gap-2 text-slate-400 dark:text-gray-500">
                    <FolderOpen className="w-12 h-12 stroke-[1.5]" />
                    <p className="text-sm font-medium">
                      Eşleşen dosya bulunamadı.
                    </p>
                    <p className="text-xs text-slate-400 dark:text-gray-600">
                      Arama kriterlerini veya seçili filtreyi temizleyin.
                    </p>
                  </div>
                )
                : viewMode === "grid"
                ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                    {filteredFiles.map((file) => (
                      <div
                        key={file.path}
                        onClick={() => setSelectedFile(file)}
                        onDoubleClick={() => {
                          if (file.isDirectory) {
                            changeDirectory(file.path);
                          } else {
                            api.openFile(file.path);
                          }
                        }}
                        className={`p-3 rounded-xl border transition-all cursor-pointer flex flex-col justify-between group hover:shadow-md ${
                          selectedFile?.path === file.path
                            ? "bg-indigo-50 dark:bg-indigo-950/40 border-indigo-500 shadow-indigo-500/10"
                            : "bg-white dark:bg-[#12192d] border-slate-200 dark:border-white/5 hover:border-indigo-300 dark:hover:border-white/20"
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            {file.isDirectory
                              ? <Folder className="w-7 h-7 text-amber-500" />
                              : (
                                getFileIcon(file.ext)
                              )}
                            {file.isDirectory
                              ? (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    changeDirectory(file.path);
                                  }}
                                  className="text-[10px] px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-800 hover:bg-amber-100 font-semibold"
                                  title="Bu Klasörün İçine Gir ve Tara"
                                >
                                  İçeri Gir →
                                </button>
                              )
                              : (
                                <span className="text-[10px] text-slate-400 dark:text-gray-400 font-mono">
                                  {file.ext.toUpperCase()}
                                </span>
                              )}
                          </div>
                          <p className="font-semibold text-xs text-slate-800 dark:text-gray-200 line-clamp-2 leading-snug group-hover:text-indigo-600 dark:group-hover:text-white transition">
                            {file.cleanName}
                          </p>
                        </div>

                        <div className="mt-3 pt-2 border-t border-slate-100 dark:border-white/5">
                          <div className="flex items-center justify-between text-[10px] text-slate-400 dark:text-gray-400 mb-1.5">
                            <span>
                              {file.isDirectory
                                ? "Dizin"
                                : formatBytes(file.size)}
                            </span>
                          </div>
                          {/* File Tags */}
                          <div className="flex flex-wrap gap-1">
                            {file.tags.slice(0, 3).map((t) => (
                              <span
                                key={t}
                                className={`text-[9px] px-1.5 py-0.2 rounded border font-medium ${
                                  getTagClass(t, theme)
                                }`}
                              >
                                #{t}
                              </span>
                            ))}
                            {file.tags.length > 3 && (
                              <span className="text-[9px] text-slate-400 dark:text-gray-500 font-mono">
                                +{file.tags.length - 3}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
                : (
                  <div className="border border-slate-200 dark:border-white/10 rounded-xl overflow-hidden bg-white dark:bg-[#12192d] shadow-xs">
                    <table className="w-full text-left text-xs text-slate-700 dark:text-gray-300">
                      <thead className="bg-slate-50 dark:bg-[#172033] text-slate-500 dark:text-gray-400 border-b border-slate-200 dark:border-white/10 uppercase text-[10px] tracking-wider font-semibold">
                        <tr>
                          <th className="py-2.5 px-3">Dosya Adı</th>
                          <th className="py-2.5 px-3">Etiketler</th>
                          <th className="py-2.5 px-3">Tür</th>
                          <th className="py-2.5 px-3">Boyut</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                        {filteredFiles.map((file) => (
                          <tr
                            key={file.path}
                            onClick={() => setSelectedFile(file)}
                            onDoubleClick={() => {
                              if (file.isDirectory) changeDirectory(file.path);
                              else api.openFile(file.path);
                            }}
                            className={`hover:bg-slate-50 dark:hover:bg-white/5 cursor-pointer transition ${
                              selectedFile?.path === file.path
                                ? "bg-indigo-50 dark:bg-indigo-950/30"
                                : ""
                            }`}
                          >
                            <td className="py-2 px-3 flex items-center justify-between font-medium text-slate-900 dark:text-white">
                              <div className="flex items-center gap-2 truncate max-w-md">
                                {file.isDirectory
                                  ? (
                                    <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                                  )
                                  : (
                                    <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                                  )}
                                <span className="truncate">{file.name}</span>
                              </div>
                              {file.isDirectory && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    changeDirectory(file.path);
                                  }}
                                  className="text-[10px] px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 border border-amber-300 hover:bg-amber-100"
                                >
                                  Aç →
                                </button>
                              )}
                            </td>
                            <td className="py-2 px-3">
                              <div className="flex gap-1">
                                {file.tags.map((t) => (
                                  <span
                                    key={t}
                                    className={`text-[10px] px-1.5 rounded border ${
                                      getTagClass(t, theme)
                                    }`}
                                  >
                                    #{t}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="py-2 px-3 text-slate-400 dark:text-gray-400 uppercase font-mono">
                              {file.ext || "DİZİN"}
                            </td>
                            <td className="py-2 px-3 text-slate-400 dark:text-gray-400">
                              {file.isDirectory ? "-" : formatBytes(file.size)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>
          </main>

          {/* Right Detail Sidebar */}
          {selectedFile && (
            <aside className="w-72 border-l border-slate-200 dark:border-white/10 bg-white dark:bg-[#0c1222] p-4 flex flex-col justify-between overflow-y-auto shadow-sm">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-white/10">
                  <h3 className="font-bold text-xs text-slate-900 dark:text-white flex items-center gap-1.5">
                    <Eye className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                    Dosya Detayları
                  </h3>
                  <button
                    onClick={() => setSelectedFile(null)}
                    className="text-slate-400 hover:text-slate-700 dark:hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="mt-4 flex flex-col items-center p-4 bg-slate-50 dark:bg-[#141b2d] rounded-xl border border-slate-200 dark:border-white/5">
                  {selectedFile.isDirectory
                    ? <Folder className="w-12 h-12 text-amber-500" />
                    : (
                      getFileIcon(selectedFile.ext)
                    )}
                  <p className="font-semibold text-xs text-center mt-2 text-slate-900 dark:text-white break-all">
                    {selectedFile.cleanName}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-gray-400 mt-1">
                    {selectedFile.isDirectory
                      ? "Dizin"
                      : formatBytes(selectedFile.size)}
                  </p>
                </div>

                <div className="mt-4 space-y-2 text-xs">
                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-gray-400">
                      Tam Yol
                    </span>
                    <p className="font-mono text-[11px] text-slate-700 dark:text-gray-300 break-all bg-slate-100 dark:bg-black/30 p-2 rounded-lg border border-slate-200 dark:border-white/5 mt-1 select-all">
                      {selectedFile.path}
                    </p>
                  </div>
                </div>

                {/* Tag Manager for File */}
                <div className="mt-5">
                  <div className="text-[10px] font-bold text-slate-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
                    Etiketleri Yönet
                  </div>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {selectedFile.tags.map((t) => (
                      <span
                        key={t}
                        className={`text-[11px] px-2 py-0.5 rounded-full border flex items-center gap-1 font-medium ${
                          getTagClass(t, theme)
                        }`}
                      >
                        #{t}
                        <button
                          onClick={() => handleRemoveTag(selectedFile, t)}
                          className="hover:text-red-500 ml-0.5"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={newTagInput}
                      onChange={(e) => setNewTagInput(e.target.value)}
                      placeholder="Yeni etiket (örn: ihale, 2026)"
                      className="flex-1 bg-slate-100 dark:bg-[#182234] border border-slate-200 dark:border-white/10 rounded-lg px-2.5 py-1 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500"
                      onKeyDown={(e) =>
                        e.key === "Enter" && handleAddTag(selectedFile)}
                    />
                    <button
                      onClick={() => handleAddTag(selectedFile)}
                      className="px-2.5 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold shadow-xs"
                    >
                      Ekle
                    </button>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="pt-4 border-t border-slate-200 dark:border-white/10 space-y-2">
                <button
                  onClick={() => {
                    if (selectedFile.isDirectory) {
                      changeDirectory(selectedFile.path);
                    } else api.openFile(selectedFile.path);
                  }}
                  className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 shadow-md shadow-indigo-600/20"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  {selectedFile.isDirectory
                    ? "Dizini Aç ve Tara"
                    : "Dosyayı Aç"}
                </button>
                <button
                  onClick={() => api.showInFolder(selectedFile.path)}
                  className="w-full py-2 bg-slate-100 dark:bg-[#1b253b] hover:bg-slate-200 dark:hover:bg-[#222e49] text-slate-700 dark:text-gray-300 rounded-lg text-xs font-medium flex items-center justify-center gap-2 border border-slate-200 dark:border-white/5"
                >
                  <Folder className="w-3.5 h-3.5" />
                  Klasörde Göster
                </button>
              </div>
            </aside>
          )}
        </div>
      )}

      {/* Tab 2: Python Runner Engine with Interactive Source & Target Folder Configuration */}
      {activeTab === "runner" && (
        <div className="flex-1 flex flex-col p-6 overflow-hidden bg-slate-100 dark:bg-[#07090e]">
          {/* Dynamic Folder & Scheme Configuration Card */}
          <div className="p-4 rounded-2xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121929] mb-4 shadow-sm">
            <div className="flex items-center justify-between mb-3 border-b border-slate-100 dark:border-white/5 pb-2">
              <h3 className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-2">
                <Settings2 className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                Dinamik Klasör & Aktarım Yapılandırması
              </h3>
              <span className="text-[11px] text-slate-500 dark:text-gray-400">
                Herhangi bir sürücü veya klasörü seçip anında taratın ve
                birleştirin
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Source Folder Picker */}
              <div>
                <label className="text-[11px] font-bold text-slate-600 dark:text-gray-300 uppercase tracking-wider mb-1 flex items-center justify-between">
                  <span>1. Taranacak Kaynak Klasör (--kaynak)</span>
                  <button
                    onClick={() => setRunnerSourceDir(baseDir)}
                    className="text-[10px] text-indigo-600 dark:text-indigo-400 font-semibold hover:underline"
                  >
                    Aktif Gezgin Dizinini Kullan
                  </button>
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={runnerSourceDir}
                    onChange={(e) => setRunnerSourceDir(e.target.value)}
                    placeholder="Örn: E:\ veya D:\ham_dosyalar"
                    className="flex-1 bg-slate-50 dark:bg-[#162138] border border-slate-200 dark:border-white/10 rounded-xl px-3 py-1.5 text-xs text-slate-900 dark:text-white font-mono focus:outline-none focus:border-cyan-500"
                  />
                  <button
                    onClick={handleSelectRunnerSource}
                    className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-semibold flex items-center gap-1 shadow-xs"
                    title="Kaynak Klasörü Seç"
                  >
                    <FolderSearch className="w-3.5 h-3.5" />
                    Seç
                  </button>
                </div>
                {/* Source Quick Drive Selection */}
                <div className="flex items-center gap-1 mt-1.5">
                  <span className="text-[10px] text-slate-400 dark:text-gray-500">Hızlı:</span>
                  {systemDrives.map((d) => (
                    <button
                      key={'src-' + d.path}
                      onClick={() => setRunnerSourceDir(d.path)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${
                        runnerSourceDir.toLowerCase().startsWith(d.letter.toLowerCase() + ':')
                          ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40 font-bold'
                          : 'border-slate-200 dark:border-white/10 text-slate-500 hover:bg-white/5'
                      }`}
                    >
                      {d.letter}:
                    </button>
                  ))}
                </div>
              </div>

              {/* Target Folder Picker */}
              <div>
                <label className="text-[11px] font-bold text-slate-600 dark:text-gray-300 uppercase tracking-wider mb-1 flex items-center justify-between">
                  <span>2. Hedef Düzenli Arşiv Dizini (--hedef)</span>
                  <button
                    onClick={() => setRunnerTargetDir("D:\\E_BIRLESTIRME")}
                    className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold hover:underline"
                  >
                    D:\E_BIRLESTIRME Sıfırla
                  </button>
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={runnerTargetDir}
                    onChange={(e) => setRunnerTargetDir(e.target.value)}
                    placeholder="Örn: D:\E_BIRLESTIRME veya D:\Arsiv_Son"
                    className="flex-1 bg-slate-50 dark:bg-[#162138] border border-slate-200 dark:border-white/10 rounded-xl px-3 py-1.5 text-xs text-slate-900 dark:text-white font-mono focus:outline-none focus:border-amber-500"
                  />
                  <button
                    onClick={handleSelectRunnerTarget}
                    className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-xl text-xs font-semibold flex items-center gap-1 shadow-xs"
                    title="Hedef Klasörü Seç"
                  >
                    <FolderSearch className="w-3.5 h-3.5" />
                    Seç
                  </button>
                </div>
                {/* Target Quick Drive Selection */}
                <div className="flex items-center gap-1 mt-1.5">
                  <span className="text-[10px] text-slate-400 dark:text-gray-500">Hızlı:</span>
                  {systemDrives.map((d) => (
                    <button
                      key={'tgt-' + d.path}
                      onClick={() => setRunnerTargetDir(d.path)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${
                        runnerTargetDir.toLowerCase().startsWith(d.letter.toLowerCase() + ':')
                          ? 'bg-amber-500/20 text-amber-400 border-amber-500/40 font-bold'
                          : 'border-slate-200 dark:border-white/10 text-slate-500 hover:bg-white/5'
                      }`}
                    >
                      {d.letter}:
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Scheme Selector */}
            <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-white/5 flex items-center justify-between flex-wrap gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-700 dark:text-gray-300">
                  Birleştirme Düzeni:
                </span>
                <select
                  value={runnerScheme}
                  onChange={(e) => setRunnerScheme(e.target.value)}
                  className="bg-slate-100 dark:bg-[#162138] border border-slate-200 dark:border-white/10 rounded-lg px-2.5 py-1 text-xs text-slate-900 dark:text-white font-medium focus:outline-none focus:border-indigo-500"
                >
                  <option value="konu-tip">
                    Konu ve Dosya Tipine Göre (00..11 Klasörleri - Önerilen)
                  </option>
                  <option value="konu">Sadece Konu Klasörleri (00..11)</option>
                  <option value="tip">
                    Sadece Dosya Uzantı / Tür Kümeleri
                  </option>
                  <option value="duz">Tek Klasör Düz Aktarım</option>
                </select>
              </div>

              <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-gray-400 font-mono">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                <span>
                  SHA-256 Mükerrer Eleme ve Windows 220 MAX_PATH Koruması Aktif
                </span>
              </div>
            </div>
          </div>

          {/* Quick Script Action Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            {/* Card 1: Scanner */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121929] flex flex-col justify-between shadow-xs">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-sm text-cyan-600 dark:text-cyan-300 flex items-center gap-2">
                    <Search className="w-4 h-4" /> 1. Mükerrer & Boyut Tarama
                  </span>
                  <span className="text-[10px] font-mono text-slate-500 dark:text-gray-400">
                    scanner.py
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-gray-400 leading-relaxed">
                  Seçili kaynak dizini
                  (<b className="font-mono text-cyan-600 dark:text-cyan-300 truncate inline-block max-w-[140px] align-bottom">
                    {runnerSourceDir}
                  </b>) tarar, birebir eşleşen kopyaların SHA-256 hash raporunu
                  çıkarır.
                </p>
              </div>
              <button
                disabled={!!runningTaskId}
                onClick={() =>
                  runScript("scanner", "scanner.py", [runnerSourceDir])}
                className="mt-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 shadow-md shadow-cyan-600/20"
              >
                <Play className="w-3.5 h-3.5" /> Seçili Dizini Tara
              </button>
            </div>

            {/* Card 2: Simulation */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121929] flex flex-col justify-between shadow-xs">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-sm text-indigo-600 dark:text-indigo-300 flex items-center gap-2">
                    <Layers className="w-4 h-4" /> 2. Güvenli Simülasyon
                  </span>
                  <span className="text-[10px] font-mono text-slate-500 dark:text-gray-400">
                    --onizleme
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-gray-400 leading-relaxed">
                  Dosyaları taşımadan/silmeden, seçili kaynak ile hedef
                  arasındaki aktarım planını ve kısaltılacak yolları simüle
                  eder.
                </p>
              </div>
              <button
                disabled={!!runningTaskId}
                onClick={() =>
                  runScript("simulasyon", "birlestir.py", [
                    "faz1",
                    "--kaynak",
                    runnerSourceDir,
                    "--hedef",
                    runnerTargetDir,
                    "--duzen",
                    runnerScheme,
                    "--onizleme",
                  ])}
                className="mt-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 shadow-md shadow-indigo-600/20"
              >
                <Play className="w-3.5 h-3.5" /> Simülasyonu Başlat
              </button>
            </div>

            {/* Card 3: Actual Merge */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121929] flex flex-col justify-between shadow-xs">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-sm text-amber-600 dark:text-amber-300 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4" /> 3. Gerçek Birleştirme
                  </span>
                  <span className="text-[10px] font-mono text-slate-500 dark:text-gray-400">
                    --uygula
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-gray-400 leading-relaxed">
                  Seçilen kaynaktan hedefe
                  (<b className="font-mono text-amber-600 dark:text-amber-300 truncate inline-block max-w-[140px] align-bottom">
                    {runnerTargetDir}
                  </b>) mükerrerleri atlayıp benzersiz dosyaları düzenli
                  aktarır.
                </p>
              </div>
              <button
                disabled={!!runningTaskId}
                onClick={() =>
                  runScript("birlestir", "birlestir.py", [
                    "faz1",
                    "--kaynak",
                    runnerSourceDir,
                    "--hedef",
                    runnerTargetDir,
                    "--duzen",
                    runnerScheme,
                    "--uygula",
                    "--hash-cache",
                    "duplicate_report.json",
                  ])}
                className="mt-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 shadow-md shadow-amber-600/20"
              >
                <Play className="w-3.5 h-3.5" /> Gerçek Aktarımı Başlat
              </button>
            </div>
          </div>

          {/* Terminal Box */}
          <div className="flex-1 flex flex-col rounded-xl border border-slate-700 bg-[#07090e] text-slate-200 overflow-hidden shadow-2xl">
            <div className="h-10 border-b border-slate-800 bg-[#0e131d] px-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-mono text-gray-300 font-bold">
                  Canlı Python Konsolu
                </span>
                {runningTaskId
                  ? (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold animate-pulse">
                      ÇALIŞIYOR ({runningTaskId})
                    </span>
                  )
                  : (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-gray-400">
                      BOŞTA
                    </span>
                  )}
              </div>
              <div className="flex items-center gap-2">
                {runningTaskId && (
                  <button
                    onClick={() => stopScript(runningTaskId)}
                    className="px-2.5 py-1 bg-red-600 hover:bg-red-500 text-white rounded-lg text-[11px] font-semibold flex items-center gap-1"
                  >
                    <Square className="w-3 h-3" /> Durdur
                  </button>
                )}
                <button
                  onClick={() => setTerminalLogs([])}
                  className="px-2.5 py-1 text-gray-400 hover:text-white rounded-lg text-[11px]"
                >
                  Temizle
                </button>
              </div>
            </div>

            <div className="flex-1 p-4 overflow-y-auto font-mono text-xs text-gray-200 select-text leading-relaxed whitespace-pre-wrap terminal-scroll">
              {terminalLogs.length === 0
                ? (
                  <span className="text-gray-600 italic">
                    Yukarıdaki butonlardan bir betik başlatın...
                  </span>
                )
                : (
                  terminalLogs.join("")
                )}
              <div ref={terminalEndRef} />
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Reports & Analysis */}
      {activeTab === "reports" && (
        <div className="flex-1 p-6 overflow-y-auto bg-slate-50 dark:bg-[#080c18] transition-colors">
          <div className="max-w-5xl mx-auto space-y-6">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <BarChart2 className="w-5 h-5 text-indigo-500" />
              Sistem Analiz ve Göç Raporları
            </h2>

            {/* Quick Stats Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121929] shadow-xs">
                <span className="text-[11px] font-bold text-slate-500 dark:text-gray-400 uppercase">
                  Taranan Toplam Dosya
                </span>
                <p className="text-2xl font-black text-cyan-600 dark:text-cyan-400 mt-1 font-mono">
                  {reports?.duplicate?.summary?.total_files_scanned ||
                    reports?.migration?.summary?.total_files_scanned || "6.429"}
                </p>
                <span className="text-[11px] text-slate-400 dark:text-gray-500">
                  Kaynak Dizin ({runnerSourceDir})
                </span>
              </div>

              <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121929] shadow-xs">
                <span className="text-[11px] font-bold text-slate-500 dark:text-gray-400 uppercase">
                  Mükerrer Dosya Grubu
                </span>
                <p className="text-2xl font-black text-amber-600 dark:text-amber-400 mt-1 font-mono">
                  {reports?.duplicate?.summary?.duplicate_groups_count || "737"}
                </p>
                <span className="text-[11px] text-slate-400 dark:text-gray-500">
                  Birebir aynı içerik
                </span>
              </div>

              <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121929] shadow-xs">
                <span className="text-[11px] font-bold text-slate-500 dark:text-gray-400 uppercase">
                  Kurtarılan Alan
                </span>
                <p className="text-2xl font-black text-emerald-600 dark:text-emerald-400 mt-1 font-mono">
                  {reports?.duplicate?.summary?.total_wasted_formatted ||
                    "2.09 GB"}
                </p>
                <span className="text-[11px] text-slate-400 dark:text-gray-500">
                  Tekilleştirme tasarrufu
                </span>
              </div>

              <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121929] shadow-xs">
                <span className="text-[11px] font-bold text-slate-500 dark:text-gray-400 uppercase">
                  Kısaltılan Uzun Yollar
                </span>
                <p className="text-2xl font-black text-rose-600 dark:text-rose-400 mt-1 font-mono">
                  {reports?.migration?.summary?.shortened_paths_count || "286"}
                </p>
                <span className="text-[11px] text-slate-400 dark:text-gray-500">
                  Windows MAX_PATH koruması
                </span>
              </div>
            </div>

            {/* Dynamic Semantic Keywords Cloud */}
            <div className="p-5 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121929] shadow-xs">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-cyan-500" />
                  Dinamik İsim Semantiği & Kelime Frekans Dağılımı
                </h3>
                <span className="text-[11px] text-slate-500 dark:text-gray-400 font-mono">
                  {analysis.topKeywords.length} anahtar küme
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-gray-400 mb-4">
                Dosya isimlerinden otomatik olarak ayrıştırılan en belirgin
                kelime ve proje anahtarları:
              </p>
              <div className="flex flex-wrap gap-2">
                {analysis.topKeywords.map((kw) => (
                  <span
                    key={kw.word}
                    className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-black/40 border border-slate-200 dark:border-white/10 text-xs text-slate-800 dark:text-gray-300 flex items-center gap-1.5"
                  >
                    <span className="font-semibold text-cyan-700 dark:text-cyan-300">
                      {kw.word}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-200 dark:bg-white/10 text-slate-600 dark:text-gray-400 font-mono">
                      {kw.count}
                    </span>
                  </span>
                ))}
              </div>
            </div>

            {/* Topic Structure Overview */}
            <div className="p-5 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121929] shadow-xs">
              <h3 className="font-bold text-sm text-slate-900 dark:text-white mb-3 flex items-center gap-2">
                <Folder className="w-4 h-4 text-indigo-500" />
                Hedef Konu Klasör Yapısı ({runnerTargetDir})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {PRESET_MUNICIPAL_TOPICS.map((t) => (
                  <div
                    key={t}
                    className="p-2.5 rounded-lg bg-slate-50 dark:bg-black/30 border border-slate-200 dark:border-white/5 flex items-center gap-2"
                  >
                    <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                    <span className="font-mono text-xs text-slate-700 dark:text-gray-300 truncate">
                      {t}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
