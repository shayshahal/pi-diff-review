import type { DiffReviewComment, DiffReviewFile, ReviewSubmitPayload } from "./types.js";

/** Number of context lines to show above/below the commented line. */
const CONTEXT_LINES = 3;

function formatLocation(comment: DiffReviewComment, filePath: string): string {
  if (comment.side === "file" || comment.startLine == null) {
    return filePath;
  }
  const suffix = comment.side === "original" ? " (old)" : " (new)";
  if (comment.endLine != null && comment.endLine !== comment.startLine) {
    return `${filePath}:${comment.startLine}-${comment.endLine}${suffix}`;
  }
  return `${filePath}:${comment.startLine}${suffix}`;
}

function inferLanguage(path: string | null): string {
  if (path == null) return "";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
    json: "json", md: "markdown", css: "css", html: "html", sh: "bash",
    yml: "yaml", yaml: "yaml", rs: "rust", java: "java", kt: "kotlin",
    py: "python", go: "go", svelte: "svelte", vue: "vue", sql: "sql",
    swift: "swift", rb: "ruby", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  };
  return map[ext] ?? "";
}

/** Extract a snippet of source lines around the commented region. */
function extractSnippet(
  content: string,
  startLine: number,
  endLine: number | null,
  lang: string,
): string {
  const allLines = content.split("\n");
  const first = Math.max(0, startLine - 1 - CONTEXT_LINES);
  const last = Math.min(allLines.length - 1, (endLine ?? startLine) - 1 + CONTEXT_LINES);
  const snippet = allLines.slice(first, last + 1);
  if (snippet.length === 0) return "";

  const tag = lang ? "```" + lang : "```";
  return `${tag}\n${snippet.join("\n")}\n\`\`\``;
}

export function composeReviewPrompt(files: DiffReviewFile[], payload: ReviewSubmitPayload): string {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const lines: string[] = [];

  lines.push("Fix these code review issues:");
  lines.push("");

  const overallComment = payload.overallComment.trim();
  if (overallComment.length > 0) {
    lines.push(overallComment);
    lines.push("");
  }

  payload.comments.forEach((comment, index) => {
    const file = fileMap.get(comment.fileId);
    const filePath = file?.displayPath ?? comment.fileId;
    const lang = inferLanguage(file?.newPath ?? file?.oldPath ?? null);

    lines.push(`${index + 1}. **${formatLocation(comment, filePath)}**`);

    // Include a code snippet for inline comments.
    if (comment.startLine != null && file != null) {
      const content = comment.side === "original" ? file.oldContent : file.newContent;
      if (content.length > 0) {
        const snippet = extractSnippet(content, comment.startLine, comment.endLine, lang);
        if (snippet.length > 0) {
          lines.push(snippet);
        }
      }
    }

    lines.push(`   → ${comment.body.trim()}`);
    lines.push("");
  });

  return lines.join("\n").trim();
}
