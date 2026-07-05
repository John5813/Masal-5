import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface ShellPanelProps {
  projectId: number;
}

type ConnectionState = "connecting" | "connected" | "disconnected";

export function ShellPanel({ projectId }: ShellPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  const wsRef        = useRef<WebSocket | null>(null);
  const [connState, setConnState] = useState<ConnectionState>("disconnected");

  const connect = useCallback(() => {
    if (!containerRef.current) return;

    // Cleanup previous session
    wsRef.current?.close();
    termRef.current?.dispose();

    setConnState("connecting");

    const term = new Terminal({
      theme: {
        background:          "#0a0a14",
        foreground:          "#c0caf5",
        cursor:              "#7aa2f7",
        cursorAccent:        "#0a0a14",
        selectionBackground: "#7aa2f799",
        black:               "#1a1b26",
        red:                 "#f7768e",
        green:               "#9ece6a",
        yellow:              "#e0af68",
        blue:                "#7aa2f7",
        magenta:             "#bb9af7",
        cyan:                "#7dcfff",
        white:               "#a9b1d6",
        brightBlack:         "#565f89",
        brightRed:           "#f7768e",
        brightGreen:         "#9ece6a",
        brightYellow:        "#e0af68",
        brightBlue:          "#7aa2f7",
        brightMagenta:       "#bb9af7",
        brightCyan:          "#7dcfff",
        brightWhite:         "#c0caf5",
      },
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
      fontSize:      13,
      lineHeight:    1.4,
      cursorBlink:   true,
      cursorStyle:   "bar",
      scrollback:    10000,
      allowTransparency: false,
      convertEol:    false,   // server sends \r\n
      allowProposedApi: true,
    });

    const fit   = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(containerRef.current);

    // Fit immediately and after a tiny delay (for layout to settle)
    fit.fit();
    setTimeout(() => fit.fit(), 50);

    termRef.current = term;
    fitRef.current  = fit;

    // Build WebSocket URL
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/api/shell/${projectId}`;
    const ws    = new WebSocket(wsUrl);
    wsRef.current = ws;

    // Binary mode for proper character encoding
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      setConnState("connected");
      // Send initial terminal size
      const dims = fit.proposeDimensions();
      if (dims) {
        ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
      }
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(
          typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)
        ) as { type: string; data: string };

        if (msg.type === "output") {
          term.write(msg.data);
        } else if (msg.type === "exit") {
          term.writeln(`\r\n\x1b[33m[Process exited — code ${msg.data}]\x1b[0m`);
          setConnState("disconnected");
        }
      } catch {}
    };

    ws.onerror = () => {
      term.writeln("\r\n\x1b[31m[WebSocket xatosi]\x1b[0m");
      setConnState("disconnected");
    };

    ws.onclose = () => {
      if (connState !== "disconnected") {
        term.writeln("\r\n\x1b[33m[Aloqa uzildi — qayta ulash tugmasini bosing]\x1b[0m");
      }
      setConnState("disconnected");
    };

    // Forward keyboard input to shell
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Send resize when terminal size changes
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Connect on mount / projectId change
  useEffect(() => {
    connect();

    // Observe parent for size changes → refit terminal
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
      });
    });
    if (containerRef.current?.parentElement) {
      ro.observe(containerRef.current.parentElement);
    }

    return () => {
      ro.disconnect();
      wsRef.current?.close();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current  = null;
    };
  }, [connect]);

  const statusColor = connState === "connected" ? "#9ece6a" : connState === "connecting" ? "#e0af68" : "#565f89";
  const statusLabel = connState === "connected" ? "Ulangan" : connState === "connecting" ? "Ulanmoqda…" : "Uzildi";

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#0a0a14]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#1e1e2e] bg-[#0d0d1a] flex-shrink-0">
        <div className="flex items-center gap-2">
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ background: statusColor, boxShadow: connState === "connected" ? `0 0 4px ${statusColor}` : "none" }}
          />
          <span className="text-[10px] font-medium" style={{ color: statusColor }}>
            {statusLabel}
          </span>
          <span className="text-[10px] text-[#3b3f5c] font-mono ml-1">
            /projects/{projectId}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* Clear button */}
          <button
            onClick={() => termRef.current?.clear()}
            title="Tozalash"
            className="flex items-center gap-1 px-2 py-1 text-[10px] rounded bg-[#1a1a2e] border border-[#2a2a3e] text-[#565f89] hover:text-[#a9b1d6] hover:bg-[#1e1e2e] transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="4 7 4 4 20 4 20 7"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><polyline points="5 7 6 19 18 19 19 7"/>
            </svg>
            Tozala
          </button>

          {/* Reconnect button */}
          <button
            onClick={connect}
            title="Qayta ulash"
            className="flex items-center gap-1 px-2 py-1 text-[10px] rounded bg-[#1a1a2e] border border-[#2a2a3e] text-[#7aa2f7] hover:bg-[#7aa2f7]/10 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Qayta
          </button>
        </div>
      </div>

      {/* Tips bar */}
      <div className="px-3 py-1 bg-[#0d0d1a] border-b border-[#1e1e2e] flex items-center gap-3 flex-shrink-0">
        <span className="text-[9px] text-[#3b3f5c]">git push / pull ishlaydi</span>
        <span className="text-[9px] text-[#2a2a3a]">•</span>
        <span className="text-[9px] text-[#3b3f5c]">npm install / pip install</span>
        <span className="text-[9px] text-[#2a2a3a]">•</span>
        <span className="text-[9px] text-[#3b3f5c]">Ctrl+C — bekor qilish</span>
      </div>

      {/* Terminal */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0"
        style={{ padding: "4px 6px" }}
      />
    </div>
  );
}
