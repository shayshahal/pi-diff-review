/**
 * WSL Bridge — launches Windows Chrome/Edge in app mode instead of going
 * through WSLg, giving a first-class native Windows window.
 *
 * Serves the review HTML from a local HTTP server. A small bridge script
 * replaces `window.glimpse.send()` / `window.glimpse.close()` with HTTP
 * POST calls back to the server.  The server then emits the same events
 * as a GlimpseWindow so the rest of the extension is unaware of the swap.
 */

import { EventEmitter } from "node:events";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

/* ── WSL detection ─────────────────────────────────────────────────────────── */

let _isWSL: boolean | null = null;

export function isWSL(): boolean {
  if (_isWSL != null) return _isWSL;
  try {
    _isWSL = /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    _isWSL = false;
  }
  return _isWSL;
}

/* ── Find a Windows browser ────────────────────────────────────────────────── */

function findWindowsBrowser(): string | null {
  const candidates = [
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/* ── Windows temp directory ─────────────────────────────────────────────────── */

let _winTemp: string | null = null;

function getWindowsTemp(): string {
  if (_winTemp != null) return _winTemp;
  try {
    _winTemp = execSync('cmd.exe /c "echo %TEMP%"', {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .replace(/\r/g, "");
  } catch {
    _winTemp = "C:\\Temp";
  }
  return _winTemp;
}

/* ── Bridge script ─────────────────────────────────────────────────────────── */

/** Injected as the first <script> in <head>.  Defines window.glimpse so the
 *  existing app.js code works unchanged. */
const BRIDGE_SCRIPT = `<script>
(function() {
  window.glimpse = {
    cursorTip: null,
    send: function(data) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/message', false);   // synchronous so window.close() waits
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(data));
    },
    close: function() {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/close', false);
        xhr.send('');
      } catch(e) {}
      window.close();
    }
  };
})();
</script>`;

/* ── Body parser ───────────────────────────────────────────────────────────── */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ── WSLWindow ─────────────────────────────────────────────────────────────── */

export interface WSLWindowOptions {
  width?: number;
  height?: number;
  title?: string;
}

export class WSLWindow extends EventEmitter {
  private httpServer: Server | null = null;
  private proc: ChildProcess | null = null;
  private closed = false;
  private readyEmitted = false;

  constructor(html: string, options: WSLWindowOptions = {}) {
    super();

    const browserPath = findWindowsBrowser();
    if (browserPath == null) {
      queueMicrotask(() => {
        this.emit(
          "error",
          new Error(
            "No Windows Chrome or Edge found. Install Chrome or Edge on the Windows side.",
          ),
        );
      });
      return;
    }

    this.start(html, browserPath, options);
  }

  /* ── HTTP server ─────────────────────────────────────────────────────── */

  private start(
    rawHtml: string,
    browserPath: string,
    options: WSLWindowOptions,
  ): void {
    const html = injectBridge(rawHtml);

    this.httpServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      /* Serve the page */
      if (req.method === "GET" && url.pathname === "/") {
        if (!this.readyEmitted) {
          this.readyEmitted = true;
          queueMicrotask(() =>
            this.emit("ready", {
              screen: { width: 1920, height: 1080, scaleFactor: 1, visibleX: 0, visibleY: 0, visibleWidth: 1920, visibleHeight: 1080 },
              screens: [],
              appearance: { darkMode: true, accentColor: null, reduceMotion: false, increaseContrast: false },
              cursor: { x: 0, y: 0 },
              cursorTip: null,
            }),
          );
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
        return;
      }

      /* glimpse.send(data) */
      if (req.method === "POST" && url.pathname === "/api/message") {
        try {
          const body = await readBody(req);
          const data = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("ok");
          this.emit("message", data);
        } catch {
          res.writeHead(400);
          res.end("bad request");
        }
        return;
      }

      /* glimpse.close() */
      if (req.method === "POST" && url.pathname === "/api/close") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        this.doClose();
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    this.httpServer.listen(0, "127.0.0.1", () => {
      const port = (this.httpServer!.address() as AddressInfo).port;
      this.launchBrowser(browserPath, port, options);
    });
  }

  /* ── Browser launch ──────────────────────────────────────────────────── */

  private launchBrowser(
    browserPath: string,
    port: number,
    options: WSLWindowOptions,
  ): void {
    const width = options.width ?? 800;
    const height = options.height ?? 600;

    // A unique profile dir on the Windows filesystem is required so that
    // Chrome launches a fresh instance instead of delegating to an
    // already-running one (which would cause the spawned process to exit
    // immediately).
    const winTemp = getWindowsTemp();
    const profileDir = `${winTemp}\\glimpse-wsl-${Date.now()}`;

    const args = [
      `--app=http://localhost:${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
    ];

    this.proc = spawn(browserPath, args, {
      stdio: "ignore",
      detached: false,
    });

    this.proc.on("exit", () => {
      this.doClose();
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });
  }

  /* ── Public API (matches GlimpseWindow) ──────────────────────────────── */

  send(_js: string): void {
    /* eval in browser — not needed for diff-review, no-op */
  }

  setHTML(_html: string): void {
    /* not needed for diff-review */
  }

  close(): void {
    this.doClose();
  }

  /* ── Internal cleanup ────────────────────────────────────────────────── */

  private doClose(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.proc != null) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }

    if (this.httpServer != null) {
      try { this.httpServer.close(); } catch { /* ignore */ }
      this.httpServer = null;
    }

    this.emit("closed");
  }
}

/* ── HTML injection helper ─────────────────────────────────────────────────── */

function injectBridge(html: string): string {
  const lowerHtml = html.toLowerCase();
  const headIdx = lowerHtml.indexOf("<head>");
  if (headIdx !== -1) {
    const insertAt = headIdx + "<head>".length;
    return html.slice(0, insertAt) + BRIDGE_SCRIPT + html.slice(insertAt);
  }
  // No <head> — prepend
  return BRIDGE_SCRIPT + html;
}

/* ── Public API ────────────────────────────────────────────────────────────── */

export function openWSL(
  html: string,
  options: WSLWindowOptions = {},
): WSLWindow {
  return new WSLWindow(html, options);
}
