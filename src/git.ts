import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ChangeStatus, DiffReviewFile } from "./types.js";

interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runGitAllowFailure(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    throw new Error("Not inside a git repository.");
  }
  return result.stdout.trim();
}

async function hasHead(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
  const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  return result.code === 0;
}

function parseNameStatus(output: string): ChangedPath[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changes: ChangedPath[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0];

    if (code === "R") {
      const oldPath = parts[1] ?? null;
      const newPath = parts[2] ?? null;
      if (oldPath != null && newPath != null) {
        changes.push({ status: "renamed", oldPath, newPath });
      }
      continue;
    }

    if (code === "M") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "modified", oldPath: path, newPath: path });
      }
      continue;
    }

    if (code === "A") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "added", oldPath: null, newPath: path });
      }
      continue;
    }

    if (code === "D") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "deleted", oldPath: path, newPath: null });
      }
    }
  }

  return changes;
}

async function getHeadContent(pi: ExtensionAPI, repoRoot: string, path: string): Promise<string> {
  const result = await pi.exec("git", ["show", `HEAD:${path}`], { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch {
    return "";
  }
}

function parseUntrackedPaths(output: string): ChangedPath[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => ({
      status: "added" as const,
      oldPath: null,
      newPath: path,
    }));
}

function mergeChangedPaths(tracked: ChangedPath[], untracked: ChangedPath[]): ChangedPath[] {
  const seen = new Set(tracked.map((change) => `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`));
  const merged = [...tracked];

  for (const change of untracked) {
    const key = `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`;
    if (seen.has(key)) continue;
    merged.push(change);
    seen.add(key);
  }

  return merged;
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === "renamed") {
    return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

export async function getDiffReviewFiles(pi: ExtensionAPI, cwd: string): Promise<{ repoRoot: string; files: DiffReviewFile[] }> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const repositoryHasHead = await hasHead(pi, repoRoot);

  const trackedOutput = repositoryHasHead
    ? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"])
    : "";
  const untrackedOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"]);

  const trackedPaths = parseNameStatus(trackedOutput);
  const untrackedPaths = parseUntrackedPaths(untrackedOutput);
  const changedPaths = mergeChangedPaths(trackedPaths, untrackedPaths);

  const files = await Promise.all(
    changedPaths.map(async (change, index): Promise<DiffReviewFile> => {
      const oldContent = change.oldPath == null ? "" : await getHeadContent(pi, repoRoot, change.oldPath);
      const newContent = change.newPath == null ? "" : await getWorkingTreeContent(repoRoot, change.newPath);
      return {
        id: `${index}:${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`,
        status: change.status,
        oldPath: change.oldPath,
        newPath: change.newPath,
        displayPath: toDisplayPath(change),
        oldContent,
        newContent,
      };
    }),
  );

  return { repoRoot, files };
}
