import { isAbsolute, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { getDiffReviewFiles, getRepoRoot } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import type { ReviewSubmitPayload, ReviewWindowMessage } from "./types.js";
import { buildReviewHtml } from "./ui.js";
import { isWSL, openWSL, type WSLWindow } from "./wsl-bridge.js";

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

type WaitingEditorResult = "escape" | "window-settled";

type ReviewWindow = GlimpseWindow | WSLWindow;

export default function (pi: ExtensionAPI) {
  let activeWindow: ReviewWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  /* ── Track files touched during this session ───────────────────────── */

  const sessionTouchedFiles = new Set<string>();

  /** Normalise an absolute path to a repo-relative path (best-effort). */
  function toRepoRelative(absPath: string, cwd: string): string {
    // Paths from tool calls are typically already absolute.
    const rel = relative(cwd, absPath);
    // If relative() produced something outside the cwd, keep as-is.
    if (rel.startsWith("..") || isAbsolute(rel)) return absPath;
    return rel;
  }

  function recordPath(rawPath: string, cwd: string): void {
    const abs = isAbsolute(rawPath) ? rawPath : undefined;
    // Store the repo-relative form so it matches git diff output.
    sessionTouchedFiles.add(abs != null ? toRepoRelative(abs, cwd) : rawPath);
  }

  pi.on("tool_result", async (event, ctx) => {
    const cwd = ctx.cwd;
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = (event.input as { path?: string }).path;
      if (typeof path === "string") recordPath(path, cwd);
    }
    // bash tool: we can't easily know what files it changed, skip.
  });

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for review")),
            "The native diff review window is open.",
            "Press Escape to cancel and close the review window.",
          ];
          return [
            borderTop,
            ...lines.map((line) => `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
  }

  async function reviewDiff(ctx: ExtensionCommandContext): Promise<void> {
    if (activeWindow != null) {
      ctx.ui.notify("A diff review window is already open.", "warning");
      return;
    }

    const { repoRoot, files } = await getDiffReviewFiles(pi, ctx.cwd);
    if (files.length === 0) {
      ctx.ui.notify("No git diff to review.", "info");
      return;
    }

    // Resolve session-touched paths relative to the repo root so they
    // can be matched against the file ids built by getDiffReviewFiles.
    const sessionFileIds: string[] = [];
    if (sessionTouchedFiles.size > 0) {
      let root: string;
      try {
        root = await getRepoRoot(pi, ctx.cwd);
      } catch {
        root = ctx.cwd;
      }
      const relPaths = new Set<string>();
      for (const p of sessionTouchedFiles) {
        relPaths.add(isAbsolute(p) ? toRepoRelative(p, root) : toRepoRelative(p, root));
      }
      for (const f of files) {
        if ((f.oldPath != null && relPaths.has(f.oldPath)) || (f.newPath != null && relPaths.has(f.newPath))) {
          sessionFileIds.push(f.id);
        }
      }
    }

    const html = buildReviewHtml({ repoRoot, files, sessionFileIds });
    const windowOpts = { width: 1680, height: 1020, title: "pi diff review" };
    const window = isWSL()
      ? openWSL(html, windowOpts)
      : open(html, windowOpts);
    activeWindow = window;

    const waitingUI = showWaitingUI(ctx);

    ctx.ui.notify("Opened native diff review window.", "info");

    try {
      const windowMessagePromise = new Promise<ReviewWindowMessage | null>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          window.removeListener("message", onMessage);
          window.removeListener("closed", onClosed);
          window.removeListener("error", onError);
          if (activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (value: ReviewWindowMessage | null): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const onMessage = (data: unknown): void => {
          settle(data as ReviewWindowMessage);
        };

        const onClosed = (): void => {
          settle(null);
        };

        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        window.on("message", onMessage);
        window.on("closed", onClosed);
        window.on("error", onError);
      });

      const result = await Promise.race([
        windowMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await windowMessagePromise.catch(() => null);
        ctx.ui.notify("Diff review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await windowMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Diff review cancelled.", "info");
        return;
      }

      if (!isSubmitPayload(message)) {
        ctx.ui.notify("Diff review returned an unknown payload.", "error");
        return;
      }

      const prompt = composeReviewPrompt(files, message);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted diff review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Diff review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a native diff review window and insert review feedback into the editor",
    handler: async (_args, ctx) => {
      await reviewDiff(ctx);
    },
  });

  pi.on("session_start", async () => {
    sessionTouchedFiles.clear();
  });

  pi.on("session_switch", async () => {
    sessionTouchedFiles.clear();
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
