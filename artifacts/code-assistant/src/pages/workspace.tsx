import { useState, useRef, useEffect, useCallback, useReducer } from "react";
import { SandpackLivePreview } from "@/components/sandpack-preview";
import { ShellPanel } from "@/components/shell-panel";
import { PaymentModal } from "@/components/payment-modal";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListProjects,
  getListProjectsQueryKey,
  useCreateProject,
  useGetProject,
  getGetProjectQueryKey,
  useDeleteProject,
  useUpdateFile,
  useDeleteFile,
} from "@workspace/api-client-react";
import type { ProjectFile, ProjectMessage } from "@workspace/api-client-react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface SecretRequest { key: string; description: string; }

interface StreamEvent {
  content?: string;
  tool_call?: { name: string; args: Record<string, string> };
  tool_result?: { name: string; result: string };
  request_secrets?: { secrets: SecretRequest[] };
  done?: boolean;
  error?: string;
}

interface CloneEvent {
  type: "status" | "progress" | "done" | "error";
  step?: number;
  message?: string;
  imported?: number;
  total?: number;
  projectId?: number;
  filesImported?: number;
  name?: string;
  repo?: string;
}

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { name: string; args: Record<string, string>; result?: string }[];
  streaming?: boolean;
}

interface TreeNode {
  type: "file" | "folder";
  name: string;
  fullPath: string;
  children: TreeNode[];
  file?: ProjectFile;
}

type MobilePanel = "projects" | "files" | "chat" | "editor" | "preview" | "shell";

// ─── Constants ────────────────────────────────────────────────────────────────
const FREE_MODEL_ID    = "deepseek/deepseek-chat-v3-0324";
const FREE_MSG_LIMIT   = 3;

const MODELS = [
  { id: FREE_MODEL_ID,                     label: "DeepSeek V3",    color: "#e0af68", power: 2, free: true  },
  { id: "anthropic/claude-sonnet-4-5",    label: "Sonnet 4.5",     color: "#9ece6a", power: 3, free: false },
  { id: "anthropic/claude-opus-4-5",       label: "Claude Opus 4.5",color: "#7aa2f7", power: 4, free: false },
  { id: "anthropic/claude-opus-4",        label: "Opus 4",         color: "#bb9af7", power: 5, free: false },
];

function ModelPowerDots({ power, color }: { power: number; color: string }) {
  return (
    <span className="inline-flex items-center gap-[2px]" title={`Kuchi: ${power}/5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} className="w-[3px] h-[3px] rounded-full" style={{ background: i < power ? color : "#2a2a3a" }} />
      ))}
    </span>
  );
}

const TOOL_LABELS: Record<string, string> = {
  create_file:      "Fayl yaratildi",
  update_file:      "Fayl yangilandi",
  delete_file:      "Fayl o'chirildi",
  read_file:        "Fayl o'qildi",
  list_files:       "Fayllar ro'yxati",
  run_command:      "Buyruq bajarildi",
  start_app:        "Ilova ishga tushirildi",
  stop_app:         "Ilova to'xtatildi",
  request_secrets:  "Secrets so'ralmoqda…",
};

function parseRunResult(name: string, result?: string): "success" | "error" | "timeout" | "pending" | "other" {
  if (!result) return "pending";
  if (name !== "run_command") return "other";
  if (result.startsWith("[SUCCESS]")) return "success";
  if (result.startsWith("[ERROR:")) return "error";
  if (result.includes("avtomatik to'xtatildi")) return "timeout";
  return "other";
}

const EXT_COLORS: Record<string, string> = {
  ts: "#3178c6", tsx: "#3178c6", js: "#f7df1e", jsx: "#61dafb",
  html: "#e34c26", css: "#264de4", json: "#cbcb41", md: "#7aa2f7",
  py: "#3572a5", rs: "#f74c00", go: "#00acd7", sh: "#89e051",
  svg: "#f48024", yml: "#cb171e", yaml: "#cb171e",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function FileIcon({ path, size = "sm" }: { path: string; size?: "sm" | "xs" }) {
  const ext = path.split(".").pop() ?? "";
  const color = EXT_COLORS[ext] ?? "#6e7191";
  const s = size === "xs" ? "text-[9px]" : "text-[10px]";
  return <span style={{ color }} className={`${s} font-mono flex-shrink-0`}>.{ext || "?"}</span>;
}

function buildTree(files: ProjectFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folderMap = new Map<string, TreeNode>();
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sorted) {
    const parts = file.path.split("/");
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const folderPath = parts.slice(0, i + 1).join("/");
      if (!folderMap.has(folderPath)) {
        const node: TreeNode = { type: "folder", name: parts[i], fullPath: folderPath, children: [] };
        folderMap.set(folderPath, node);
        current.push(node);
      }
      current = folderMap.get(folderPath)!.children;
    }
    current.push({ type: "file", name: parts[parts.length - 1], fullPath: file.path, children: [], file });
  }

  function sort(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.type === "folder") sort(n.children);
  }
  sort(root);
  return root;
}

// ─── Code renderer ────────────────────────────────────────────────────────────
function CodeBlock({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const lines = part.slice(3).split("\n");
          const lang = lines[0];
          const code = lines.slice(1).join("\n").replace(/```$/, "");
          return (
            <div key={i} className="my-2 rounded-lg overflow-hidden border border-[#2a2a3a] text-xs">
              {lang && <div className="px-3 py-1 bg-[#12121e] text-[#6e7191] font-mono border-b border-[#2a2a3a]">{lang}</div>}
              <pre className="p-3 bg-[#0d0d1a] text-[#a9b1d6] font-mono overflow-x-auto leading-relaxed"><code>{code}</code></pre>
            </div>
          );
        }
        return <span key={i} className="whitespace-pre-wrap">{part}</span>;
      })}
    </>
  );
}

// ─── New Project Modal ────────────────────────────────────────────────────────
function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number, options?: { fromGithub?: boolean }) => void }) {
  const [tab, setTab] = useState<"empty" | "github">("empty");
  const [name, setName] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cloneSteps, setCloneSteps] = useState<string[]>([]);
  const [cloneProgress, setCloneProgress] = useState<{ imported: number; total: number } | null>(null);
  const createProject = useCreateProject();
  const queryClient = useQueryClient();

  const handleCreateEmpty = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      const p = await createProject.mutateAsync({ data: { name: name.trim() } });
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      onCreated(p.id);
    } finally {
      setLoading(false);
    }
  };

  const handleClone = async () => {
    if (!githubUrl.trim()) return;
    setLoading(true);
    setError("");
    setCloneSteps([]);
    setCloneProgress(null);
    try {
      const res = await fetch("/api/projects/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUrl: githubUrl.trim(), name: name.trim() || undefined }),
      });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev: CloneEvent = JSON.parse(line.slice(6));
            if (ev.type === "status" && ev.message) {
              setCloneSteps((prev) => [...prev, ev.message!]);
            } else if (ev.type === "progress" && ev.imported !== undefined && ev.total !== undefined) {
              setCloneProgress({ imported: ev.imported, total: ev.total });
            } else if (ev.type === "done" && ev.projectId) {
              queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
              setCloneSteps((prev) => [...prev, `✅ Tayyor! ${ev.filesImported} ta fayl import qilindi.`]);
              setTimeout(() => onCreated(ev.projectId!, { fromGithub: true }), 600);
            } else if (ev.type === "error" && ev.message) {
              setError(ev.message);
              setLoading(false);
            }
          } catch {}
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tarmoq xatosi");
      setLoading(false);
    }
  };

  const isCloning = loading && tab === "github";

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full sm:w-[420px] bg-[#0d0d1a] border border-[#2a2a3a] rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 pb-8 sm:pb-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#c0caf5]">Yangi Loyiha</h2>
          {!isCloning && (
            <button onClick={onClose} className="text-[#565f89] hover:text-[#c0caf5] text-xl w-8 h-8 flex items-center justify-center">×</button>
          )}
        </div>
        {!isCloning && (
          <div className="flex gap-1 mb-4 bg-[#0a0a14] rounded-lg p-1">
            <button onClick={() => setTab("empty")} className={`flex-1 py-2 text-xs rounded-md font-medium transition-colors ${tab === "empty" ? "bg-[#7aa2f7] text-[#0d0d1a]" : "text-[#565f89] hover:text-[#a9b1d6]"}`}>📄 Bo'sh loyiha</button>
            <button onClick={() => setTab("github")} className={`flex-1 py-2 text-xs rounded-md font-medium transition-colors ${tab === "github" ? "bg-[#7aa2f7] text-[#0d0d1a]" : "text-[#565f89] hover:text-[#a9b1d6]"}`}>🐙 GitHub</button>
          </div>
        )}
        {isCloning && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-medium text-[#7aa2f7]">🐙 GitHub'dan klonlanmoqda...</span>
            </div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {cloneSteps.map((step, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className="text-[#4a9e6b] mt-0.5 flex-shrink-0">{step.startsWith("✅") ? "✅" : "▸"}</span>
                  <span className={step.startsWith("✅") ? "text-[#9ece6a]" : "text-[#a9b1d6]"}>{step.startsWith("✅") ? step.slice(3) : step}</span>
                </div>
              ))}
              {cloneSteps.length === 0 && (
                <div className="flex items-center gap-2 text-xs text-[#565f89]">
                  <span className="w-3 h-3 border border-[#7aa2f7] border-t-transparent rounded-full animate-spin" />Boshlanmoqda...
                </div>
              )}
            </div>
            {cloneProgress && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-[#565f89]">
                  <span>Fayllar import qilinmoqda</span><span>{cloneProgress.imported} / {cloneProgress.total}</span>
                </div>
                <div className="h-1.5 bg-[#1a1a2e] rounded-full overflow-hidden">
                  <div className="h-full bg-[#7aa2f7] rounded-full transition-all duration-300" style={{ width: `${(cloneProgress.imported / cloneProgress.total) * 100}%` }} />
                </div>
              </div>
            )}
          </div>
        )}
        {!isCloning && tab === "empty" && (
          <div className="space-y-3">
            <input autoFocus className="w-full px-3 py-2.5 text-sm bg-[#1a1a2e] border border-[#2a2a3a] focus:border-[#7aa2f7]/60 rounded-lg text-[#c0caf5] placeholder-[#565f89] outline-none"
              placeholder="Loyiha nomi" value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateEmpty(); if (e.key === "Escape") onClose(); }} />
            <button onClick={handleCreateEmpty} disabled={!name.trim() || loading}
              className="w-full py-2.5 text-sm bg-[#7aa2f7] text-[#0d0d1a] rounded-lg font-semibold hover:bg-[#89b4fa] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {loading ? "Yaratilmoqda…" : "Loyiha yaratish"}
            </button>
          </div>
        )}
        {!isCloning && tab === "github" && (
          <div className="space-y-3">
            <input autoFocus
              className="w-full px-3 py-2.5 text-sm bg-[#1a1a2e] border border-[#2a2a3a] focus:border-[#7aa2f7]/60 rounded-lg text-[#c0caf5] placeholder-[#565f89] outline-none font-mono"
              placeholder="https://github.com/foydalanuvchi/loyiha" value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleClone(); if (e.key === "Escape") onClose(); }} />
            <input className="w-full px-3 py-2.5 text-sm bg-[#1a1a2e] border border-[#2a2a3a] focus:border-[#7aa2f7]/60 rounded-lg text-[#c0caf5] placeholder-[#565f89] outline-none"
              placeholder="Loyiha nomi (ixtiyoriy)" value={name} onChange={(e) => setName(e.target.value)} />
            {error && <div className="px-3 py-2 bg-[#f7768e]/10 border border-[#f7768e]/30 rounded-lg text-xs text-[#f7768e]">⚠ {error}</div>}
            <button onClick={handleClone} disabled={!githubUrl.trim() || loading}
              className="w-full py-2.5 text-sm bg-[#7aa2f7] text-[#0d0d1a] rounded-lg font-semibold hover:bg-[#89b4fa] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Klonlash va ochish
            </button>
            <p className="text-xs text-[#3b3f5c] text-center">Faqat public repozitoriyalar qo'llaniladi</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tree Node ────────────────────────────────────────────────────────────────
function TreeNodeRow({
  node, depth, expandedFolders, toggleFolder, selectedFile, onSelectFile,
  onStartRename, onDeleteFile, renamingFileId, renameValue, renameInputRef,
  setRenameValue, onRename, setRenamingFileId,
}: {
  node: TreeNode; depth: number; expandedFolders: Set<string>;
  toggleFolder: (path: string) => void; selectedFile: ProjectFile | null;
  onSelectFile: (f: ProjectFile) => void; onStartRename: (f: ProjectFile, e: React.MouseEvent) => void;
  onDeleteFile: (f: ProjectFile, e: React.MouseEvent) => void; renamingFileId: number | null;
  renameValue: string; renameInputRef: React.RefObject<HTMLInputElement | null>;
  setRenameValue: (v: string) => void; onRename: (f: ProjectFile) => void;
  setRenamingFileId: (id: number | null) => void;
}) {
  const isExpanded = expandedFolders.has(node.fullPath);
  const indent = depth * 12;

  if (node.type === "folder") {
    return (
      <>
        <button onClick={() => toggleFolder(node.fullPath)}
          className="w-full flex items-center gap-1.5 px-2 py-2 hover:bg-[#1a1a2e] rounded-lg transition-colors text-left group"
          style={{ paddingLeft: `${8 + indent}px` }}>
          <svg xmlns="http://www.w3.org/2000/svg" className={`w-3 h-3 flex-shrink-0 text-[#565f89] transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6" /></svg>
          <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill={isExpanded ? "#e0af68" : "none"} stroke="#e0af68" strokeWidth="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
          <span className="text-xs text-[#c0caf5] font-medium truncate">{node.name}</span>
          <span className="ml-auto text-[10px] text-[#3b3f5c] opacity-0 group-hover:opacity-100">{node.children.length}</span>
        </button>
        {isExpanded && node.children.map((child) => (
          <TreeNodeRow key={child.fullPath} node={child} depth={depth + 1} expandedFolders={expandedFolders}
            toggleFolder={toggleFolder} selectedFile={selectedFile} onSelectFile={onSelectFile}
            onStartRename={onStartRename} onDeleteFile={onDeleteFile} renamingFileId={renamingFileId}
            renameValue={renameValue} renameInputRef={renameInputRef} setRenameValue={setRenameValue}
            onRename={onRename} setRenamingFileId={setRenamingFileId} />
        ))}
      </>
    );
  }

  const file = node.file!;
  const isSelected = selectedFile?.id === file.id;
  const isRenaming = renamingFileId === file.id;

  return (
    <div onClick={() => !isRenaming && onSelectFile(file)}
      className={`group flex items-center justify-between px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${isSelected ? "bg-[#7aa2f7]/15 border border-[#7aa2f7]/20" : "hover:bg-[#1a1a2e]"}`}
      style={{ paddingLeft: `${8 + indent}px` }}>
      {isRenaming ? (
        <input ref={renameInputRef}
          className="flex-1 px-2 py-0.5 text-xs bg-[#1a1a2e] border border-[#7aa2f7]/60 rounded text-[#c0caf5] outline-none"
          value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === "Enter") onRename(file); if (e.key === "Escape") setRenamingFileId(null); }}
          onBlur={() => onRename(file)} />
      ) : (
        <>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="w-3 flex-shrink-0 flex justify-center"><span className="w-2 h-px bg-[#2a2a3a]" /></span>
            <FileIcon path={file.path} size="xs" />
            <span className={`text-xs truncate ${isSelected ? "text-[#c0caf5]" : "text-[#a9b1d6]"}`} title={file.path}>{node.name}</span>
          </div>
          <div className="flex opacity-0 group-hover:opacity-100 transition-all gap-0.5 flex-shrink-0 ml-1">
            <button title="Rename" onClick={(e) => { e.stopPropagation(); onStartRename(file, e); }}
              className="w-5 h-5 flex items-center justify-center text-[#565f89] hover:text-[#e0af68] rounded">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button title="Delete" onClick={(e) => { e.stopPropagation(); onDeleteFile(file, e); }}
              className="w-5 h-5 flex items-center justify-center text-[#565f89] hover:text-[#f7768e] rounded text-sm">×</button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Files Panel ──────────────────────────────────────────────────────────────
function FilesPanel({
  files, selectedFile, renamingFileId, renameValue, renameInputRef,
  showNewFile, newFileName, onSelectFile, onStartRename, onRename, onDeleteFile,
  setRenamingFileId, setRenameValue, setShowNewFile, setNewFileName, onCreateFile,
}: {
  files: ProjectFile[]; selectedFile: ProjectFile | null; renamingFileId: number | null;
  renameValue: string; renameInputRef: React.RefObject<HTMLInputElement | null>;
  showNewFile: boolean; newFileName: string; onSelectFile: (f: ProjectFile) => void;
  onStartRename: (f: ProjectFile, e: React.MouseEvent) => void; onRename: (f: ProjectFile) => void;
  onDeleteFile: (f: ProjectFile, e: React.MouseEvent) => void; setRenamingFileId: (id: number | null) => void;
  setRenameValue: (v: string) => void; setShowNewFile: (v: boolean) => void;
  setNewFileName: (v: string) => void; onCreateFile: () => void;
}) {
  const tree = buildTree(files);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    const top = new Set<string>();
    for (const n of tree) { if (n.type === "folder") top.add(n.fullPath); }
    return top;
  });

  const prevFilesLen = useRef(files.length);
  useEffect(() => {
    if (files.length !== prevFilesLen.current) {
      prevFilesLen.current = files.length;
      const t = buildTree(files);
      const top = new Set<string>();
      for (const n of t) { if (n.type === "folder") top.add(n.fullPath); }
      setExpandedFolders(top);
    }
  }, [files.length]);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => { const next = new Set(prev); next.has(path) ? next.delete(path) : next.add(path); return next; });
  }, []);

  return (
    <div className="flex flex-col h-full bg-[#0d0d1a]">
      <div className="px-3 py-2.5 border-b border-[#1e1e2e] flex items-center justify-between">
        <span className="text-xs text-[#565f89] font-medium uppercase tracking-wider">
          Fayllar {files.length > 0 && <span className="text-[#3b3f5c] ml-1">{files.length}</span>}
        </span>
        <button onClick={() => { setShowNewFile(true); setNewFileName(""); }}
          className="w-7 h-7 flex items-center justify-center rounded-md text-[#565f89] hover:text-[#7aa2f7] hover:bg-[#7aa2f7]/10 transition-colors text-lg">+</button>
      </div>
      {showNewFile && (
        <div className="px-3 py-2 border-b border-[#1e1e2e]">
          <input autoFocus
            className="w-full px-3 py-2 text-xs bg-[#1a1a2e] border border-[#7aa2f7]/40 rounded-lg text-[#c0caf5] placeholder-[#565f89] outline-none font-mono"
            placeholder="src/index.html" value={newFileName} onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onCreateFile(); if (e.key === "Escape") setShowNewFile(false); }}
            onBlur={() => { if (!newFileName.trim()) setShowNewFile(false); }} />
        </div>
      )}
      <div className="flex-1 overflow-y-auto py-1 px-1 space-y-0.5">
        {files.length === 0 && !showNewFile ? (
          <p className="text-xs text-[#3b3f5c] text-center py-8 px-3">AI loyiha fayllarini yaratadi</p>
        ) : (
          tree.map((node) => (
            <TreeNodeRow key={node.fullPath} node={node} depth={0} expandedFolders={expandedFolders}
              toggleFolder={toggleFolder} selectedFile={selectedFile} onSelectFile={onSelectFile}
              onStartRename={onStartRename} onDeleteFile={onDeleteFile} renamingFileId={renamingFileId}
              renameValue={renameValue} renameInputRef={renameInputRef} setRenameValue={setRenameValue}
              onRename={onRename} setRenamingFileId={setRenamingFileId} />
          ))
        )}
      </div>
    </div>
  );
}

// ─── User Menu ────────────────────────────────────────────────────────────────
type UserPlanInfo = { plan: string; freeMessagesUsed: number; firstName?: string; lastName?: string; email?: string };

function MenuItem({ icon, label, onClick, disabled, danger }: {
  icon: string; label: string; onClick: () => void; disabled?: boolean; danger?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${danger ? "text-[#f7768e] hover:bg-[#f7768e]/10" : "text-[#a9b1d6] hover:bg-[#1a1a2e]"}`}>
      <span>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {disabled && <span className="text-[10px] text-[#3b3f5c]">tez kunda</span>}
    </button>
  );
}

function UserMenu({ userPlan, onOpenPayment, alignRight }: { userPlan: UserPlanInfo | null; onOpenPayment: () => void; alignRight?: boolean }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const initials = [userPlan?.firstName?.[0], userPlan?.lastName?.[0]].filter(Boolean).join("") || "U";
  const fullName = [userPlan?.firstName, userPlan?.lastName].filter(Boolean).join(" ") || "Foydalanuvchi";
  const isPaid   = userPlan?.plan === "paid";
  const remaining = Math.max(0, FREE_MSG_LIMIT - (userPlan?.freeMessagesUsed ?? 0));

  return (
    <div className="relative" ref={menuRef}>
      <button onClick={() => setOpen(v => !v)}
        className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[#1a1a2e] text-[#565f89] hover:text-[#a9b1d6] transition-colors"
        title="Menyu">
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>

      {open && (
        <div className={`absolute top-full mt-2 w-64 bg-[#0d0d1a] border border-[#2a2a3a] rounded-xl shadow-2xl z-50 overflow-hidden ${alignRight ? "right-0" : "left-0"}`}>

          {/* User card */}
          <div className="px-4 py-3 border-b border-[#1e1e2e]">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[#7aa2f7]/15 border border-[#7aa2f7]/30 flex items-center justify-center flex-shrink-0">
                <span className="text-sm font-bold text-[#7aa2f7]">{initials}</span>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-[#c0caf5] truncate">{fullName}</p>
                {userPlan?.email && <p className="text-[11px] text-[#565f89] truncate">{userPlan.email}</p>}
              </div>
            </div>
            <div className="mt-2">
              {isPaid
                ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#9ece6a]/10 border border-[#9ece6a]/30 text-[10px] font-medium text-[#9ece6a]">✦ Premium</span>
                : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#565f89]/15 border border-[#565f89]/25 text-[10px] text-[#565f89]">Bepul tarif</span>}
            </div>
          </div>

          {/* Usage bar */}
          <div className="px-4 py-3 border-b border-[#1e1e2e]">
            <p className="text-[10px] text-[#565f89] uppercase tracking-wider mb-2">Foydalanish</p>
            {isPaid ? (
              <p className="text-xs text-[#9ece6a] flex items-center gap-1.5"><span>✦</span> Cheksiz xabarlar</p>
            ) : (
              <>
                <div className="flex justify-between text-[11px] mb-1.5">
                  <span className="text-[#a9b1d6]">Bepul xabarlar</span>
                  <span className="font-mono" style={{ color: remaining > 0 ? "#e0af68" : "#f7768e" }}>{remaining}/{FREE_MSG_LIMIT}</span>
                </div>
                <div className="h-1.5 bg-[#1e1e2e] rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{
                    width: `${(remaining / FREE_MSG_LIMIT) * 100}%`,
                    background: remaining > 0 ? "#e0af68" : "#f7768e",
                  }} />
                </div>
              </>
            )}
          </div>

          {/* Premium CTA */}
          {!isPaid && (
            <div className="px-3 py-2.5 border-b border-[#1e1e2e]">
              <button onClick={() => { onOpenPayment(); setOpen(false); }}
                className="w-full py-2 rounded-lg text-xs font-semibold text-[#0d0d1a] transition-opacity hover:opacity-90"
                style={{ background: "linear-gradient(135deg,#7aa2f7,#bb9af7)" }}>
                💎 Premium — barcha modellarni ochish
              </button>
            </div>
          )}

          {/* Nav items */}
          <div className="p-1.5 border-b border-[#1e1e2e]">
            <MenuItem icon="⚙️" label="Sozlamalar" onClick={() => setOpen(false)} disabled />
            <MenuItem icon="📖" label="Qo'llanma / Yordam" onClick={() => { window.open("https://t.me/uzcoder_support", "_blank"); setOpen(false); }} />
            <MenuItem icon="📣" label="Yangiliklar" onClick={() => { window.open("https://t.me/uzcoder_news", "_blank"); setOpen(false); }} />
          </div>

          {/* Logout */}
          <div className="p-1.5">
            <MenuItem icon="🚪" label="Chiqish" danger onClick={() => { window.location.href = "/api/auth/logout"; }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Projects Panel ───────────────────────────────────────────────────────────
function ProjectsPanel({
  projects, activeProjectId, onSelect, onDelete, onNew, activeModelInfo, userPlan, onOpenPayment, mobileMode,
}: {
  projects: { id: number; name: string }[]; activeProjectId: number | null;
  onSelect: (id: number) => void; onDelete: (id: number, e: React.MouseEvent) => void;
  onNew: () => void; activeModelInfo: typeof MODELS[0] | null;
  userPlan: UserPlanInfo | null; onOpenPayment: () => void; mobileMode?: boolean;
}) {
  return (
    <div className="flex flex-col h-full bg-[#0d0d1a]">
      <div className="p-4 border-b border-[#1e1e2e]">
        {!mobileMode && (
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-[#7aa2f7]" />
              <span className="text-xs font-bold tracking-widest text-[#7aa2f7]">UZCODER</span>
            </div>
            <UserMenu userPlan={userPlan} onOpenPayment={onOpenPayment} />
          </div>
        )}
        <button onClick={onNew}
          className="w-full py-2.5 px-3 text-sm bg-[#7aa2f7]/10 hover:bg-[#7aa2f7]/20 border border-[#7aa2f7]/30 rounded-lg text-[#7aa2f7] flex items-center gap-2 transition-colors font-medium">
          <span className="text-base leading-none">+</span> Yangi Loyiha
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {projects.length === 0 ? (
          <p className="text-xs text-[#3b3f5c] text-center py-8">Hali loyiha yo'q</p>
        ) : (
          projects.map((p) => (
            <div key={p.id} onClick={() => onSelect(p.id)}
              className={`group flex items-center justify-between px-3 py-3 rounded-lg cursor-pointer transition-colors ${activeProjectId === p.id ? "bg-[#7aa2f7]/15 border border-[#7aa2f7]/25" : "hover:bg-[#1a1a2e]"}`}>
              <span className="text-sm truncate text-[#a9b1d6]">{p.name}</span>
              <button onClick={(e) => onDelete(p.id, e)} className="opacity-0 group-hover:opacity-100 text-[#565f89] hover:text-[#f7768e] text-lg transition-all w-6 h-6 flex items-center justify-center">×</button>
            </div>
          ))
        )}
      </div>
      <div className="p-4 border-t border-[#1e1e2e]">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ background: activeModelInfo?.color ?? "#565f89" }} />
          <span className="text-xs text-[#565f89]">{activeModelInfo?.label ?? "Model tanlanmagan"}</span>
        </div>
        <p className="text-xs text-[#3b3f5c] mt-0.5">via OpenRouter</p>
      </div>
    </div>
  );
}

// ─── Mobile Bottom Nav ────────────────────────────────────────────────────────
function MobileBottomNav({ active, onChange, hasProject, isStreaming, modelColor }: {
  active: MobilePanel; onChange: (p: MobilePanel) => void;
  hasProject: boolean; isStreaming: boolean; modelColor: string;
}) {
  const items: { id: MobilePanel; label: string; icon: React.ReactNode; requiresProject?: boolean }[] = [
    { id: "projects", label: "Loyihalar", icon: <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg> },
    { id: "files",    label: "Fayllar",   requiresProject: true, icon: <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg> },
    { id: "chat",     label: "Chat",      requiresProject: true, icon: <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> },
    { id: "editor",   label: "Editor",    requiresProject: true, icon: <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> },
    { id: "preview",  label: "Run",       requiresProject: true, icon: <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> },
    { id: "shell",    label: "Shell",     requiresProject: true, icon: <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg> },
  ];

  return (
    <div className="flex border-t border-[#1e1e2e] bg-[#0d0d1a]">
      {items.map((item) => {
        const disabled = item.requiresProject && !hasProject;
        const isActive = active === item.id;
        const color = isActive ? (item.id === "preview" ? "#9ece6a" : "#7aa2f7") : "#565f89";
        return (
          <button key={item.id} onClick={() => !disabled && onChange(item.id)} disabled={disabled}
            className="flex-1 flex flex-col items-center gap-1 py-2.5 transition-colors disabled:opacity-30" style={{ color }}>
            {item.id === "chat" && isStreaming ? (
              <span className="relative">{item.icon}<span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full animate-pulse" style={{ background: modelColor }} /></span>
            ) : item.icon}
            <span className="text-[10px] font-medium">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Secrets Panel ────────────────────────────────────────────────────────────
function SecretsPanel({ projectId }: { projectId: number }) {
  const [secrets, setSecrets] = useState<{ id: number; key: string; value: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  const fetchSecrets = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/secrets`);
      const data = await res.json() as { id: number; key: string; value: string }[];
      setSecrets(data);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void fetchSecrets(); }, [fetchSecrets]);

  const handleAdd = async () => {
    if (!newKey.trim()) return;
    setSaving(true);
    try {
      await fetch(`/api/projects/${projectId}/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: newKey.trim(), value: newValue }),
      });
      setNewKey(""); setNewValue("");
      await fetchSecrets();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    const secretToDelete = secrets.find((s) => s.id === id);
    if (!secretToDelete) return;
    await fetch(`/api/projects/${projectId}/secrets/${encodeURIComponent(secretToDelete.key)}`, { method: "DELETE" });
    await fetchSecrets();
  };

  const toggleReveal = (id: number) => {
    setRevealed((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  };

  return (
    <div className="flex flex-col h-full bg-[#0d0d1a]">
      <div className="px-4 py-3 border-b border-[#1e1e2e]">
        <span className="text-xs text-[#565f89] font-medium uppercase tracking-wider">Maxfiy o'zgaruvchilar</span>
        <p className="text-xs text-[#3b3f5c] mt-1">AI ularga /api/projects/{"{id}"}/secrets orqali murojaat qiladi</p>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {loading ? (
          <p className="text-xs text-[#3b3f5c] text-center py-4">Yuklanmoqda...</p>
        ) : secrets.length === 0 ? (
          <p className="text-xs text-[#3b3f5c] text-center py-4">Hali sir yo'q</p>
        ) : (
          secrets.map((s) => (
            <div key={s.id} className="flex items-center gap-2 px-3 py-2 bg-[#1a1a2e] border border-[#2a2a3a] rounded-lg">
              <span className="text-xs font-mono text-[#7aa2f7] min-w-0 truncate flex-shrink-0" style={{ maxWidth: "35%" }}>{s.key}</span>
              <span className="text-xs font-mono text-[#a9b1d6] flex-1 truncate">{revealed.has(s.id) ? s.value : "••••••••"}</span>
              <button onClick={() => toggleReveal(s.id)} className="text-[#565f89] hover:text-[#a9b1d6] flex-shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {revealed.has(s.id) ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></> : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>}
                </svg>
              </button>
              <button onClick={() => handleDelete(s.id)} className="text-[#565f89] hover:text-[#f7768e] flex-shrink-0 text-base leading-none">×</button>
            </div>
          ))
        )}
      </div>
      <div className="p-4 border-t border-[#1e1e2e] space-y-2">
        <input className="w-full px-3 py-2 text-xs bg-[#1a1a2e] border border-[#2a2a3a] focus:border-[#7aa2f7]/60 rounded-lg text-[#c0caf5] placeholder-[#565f89] outline-none font-mono"
          placeholder="KALID_NOMI" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        <input className="w-full px-3 py-2 text-xs bg-[#1a1a2e] border border-[#2a2a3a] focus:border-[#7aa2f7]/60 rounded-lg text-[#c0caf5] placeholder-[#565f89] outline-none font-mono"
          placeholder="qiymat" value={newValue} onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }} />
        <button onClick={handleAdd} disabled={!newKey.trim() || saving}
          className="w-full py-2 text-xs bg-[#7aa2f7]/10 hover:bg-[#7aa2f7]/20 border border-[#7aa2f7]/30 text-[#7aa2f7] rounded-lg font-medium disabled:opacity-40 transition-colors">
          {saving ? "Saqlanmoqda..." : "+ Qo'shish"}
        </button>
      </div>
    </div>
  );
}

// ─── Run Panel ────────────────────────────────────────────────────────────────
type RunStatus = "stopped" | "running" | "starting" | "stopping";
function RunPanel({ projectId }: { projectId: number }) {
  const [status, setStatus]   = useState<RunStatus>("stopped");
  const [logs, setLogs]       = useState<string[]>([]);
  const [port, setPort]       = useState<number | null>(null);
  const [, forceUpdate]       = useReducer((x: number) => x + 1, 0);
  const logsEndRef            = useRef<HTMLDivElement>(null);
  const esRef                 = useRef<EventSource | null>(null);
  const iframeRef             = useRef<HTMLIFrameElement>(null);

  // Poll run status on mount and after start/stop
  const pollStatus = useCallback(async () => {
    try {
      const res  = await fetch(`/api/projects/${projectId}/run/status`);
      const data = await res.json() as { running: boolean; port?: number };
      setStatus(data.running ? "running" : "stopped");
      if (data.port) setPort(data.port);
    } catch {}
  }, [projectId]);

  useEffect(() => { void pollStatus(); }, [pollStatus]);

  // Start log streaming via SSE
  const startLogStream = useCallback(() => {
    esRef.current?.close();
    const es = new EventSource(`/api/projects/${projectId}/run/logs`);
    esRef.current = es;
    es.onmessage = (e) => {
      setLogs((prev) => {
        const next = [...prev, e.data as string];
        return next.length > 500 ? next.slice(-500) : next;
      });
    };
    es.onerror = () => { es.close(); };
  }, [projectId]);

  useEffect(() => {
    if (status === "running") startLogStream();
    else esRef.current?.close();
    return () => { esRef.current?.close(); };
  }, [status, startLogStream]);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const handleStart = async () => {
    setStatus("starting"); setLogs([]);
    try {
      await fetch(`/api/projects/${projectId}/run/start`, { method: "POST" });
      await pollStatus();
      forceUpdate();
    } catch { setStatus("stopped"); }
  };

  const handleStop = async () => {
    setStatus("stopping");
    try {
      await fetch(`/api/projects/${projectId}/run/stop`, { method: "POST" });
    } catch {}
    setStatus("stopped"); setPort(null);
  };

  const isRunning = status === "running";

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#0a0a14]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#1e1e2e] bg-[#0d0d1a] flex-shrink-0">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isRunning ? "bg-[#9ece6a]" : status === "starting" || status === "stopping" ? "bg-[#e0af68] animate-pulse" : "bg-[#565f89]"}`} />
        <span className="text-[10px] text-[#565f89] font-mono flex-1">
          {status === "running" ? `Ishlaydi${port ? ` :${port}` : ""}` : status === "starting" ? "Boshlanmoqda…" : status === "stopping" ? "To'xtatilmoqda…" : "To'xtatildi"}
        </span>
        {isRunning ? (
          <button onClick={() => void handleStop()}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium rounded-lg bg-[#f7768e]/10 border border-[#f7768e]/30 text-[#f7768e] hover:bg-[#f7768e]/20 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
            To'xtat
          </button>
        ) : (
          <button onClick={() => void handleStart()} disabled={status === "starting"}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium rounded-lg bg-[#9ece6a]/10 border border-[#9ece6a]/30 text-[#9ece6a] hover:bg-[#9ece6a]/20 transition-colors disabled:opacity-40">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21"/>
            </svg>
            Yurgiz
          </button>
        )}
        {isRunning && (
          <button onClick={() => { if (iframeRef.current) iframeRef.current.src += ""; }}
            className="flex items-center gap-1 px-2.5 py-1 text-[10px] rounded-lg bg-[#1a1a2e] border border-[#2a2a3a] text-[#565f89] hover:text-[#a9b1d6] transition-colors">
            ↻ Yangilash
          </button>
        )}
      </div>

      {/* Content area — split: logs top, preview bottom when running */}
      {isRunning && port ? (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Live iframe */}
          <div className="flex-1 min-h-0 bg-white border-b border-[#1e1e2e]">
            <iframe
              ref={iframeRef}
              src={`${window.location.origin}/project-preview/${projectId}`}
              className="w-full h-full border-0"
              title="Live Preview"
            />
          </div>
          {/* Logs strip */}
          <div className="h-40 flex-shrink-0 overflow-y-auto bg-[#0d0d1a] p-2 font-mono text-[10px] text-[#565f89]">
            {logs.length === 0
              ? <span className="text-[#2a2a3a] italic">Log kutilmoqda…</span>
              : logs.map((l, i) => (
                <div key={i} className={`leading-5 ${l.includes("error") || l.includes("Error") ? "text-[#f7768e]" : l.includes("warn") ? "text-[#e0af68]" : "text-[#565f89]"}`}>
                  {l}
                </div>
              ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Logs full-height when stopped */}
          {logs.length > 0 ? (
            <div className="flex-1 overflow-y-auto p-3 font-mono text-[10px] space-y-0.5">
              {logs.map((l, i) => (
                <div key={i} className={`leading-5 ${l.includes("error") || l.includes("Error") ? "text-[#f7768e]" : l.includes("warn") ? "text-[#e0af68]" : "text-[#565f89]"}`}>
                  {l}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-12 h-12 text-[#1e1e2e]" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5,3 19,12 5,21"/>
              </svg>
              <p className="text-sm text-[#3b3f5c]">Ilovani yurgizish uchun ▶ Yurgiz tugmasini bosing</p>
              <p className="text-[10px] text-[#2a2a3a]">AI tayyorlagan server-kodni ishga tushiradi</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Secrets Request Modal ────────────────────────────────────────────────────
function SecretsRequestModal({
  secrets,
  projectId,
  onClose,
}: {
  secrets: SecretRequest[];
  projectId: number;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(secrets.map((s) => [s.key, ""]))
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      for (const s of secrets) {
        const val = values[s.key]?.trim();
        if (!val) continue;
        const res = await fetch(`/api/projects/${projectId}/secrets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: s.key, value: val }),
        });
        if (!res.ok) throw new Error(`${s.key} saqlanmadi`);
      }
      setSaved(true);
      setTimeout(onClose, 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xato yuz berdi");
    } finally {
      setSaving(false);
    }
  };

  const allFilled = secrets.every((s) => values[s.key]?.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-[#0d0d1a] border border-[#7aa2f7]/30 rounded-2xl shadow-2xl p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 rounded-xl bg-[#7aa2f7]/10 border border-[#7aa2f7]/30 flex items-center justify-center flex-shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-[#7aa2f7]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[#c0caf5]">AI Secrets So'radi</h2>
            <p className="text-[11px] text-[#565f89]">AI bu kalit(lar)ni loyihangizda ishlatadi</p>
          </div>
        </div>

        {/* Fields */}
        <div className="space-y-4 mb-5">
          {secrets.map((s) => (
            <div key={s.key}>
              <label className="block text-[11px] font-mono text-[#7aa2f7] mb-1">{s.key}</label>
              <p className="text-[11px] text-[#565f89] mb-2 leading-relaxed">{s.description}</p>
              <input
                type="password"
                autoComplete="off"
                placeholder={`${s.key} qiymatini kiriting…`}
                value={values[s.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
                className="w-full bg-[#12121e] border border-[#2a2a3a] rounded-lg px-3 py-2 text-sm text-[#c0caf5] font-mono placeholder-[#3b3f5c] focus:outline-none focus:border-[#7aa2f7]/50 transition-colors"
              />
            </div>
          ))}
        </div>

        {error && <p className="text-[11px] text-[#f7768e] mb-3">{error}</p>}
        {saved && <p className="text-[11px] text-[#9ece6a] mb-3">✅ Saqlandi! AI davom etadi…</p>}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 text-xs rounded-lg bg-[#1a1a2e] border border-[#2a2a3a] text-[#565f89] hover:text-[#a9b1d6] transition-colors"
          >
            Keyinroq
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving || saved || !allFilled}
            className="flex-1 py-2 text-xs rounded-lg bg-[#7aa2f7]/10 border border-[#7aa2f7]/40 text-[#7aa2f7] hover:bg-[#7aa2f7]/20 transition-colors disabled:opacity-40 font-medium"
          >
            {saving ? "Saqlanmoqda…" : saved ? "✅ Saqlandi" : "Saqlash"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Workspace ───────────────────────────────────────────────────────────
export default function WorkspacePage() {
  const queryClient = useQueryClient();
  const [activeProjectId, setActiveProjectId]   = useState<number | null>(null);
  const [selectedFile, setSelectedFile]         = useState<ProjectFile | null>(null);
  const [editingContent, setEditingContent]     = useState("");
  const [input, setInput]                       = useState("");
  const [isStreaming, setIsStreaming]           = useState(false);
  const [displayMessages, setDisplayMessages]   = useState<DisplayMessage[]>([]);
  const [showNewProject, setShowNewProject]     = useState(false);
  const [activeTab, setActiveTab]               = useState<"editor" | "chat" | "preview" | "shell" | "secrets">("chat");
  const [mobilePanel, setMobilePanel]           = useState<MobilePanel>("projects");
  const [previewKey, setPreviewKey]             = useState(0);
  const [renamingFileId, setRenamingFileId]     = useState<number | null>(null);
  const [renameValue, setRenameValue]           = useState("");
  const [newFileName, setNewFileName]           = useState("");
  const [showNewFile, setShowNewFile]           = useState(false);
  const [selectedModel, setSelectedModel]       = useState<string | null>(null);
  const [showModelPicker, setShowModelPicker]   = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [userPlan, setUserPlan]                 = useState<UserPlanInfo | null>(null);
  const [pendingSecretsRequest, setPendingSecretsRequest] = useState<{ secrets: SecretRequest[]; projectId: number } | null>(null);
  const messagesEndRef  = useRef<HTMLDivElement>(null);
  const renameInputRef  = useRef<HTMLInputElement>(null);
  const autoAnalyzeRef  = useRef<number | null>(null);
  const abortRef        = useRef<AbortController | null>(null);

  const { data: projects = [] } = useListProjects();
  const deleteProject = useDeleteProject();
  const updateFile    = useUpdateFile();
  const deleteFile    = useDeleteFile();

  const { data: activeProject } = useGetProject(activeProjectId!, {
    query: {
      enabled: !!activeProjectId,
      queryKey: getGetProjectQueryKey(activeProjectId!),
      refetchInterval: 2000,
      staleTime: 0,
    },
  });

  // Fetch user plan on mount
  useEffect(() => {
    fetch("/api/auth/user")
      .then((r) => r.json())
      .then((d: { user?: UserPlanInfo | null }) => {
        if (d.user) setUserPlan({ plan: d.user.plan ?? "free", freeMessagesUsed: d.user.freeMessagesUsed ?? 0, firstName: d.user.firstName, lastName: d.user.lastName, email: d.user.email });
      })
      .catch(() => {});
  }, []);

  // Auto-select free model if none selected
  useEffect(() => {
    setSelectedModel((prev) => prev ?? FREE_MODEL_ID);
  }, []);

  useEffect(() => {
    if (activeProject?.messages && !isStreaming) {
      setDisplayMessages(
        (activeProject.messages as ProjectMessage[]).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }))
      );
    }
  }, [activeProject?.messages, isStreaming]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [displayMessages]);

  useEffect(() => {
    if (selectedFile && activeProject?.files) {
      const updated = (activeProject.files as ProjectFile[]).find((f) => f.id === selectedFile.id);
      if (updated) { setSelectedFile(updated); setEditingContent(updated.content); }
    }
  }, [activeProject?.files]);

  // Auto-analyze after GitHub clone
  useEffect(() => {
    if (!autoAnalyzeRef.current || !activeProjectId || !selectedModel || isStreaming) return;
    if (autoAnalyzeRef.current !== activeProjectId) return;
    autoAnalyzeRef.current = null;
    const projectId = activeProjectId;
    const model = selectedModel;
    const prompt = "Bu loyihani tahlil qil. 1) README, package.json, requirements.txt va boshqa konfiguratsiya fayllarini o'qi. 2) Loyiha turini aniqlash (HTML/CSS/JS, Node.js, Python, React va h.k.). 3) Agar bog'liqliklar kerak bo'lsa, o'rnat (npm install / pip install). 4) Loyihani ishga tushir yoki preview uchun tayyorla. Har bir qadamni tushuntir.";
    setIsStreaming(true);
    setDisplayMessages([
      { role: "user", content: prompt },
      { role: "assistant", content: "", toolCalls: [], streaming: true },
    ]);
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/messages`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: prompt, model }),
        });
        if (!res.body) throw new Error("No response body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event: StreamEvent = JSON.parse(line.slice(6));
              setDisplayMessages((prev) => {
                const msgs = [...prev];
                const last = { ...msgs[msgs.length - 1] };
                if (event.content) last.content += event.content;
                if (event.tool_call) last.toolCalls = [...(last.toolCalls ?? []), { name: event.tool_call.name, args: event.tool_call.args }];
                if (event.tool_result && last.toolCalls?.length) {
                  const tc = [...(last.toolCalls ?? [])];
                  tc[tc.length - 1] = { ...tc[tc.length - 1], result: event.tool_result.result };
                  last.toolCalls = tc;
                  if (new Set(["create_file", "update_file", "delete_file"]).has(event.tool_result.name)) setPreviewKey((k) => k + 1);
                }
                if (event.done) {
                  last.streaming = false;
                  queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
                }
                msgs[msgs.length - 1] = last;
                return msgs;
              });
            } catch {}
          }
        }
      } catch {
        setDisplayMessages((prev) => {
          const msgs = [...prev];
          msgs[msgs.length - 1] = { role: "assistant", content: "Ulanish xatosi. Qayta urinib ko'ring.", streaming: false };
          return msgs;
        });
      } finally {
        setIsStreaming(false);
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, selectedModel]);

  const handleProjectCreated = (id: number, options?: { fromGithub?: boolean }) => {
    setActiveProjectId(id); setDisplayMessages([]); setSelectedFile(null);
    setShowNewProject(false); setMobilePanel("chat");
    if (options?.fromGithub) {
      autoAnalyzeRef.current = id;
      setSelectedModel((prev) => prev ?? MODELS[0].id);
    }
  };

  const handleDeleteProject = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteProject.mutateAsync({ id });
    queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
    if (activeProjectId === id) { setActiveProjectId(null); setDisplayMessages([]); setSelectedFile(null); }
  };

  const handleSelectProject = (id: number) => {
    setActiveProjectId(id); setSelectedFile(null); setDisplayMessages([]); setMobilePanel("chat");
  };

  const handleSelectFile = (file: ProjectFile) => {
    setSelectedFile(file); setEditingContent(file.content); setActiveTab("editor"); setMobilePanel("editor");
  };

  const handleSaveFile = async () => {
    if (!selectedFile || !activeProjectId) return;
    await updateFile.mutateAsync({ id: activeProjectId, fileId: selectedFile.id, data: { content: editingContent } });
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(activeProjectId) });
  };

  const handleDeleteFile = async (file: ProjectFile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!activeProjectId) return;
    await deleteFile.mutateAsync({ id: activeProjectId, fileId: file.id });
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(activeProjectId) });
    if (selectedFile?.id === file.id) setSelectedFile(null);
  };

  const handleStartRename = (file: ProjectFile, e: React.MouseEvent) => {
    e.stopPropagation(); setRenamingFileId(file.id); setRenameValue(file.path);
    setTimeout(() => renameInputRef.current?.select(), 50);
  };

  const handleRename = async (file: ProjectFile) => {
    if (!activeProjectId || !renameValue.trim() || renameValue === file.path) { setRenamingFileId(null); return; }
    await fetch(`/api/projects/${activeProjectId}/files/${file.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: renameValue.trim() }),
    });
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(activeProjectId) });
    if (selectedFile?.id === file.id) setSelectedFile({ ...file, path: renameValue.trim() });
    setRenamingFileId(null);
  };

  const handleCreateFile = async () => {
    if (!activeProjectId || !newFileName.trim()) return;
    await fetch(`/api/projects/${activeProjectId}/files`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: newFileName.trim(), content: "" }),
    });
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(activeProjectId) });
    setNewFileName(""); setShowNewFile(false);
  };

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setDisplayMessages((prev) => {
      const msgs = [...prev];
      const last = msgs[msgs.length - 1];
      if (last?.streaming) {
        msgs[msgs.length - 1] = { ...last, streaming: false, content: (last.content || "") + "\n\n*[To'xtatildi]*" };
      }
      return msgs;
    });
  }, []);

  const refreshUserPlan = useCallback(() => {
    fetch("/api/auth/user")
      .then((r) => r.json())
      .then((d: { user?: UserPlanInfo & { plan?: string; freeMessagesUsed?: number } | null }) => {
        if (d.user) setUserPlan({ plan: d.user.plan ?? "free", freeMessagesUsed: d.user.freeMessagesUsed ?? 0, firstName: d.user.firstName, lastName: d.user.lastName, email: d.user.email });
      })
      .catch(() => {});
  }, []);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !activeProjectId || isStreaming || !selectedModel) return;

    // Client-side payment wall (UX shortcut — server enforces too)
    if (userPlan?.plan !== "paid") {
      if (selectedModel !== FREE_MODEL_ID) { setShowPaymentModal(true); return; }
      if ((userPlan?.freeMessagesUsed ?? 0) >= FREE_MSG_LIMIT) { setShowPaymentModal(true); return; }
    }

    const userContent = input.trim();
    setInput(""); setIsStreaming(true);
    const currentModel = selectedModel;
    const controller = new AbortController();
    abortRef.current = controller;
    setDisplayMessages((prev) => [
      ...prev,
      { role: "user", content: userContent },
      { role: "assistant", content: "", toolCalls: [], streaming: true },
    ]);
    try {
      const res = await fetch(`/api/projects/${activeProjectId}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: userContent, model: currentModel }),
        signal: controller.signal,
      });
      // Server-side payment wall
      if (res.status === 402) {
        setShowPaymentModal(true);
        setDisplayMessages((prev) => {
          const msgs = [...prev];
          msgs[msgs.length - 1] = { role: "assistant", content: "💳 *Premium kerak.* Quyidagi tugma orqali to'lov qiling.", streaming: false };
          return msgs;
        });
        return;
      }
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event: StreamEvent = JSON.parse(line.slice(6));
            setDisplayMessages((prev) => {
              const msgs = [...prev];
              const last = { ...msgs[msgs.length - 1] };
              if (event.content) last.content += event.content;
              if (event.tool_call) last.toolCalls = [...(last.toolCalls ?? []), { name: event.tool_call.name, args: event.tool_call.args }];
              if (event.tool_result && last.toolCalls?.length) {
                const tc = [...(last.toolCalls ?? [])];
                tc[tc.length - 1] = { ...tc[tc.length - 1], result: event.tool_result.result };
                last.toolCalls = tc;
                if (new Set(["create_file", "update_file", "delete_file"]).has(event.tool_result.name)) setPreviewKey((k) => k + 1);
              }
              if (event.request_secrets && activeProjectId) {
                setPendingSecretsRequest({ secrets: event.request_secrets.secrets, projectId: activeProjectId });
              }
              if (event.done) {
                last.streaming = false;
                queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(activeProjectId) });
              }
              msgs[msgs.length - 1] = last;
              return msgs;
            });
          } catch {}
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // User stopped — already handled in handleStop
      } else {
        setDisplayMessages((prev) => {
          const msgs = [...prev];
          msgs[msgs.length - 1] = { role: "assistant", content: "Ulanish xatosi. Qayta urinib ko'ring.", streaming: false };
          return msgs;
        });
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(activeProjectId) });
      refreshUserPlan();
    }
  }, [input, activeProjectId, isStreaming, queryClient, selectedModel, userPlan, refreshUserPlan]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); }
  };

  const files = (activeProject?.files ?? []) as ProjectFile[];
  const activeModelInfo = MODELS.find((m) => m.id === selectedModel) ?? null;
  const displayModelInfo = activeModelInfo ?? { label: "Model tanlanmagan", color: "#565f89", id: "", power: 0 };

  const livePreviewIframe = activeProjectId ? (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-1.5 border-b border-[#1e1e2e] bg-[#0d0d1a] flex items-center gap-2 flex-shrink-0">
        <span className="w-2 h-2 rounded-full bg-[#9ece6a]" />
        <span className="text-[10px] text-[#565f89] font-mono flex-1">localhost preview</span>
        <button onClick={() => setPreviewKey((k) => k + 1)}
          className="text-[10px] text-[#565f89] hover:text-[#9ece6a] px-2 py-1 rounded hover:bg-[#9ece6a]/10 transition-colors">
          ↻ Yangilash
        </button>
      </div>
      <div className="flex-1 min-h-0 bg-white">
        <SandpackLivePreview files={files} projectId={activeProjectId} resetKey={previewKey} />
      </div>
    </div>
  ) : null;

  const chatPanel = (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {!activeModelInfo && (
          <div className="text-center mt-12">
            <div className="text-5xl mb-4 text-[#565f89]/30">◆</div>
            <p className="text-sm text-[#a9b1d6] font-medium mb-1">Avval modelni tanlang</p>
            <p className="text-xs text-[#565f89]">Suhbatni boshlash uchun quyidan bitta modelni tanlashingiz kerak</p>
          </div>
        )}
        {activeModelInfo && displayMessages.length === 0 && (
          <div className="text-center mt-12">
            <div className="text-5xl mb-4 text-[#7aa2f7]/20">◆</div>
            <p className="text-sm text-[#565f89]">AI bilan suhbatni boshlang</p>
            <p className="text-xs text-[#3b3f5c] mt-1">Fayl yaratish, kodni tuzatish yoki loyiha haqida savol bering</p>
          </div>
        )}
        {displayMessages.map((msg, i) => (
          <div key={i} className={`flex flex-col gap-1.5 ${msg.role === "user" ? "items-end" : "items-start"}`}>
            {msg.role === "user" ? (
              <div className="max-w-[80%] px-3.5 py-2.5 bg-[#7aa2f7]/15 border border-[#7aa2f7]/25 rounded-2xl rounded-br-sm text-sm text-[#c0caf5] whitespace-pre-wrap">
                {msg.content}
              </div>
            ) : (
              <div className="flex flex-col gap-2 w-full">
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div className="space-y-1.5">
                    {msg.toolCalls.map((tc, ti) => {
                      const status = parseRunResult(tc.name, tc.result);
                      const label = TOOL_LABELS[tc.name] ?? tc.name;
                      const statusColor = status === "success" ? "#9ece6a" : status === "error" ? "#f7768e" : status === "timeout" ? "#e0af68" : "#7aa2f7";
                      const isPending = tc.result === undefined;
                      return (
                        <div key={ti} className="flex items-start gap-2 px-3 py-2 bg-[#1a1a2e] border border-[#2a2a3a] rounded-xl text-xs">
                          <span className="mt-0.5 flex-shrink-0">
                            {isPending
                              ? <span className="w-3 h-3 border border-[#7aa2f7] border-t-transparent rounded-full animate-spin block" />
                              : <span className="w-3 h-3 rounded-full block" style={{ background: statusColor }} />}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[#7aa2f7] font-medium">{label}</span>
                              {tc.args.path && <span className="text-[#565f89] font-mono truncate">{tc.args.path}</span>}
                            </div>
                            {tc.result && tc.name === "run_command" && (
                              <div className="mt-1 text-[#565f89] font-mono truncate">{tc.result.slice(0, 120)}{tc.result.length > 120 ? "…" : ""}</div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {(msg.content || msg.streaming) && (
                  <div className="max-w-none px-3.5 py-2.5 bg-[#12121e] border border-[#1e1e2e] rounded-2xl rounded-tl-sm text-xs text-[#a9b1d6] leading-relaxed">
                    {msg.content ? <CodeBlock content={msg.content} /> : null}
                    {msg.streaming && !msg.content && (
                      <span className="inline-flex items-center gap-1 text-[#565f89]">
                        <span className="w-1 h-1 rounded-full bg-[#565f89] animate-bounce" style={{ animationDelay: "0ms" }} />
                        <span className="w-1 h-1 rounded-full bg-[#565f89] animate-bounce" style={{ animationDelay: "150ms" }} />
                        <span className="w-1 h-1 rounded-full bg-[#565f89] animate-bounce" style={{ animationDelay: "300ms" }} />
                      </span>
                    )}
                    {msg.streaming && msg.content && (
                      <span className="inline-block w-0.5 h-3.5 bg-[#7aa2f7] animate-pulse ml-0.5 align-middle" />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-[#1e1e2e] space-y-2">
        {/* Model selector */}
        <div className="relative">
          <button onClick={() => setShowModelPicker((v) => !v)}
            className="flex items-center gap-2 px-3 py-1.5 text-xs bg-[#1a1a2e] border border-[#2a2a3a] hover:border-[#7aa2f7]/40 rounded-lg transition-colors w-full">
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: displayModelInfo.color }} />
            <span className="text-[#a9b1d6] flex-1 text-left truncate">{displayModelInfo.label}</span>
            {activeModelInfo && <ModelPowerDots power={activeModelInfo.power} color={activeModelInfo.color} />}
            {userPlan?.plan === "free" && (
              <span className="text-[#565f89] text-[10px] ml-1 flex-shrink-0">
                {Math.max(0, FREE_MSG_LIMIT - (userPlan.freeMessagesUsed ?? 0))}/{FREE_MSG_LIMIT}
              </span>
            )}
            {userPlan?.plan === "paid" && <span className="text-[#9ece6a] text-[10px] ml-1">✦</span>}
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3 text-[#565f89]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          {showModelPicker && (
            <div className="absolute bottom-full mb-1 left-0 right-0 bg-[#0d0d1a] border border-[#2a2a3a] rounded-xl shadow-2xl z-10 p-1">
              {MODELS.map((m) => {
                const isLocked = !m.free && userPlan?.plan !== "paid";
                return (
                  <button key={m.id}
                    onClick={() => {
                      if (isLocked) { setShowPaymentModal(true); setShowModelPicker(false); return; }
                      setSelectedModel(m.id); setShowModelPicker(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs transition-colors ${selectedModel === m.id ? "bg-[#7aa2f7]/10" : "hover:bg-[#1a1a2e]"} ${isLocked ? "opacity-60" : ""}`}>
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: m.color }} />
                    <span className="flex-1 text-left text-[#a9b1d6]">{m.label}</span>
                    {m.free && <span className="text-[10px] text-[#e0af68] font-medium">Bepul</span>}
                    <ModelPowerDots power={m.power} color={m.color} />
                    {isLocked
                      ? <span className="text-[#565f89] text-[11px]">🔒</span>
                      : selectedModel === m.id
                        ? <span className="text-[#7aa2f7]">✓</span>
                        : null}
                  </button>
                );
              })}
              {userPlan?.plan === "free" && (
                <div className="px-3 py-2 mt-1 border-t border-[#1e1e2e]">
                  <button onClick={() => { setShowPaymentModal(true); setShowModelPicker(false); }}
                    className="w-full py-1.5 rounded-lg text-[10px] font-medium text-[#7aa2f7] bg-[#7aa2f7]/10 hover:bg-[#7aa2f7]/20 transition-colors">
                    💎 Premium — barcha modellar
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-2 items-end">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            className="flex-1 px-3 py-2.5 text-sm bg-[#1a1a2e] border border-[#2a2a3a] focus:border-[#7aa2f7]/50 rounded-xl text-[#c0caf5] placeholder-[#565f89] outline-none resize-none leading-relaxed"
            placeholder={selectedModel ? "Xabar yozing… (Enter — yuborish, Shift+Enter — yangi qator)" : "Avval modelni tanlang"}
            rows={1} disabled={isStreaming || !selectedModel || !activeProjectId}
            style={{ maxHeight: "120px" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
            }} />
          {/* Stop button — visible while streaming */}
          {isStreaming ? (
            <button onClick={handleStop}
              title="Jarayonni to'xtatish"
              className="w-10 h-10 flex items-center justify-center rounded-xl border-2 border-[#f7768e] bg-[#f7768e]/10 hover:bg-[#f7768e]/20 transition-colors flex-shrink-0">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-[#f7768e]" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2"/>
              </svg>
            </button>
          ) : (
            <button onClick={() => void handleSend()} disabled={!input.trim() || !selectedModel || !activeProjectId}
              className="w-10 h-10 flex items-center justify-center rounded-xl transition-colors flex-shrink-0 disabled:opacity-30"
              style={{ background: "#7aa2f7" }}>
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-[#0d0d1a]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );

  const editorPanel = (
    <div className="flex h-full min-h-0">
      {selectedFile ? (
        <>
          <div className="flex flex-col flex-1 min-w-0 border-r border-[#1e1e2e]">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#1e1e2e] bg-[#0d0d1a] flex-shrink-0">
              <span className="text-xs text-[#565f89] font-mono truncate">{selectedFile.path}</span>
              <button onClick={() => void handleSaveFile()}
                className="px-3 py-1.5 text-xs bg-[#7aa2f7]/15 border border-[#7aa2f7]/30 text-[#7aa2f7] rounded-lg hover:bg-[#7aa2f7]/25 transition-colors ml-2 flex-shrink-0">
                Saqlash
              </button>
            </div>
            <textarea value={editingContent} onChange={(e) => setEditingContent(e.target.value)}
              className="flex-1 p-4 bg-[#0a0a14] text-[#a9b1d6] font-mono text-xs leading-relaxed resize-none outline-none"
              spellCheck={false} />
          </div>
          <div className="w-[45%] flex-shrink-0 flex flex-col min-h-0">{livePreviewIframe}</div>
        </>
      ) : (
        <div className="flex-1 min-h-0">
          {livePreviewIframe ?? (
            <div className="flex flex-col h-full items-center justify-center gap-3 text-center p-8">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-10 h-10 text-[#2a2a3a]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/></svg>
              <p className="text-sm text-[#3b3f5c]">Loyiha tanlang</p>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const previewPanel = activeProjectId
    ? <RunPanel projectId={activeProjectId} />
    : (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-center p-8">
        <svg xmlns="http://www.w3.org/2000/svg" className="w-10 h-10 text-[#2a2a3a]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/>
        </svg>
        <p className="text-sm text-[#3b3f5c]">Loyiha tanlang</p>
      </div>
    );

  const filesPanelProps = {
    files, selectedFile, renamingFileId, renameValue, renameInputRef,
    showNewFile, newFileName, onSelectFile: handleSelectFile,
    onStartRename: handleStartRename, onRename: handleRename,
    onDeleteFile: handleDeleteFile, setRenamingFileId, setRenameValue,
    setShowNewFile, setNewFileName, onCreateFile: handleCreateFile,
  };

  const tabList = [
    { id: "chat" as const, label: "Chat", color: "#7aa2f7" },
    { id: "editor" as const, label: selectedFile ? selectedFile.path.split("/").pop()! : "Editor", color: "#7aa2f7" },
    { id: "preview" as const, label: "Run", color: "#9ece6a" },
    { id: "shell" as const, label: "Shell", color: "#e0af68" },
    { id: "secrets" as const, label: "Secrets", color: "#bb9af7" },
  ];

  return (
    <div className="flex h-[100dvh] bg-[#0a0a14] text-[#c0caf5] text-sm overflow-hidden">
      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} onCreated={handleProjectCreated} />}
      {pendingSecretsRequest && (
        <SecretsRequestModal
          secrets={pendingSecretsRequest.secrets}
          projectId={pendingSecretsRequest.projectId}
          onClose={() => setPendingSecretsRequest(null)}
        />
      )}

      {/* ─── DESKTOP layout (md+) ─── */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        <div className="w-56 flex-shrink-0 border-r border-[#1e1e2e]">
          <ProjectsPanel projects={projects} activeProjectId={activeProjectId}
            onSelect={handleSelectProject} onDelete={handleDeleteProject}
            onNew={() => setShowNewProject(true)} activeModelInfo={activeModelInfo}
            userPlan={userPlan} onOpenPayment={() => setShowPaymentModal(true)} />
        </div>

        {activeProjectId ? (
          <>
            <div className="w-52 flex-shrink-0 border-r border-[#1e1e2e]">
              <FilesPanel {...filesPanelProps} />
            </div>
            <div className="flex-1 flex flex-col min-w-0">
              <div className="flex border-b border-[#1e1e2e] bg-[#0d0d1a]">
                {tabList.map((t) => (
                  <button key={t.id} onClick={() => { setActiveTab(t.id); if (t.id === "preview") setPreviewKey((k) => k + 1); }}
                    className="px-4 py-2.5 text-xs font-medium transition-colors border-b-2 flex items-center gap-1.5"
                    style={activeTab === t.id ? { borderColor: t.color, color: t.color } : { borderColor: "transparent", color: "#565f89" }}>
                    {t.label}
                    {t.id === "chat" && isStreaming && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: displayModelInfo.color }} />}
                  </button>
                ))}
                <div className="ml-auto px-4 py-2.5 flex items-center gap-2">
                  <span className="text-xs text-[#565f89]">{activeProject?.name}</span>
                  {activeTab === "preview" && (
                    <button onClick={() => setPreviewKey((k) => k + 1)}
                      className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-[#1a1a2e] border border-[#2a2a3e] text-[#9ece6a] hover:bg-[#9ece6a]/10 transition-colors">
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    </button>
                  )}
                  <a href={`/api/projects/${activeProject?.id}/download`} download
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-[#1a1a2e] border border-[#2a2a3e] text-[#7aa2f7] hover:bg-[#7aa2f7]/10 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    ZIP
                  </a>
                </div>
              </div>
              <div className="flex-1 min-h-0">
                {activeTab === "preview" ? previewPanel
                  : activeTab === "shell" ? <ShellPanel projectId={activeProjectId} />
                  : activeTab === "secrets" ? <SecretsPanel projectId={activeProjectId} />
                  : activeTab === "chat" ? chatPanel
                  : editorPanel}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="text-6xl mb-5 text-[#7aa2f7]/15">◆</div>
              <h2 className="text-base font-semibold text-[#565f89] mb-1">UzCoder</h2>
              <p className="text-xs text-[#3b3f5c] mb-4">Boshlash uchun loyiha yarating</p>
              <button onClick={() => setShowNewProject(true)}
                className="px-4 py-2 text-xs bg-[#7aa2f7]/10 hover:bg-[#7aa2f7]/20 border border-[#7aa2f7]/30 rounded-lg text-[#7aa2f7] transition-colors">
                + Yangi Loyiha
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─── MOBILE layout (< md) ─── */}
      <div className="flex md:hidden flex-col flex-1 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e2e] bg-[#0d0d1a] flex-shrink-0">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-2 h-2 rounded-full bg-[#7aa2f7] flex-shrink-0" />
            <span className="text-xs font-bold tracking-widest text-[#7aa2f7]">UZCODER</span>
            {activeProject && (
              <><span className="text-[#2a2a3a]">/</span><span className="text-xs text-[#a9b1d6] truncate">{activeProject.name}</span></>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {activeProjectId && mobilePanel === "preview" && (
              <button onClick={() => setPreviewKey((k) => k + 1)} className="p-2 rounded-lg bg-[#1a1a2e] border border-[#2a2a3e] text-[#9ece6a]">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              </button>
            )}
            {activeProjectId && (
              <a href={`/api/projects/${activeProjectId}/download`} download className="p-2 rounded-lg bg-[#1a1a2e] border border-[#2a2a3e] text-[#7aa2f7]">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </a>
            )}
            <UserMenu userPlan={userPlan} onOpenPayment={() => setShowPaymentModal(true)} alignRight />
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {mobilePanel === "projects" ? (
            <ProjectsPanel projects={projects} activeProjectId={activeProjectId}
              onSelect={(id) => { handleSelectProject(id); setMobilePanel("chat"); }}
              onDelete={handleDeleteProject} onNew={() => setShowNewProject(true)} activeModelInfo={activeModelInfo}
              userPlan={userPlan} onOpenPayment={() => setShowPaymentModal(true)} mobileMode />
          ) : mobilePanel === "files" && activeProjectId ? (
            <FilesPanel {...filesPanelProps} />
          ) : mobilePanel === "chat" && activeProjectId ? chatPanel
          : mobilePanel === "editor" && activeProjectId ? editorPanel
          : mobilePanel === "preview" && activeProjectId ? previewPanel
          : mobilePanel === "shell" && activeProjectId ? <ShellPanel projectId={activeProjectId} />
          : (
            <div className="flex flex-col h-full items-center justify-center gap-4 p-8 text-center">
              <div className="text-6xl text-[#7aa2f7]/15">◆</div>
              <p className="text-sm text-[#565f89]">Loyiha yarating yoki tanlang</p>
              <button onClick={() => setShowNewProject(true)}
                className="px-5 py-2.5 bg-[#7aa2f7]/10 hover:bg-[#7aa2f7]/20 border border-[#7aa2f7]/30 rounded-xl text-[#7aa2f7] text-sm font-medium transition-colors">
                + Yangi Loyiha
              </button>
            </div>
          )}
        </div>
        <MobileBottomNav active={mobilePanel} onChange={setMobilePanel}
          hasProject={!!activeProjectId} isStreaming={isStreaming} modelColor={displayModelInfo.color} />
      </div>

      {/* Payment modal */}
      <PaymentModal
        open={showPaymentModal}
        onClose={() => setShowPaymentModal(false)}
        onPlanActivated={() => {
          setShowPaymentModal(false);
          setUserPlan((prev) => prev ? { ...prev, plan: "paid" } : { plan: "paid", freeMessagesUsed: 0 });
        }}
      />
    </div>
  );
}
