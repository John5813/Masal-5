import { useEffect } from "react";
import {
  SandpackProvider,
  SandpackPreview,
  useSandpack,
} from "@codesandbox/sandpack-react";
import type { SandpackFiles, SandpackPredefinedTemplate } from "@codesandbox/sandpack-react";
import type { ProjectFile } from "@workspace/api-client-react";

function FileSyncer({ sandpackFiles }: { sandpackFiles: SandpackFiles }) {
  const { sandpack } = useSandpack();
  useEffect(() => {
    for (const [path, descriptor] of Object.entries(sandpackFiles)) {
      const code = typeof descriptor === "string" ? descriptor : descriptor.code;
      sandpack.updateFile(path, code);
    }
  }, [JSON.stringify(sandpackFiles)]);
  return null;
}

function detectTemplate(files: ProjectFile[]): SandpackPredefinedTemplate {
  const pkgFile = files.find((f) => f.path === "package.json" || f.path === "/package.json");
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["react"] || deps["react-dom"]) return "react";
      if (deps["vue"]) return "vue";
      if (deps["svelte"]) return "svelte";
      if (deps["solid-js"]) return "solid";
    } catch {}
  }
  return "static";
}

function toSandpackFiles(files: ProjectFile[]): SandpackFiles {
  const result: SandpackFiles = {};
  for (const f of files) {
    const path = f.path.startsWith("/") ? f.path : `/${f.path}`;
    result[path] = { code: f.content ?? "" };
  }
  return result;
}

function findEntryFile(template: SandpackPredefinedTemplate, files: ProjectFile[]): string {
  const paths = files.map((f) => (f.path.startsWith("/") ? f.path : `/${f.path}`));
  if (template === "react") {
    return paths.find((p) => p.endsWith("/App.tsx") || p.endsWith("/App.jsx")) ??
      paths.find((p) => p.endsWith("/index.tsx") || p.endsWith("/index.jsx")) ??
      "/App.js";
  }
  return paths.find((p) => p === "/index.html") ?? paths.find((p) => p.endsWith(".html")) ?? "/index.html";
}

interface SandpackLivePreviewProps {
  files: ProjectFile[];
  projectId: number;
  resetKey?: number;
}

export function SandpackLivePreview({ files, projectId, resetKey = 0 }: SandpackLivePreviewProps) {
  if (!files.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 bg-[#0a0a14]">
        <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 text-[#2a2a3a]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="20" height="14" rx="2" /><polyline points="8 21 12 17 16 21" />
        </svg>
        <p className="text-xs text-[#3b3f5c]">Fayl mavjud emas</p>
      </div>
    );
  }

  const template = detectTemplate(files);
  const sandpackFiles = toSandpackFiles(files);
  const activeFile = findEntryFile(template, files);

  return (
    <SandpackProvider
      key={`${projectId}-${resetKey}`}
      template={template}
      files={sandpackFiles}
      options={{ activeFile }}
      theme="dark"
      style={{ height: "100%", display: "flex", flexDirection: "column" }}
    >
      <FileSyncer sandpackFiles={sandpackFiles} />
      <SandpackPreview
        style={{ flex: 1, minHeight: 0 }}
        showNavigator={false}
        showOpenInCodeSandbox={false}
        showRefreshButton={true}
      />
    </SandpackProvider>
  );
}
