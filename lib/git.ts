import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { FileGroup, GitFile, GitState } from "../contract.ts";

const execFileAsync = promisify(execFile);

// ponytail: execFile + arg arrays. simple-git crashes BB path-plugin loader (query-string module hook).
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 20_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    throw new Error([e.stderr, e.stdout, e.message].filter(Boolean).join("\n").trim());
  }
}

async function gitOk(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

export class GitOpError extends Error {
  readonly code: "auth" | "no-upstream" | "diverged" | "generic";
  constructor(code: GitOpError["code"], message: string) {
    super(message);
    this.name = "GitOpError";
    this.code = code;
  }
}

export function assertRelPath(path: string): void {
  if (
    path === "" ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes("..")
  ) {
    throw new Error("invalid path");
  }
}

function emptyState(root: string | null): GitState {
  return {
    present: false,
    root,
    name: root ? basename(root) : null,
    empty: false,
    detached: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    remotes: [],
    branches: [],
    staged: [],
    changes: [],
    untracked: [],
    conflicts: [],
  };
}

function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  return raw.slice(1, -1).replace(/\\([n"\\t])/g, (_, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    return ch;
  });
}

/** Parse `git status --porcelain=v1` lines. */
export function parsePorcelain(text: string): GitFile[] {
  const files: GitFile[] = [];
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    const rest = line.slice(3);
    let from: string | undefined;
    let path: string;
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0 && (index === "R" || index === "C" || worktree === "R")) {
      from = unquote(rest.slice(0, arrow));
      path = unquote(rest.slice(arrow + 4));
    } else {
      path = unquote(rest);
    }
    const letter = (worktree !== " " && worktree !== "?" ? worktree : index).trim() || "?";
    // ponytail: null not undefined — undefined is dropped by JSON and the RPC
    // validator rejects the missing key ("not a JSON value")
    files.push({ path, from: from ?? null, index, worktree, letter });
  }
  return files;
}

export function groupFiles(files: GitFile[]): Pick<GitState, "staged" | "changes" | "untracked" | "conflicts"> {
  const staged: GitFile[] = [];
  const changes: GitFile[] = [];
  const untracked: GitFile[] = [];
  const conflicts: GitFile[] = [];
  for (const file of files) {
    const unmerged =
      file.index === "U" ||
      file.worktree === "U" ||
      (file.index === "A" && file.worktree === "A") ||
      (file.index === "D" && file.worktree === "D");
    if (unmerged) {
      conflicts.push(file);
      continue;
    }
    if (file.index === "?" || file.worktree === "?") {
      untracked.push(file);
      continue;
    }
    if (file.index !== " ") staged.push(file);
    if (file.worktree !== " ") changes.push(file);
  }
  return { staged, changes, untracked, conflicts };
}

function parseNumstat(raw: string): Map<string, { additions: number | null; deletions: number | null }> {
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  const records = raw.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const added = record.slice(0, first);
    const deleted = record.slice(first + 1, second);
    let path = record.slice(second + 1);
    if (path === "") {
      // With -z, renamed paths are two more NUL-delimited fields: old, new.
      path = records[i + 2] ?? "";
      i += 2;
    }
    if (!path) continue;
    counts.set(path, {
      additions: added === "-" ? null : Number(added),
      deletions: deleted === "-" ? null : Number(deleted),
    });
  }
  return counts;
}

function lineCount(content: string): number {
  return content === "" ? 0 : (content.match(/\n/g)?.length ?? 0) + (content.endsWith("\n") ? 0 : 1);
}

const untrackedCounts = new Map<string, Map<string, { revision: string; additions: number | null }>>();

export function syntheticAddPatch(path: string, content: string): string {
  const header = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
  ];
  if (content === "") return `${header.join("\n")}\n`;
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunk = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
  return `${header.join("\n")}\n${hunk.join("\n")}\n`;
}

function classify(err: unknown): GitOpError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("could not read password") ||
    lower.includes("permission denied (publickey)") ||
    lower.includes("terminal prompts disabled")
  ) {
    return new GitOpError("auth", message);
  }
  if (lower.includes("no upstream") || lower.includes("has no upstream branch")) {
    return new GitOpError("no-upstream", message);
  }
  if (
    lower.includes("not possible to fast-forward") ||
    lower.includes("diverging") ||
    lower.includes("need to specify how to reconcile")
  ) {
    return new GitOpError(
      "diverged",
      "Pull is not fast-forward (branches have diverged). Merge or rebase outside Gitx.",
    );
  }
  return new GitOpError("generic", message);
}

async function show(cwd: string, spec: string): Promise<string> {
  return (await gitOk(cwd, ["show", spec])) ?? "";
}

async function readWorktree(cwd: string, path: string): Promise<string | null> {
  try {
    const target = join(cwd, path);
    const info = await lstat(target);
    if (!info.isFile() || info.size > 1_000_000) return null;
    const inside = relative(await realpath(cwd), await realpath(target));
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
    const bytes = await readFile(target);
    return bytes.includes(0) || bytes.length > 1_000_000 ? null : bytes.toString("utf8");
  } catch {
    return null;
  }
}

export async function gitDirInfo(cwd: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const inside = (await gitOk(cwd, ["rev-parse", "--is-inside-work-tree"]))?.trim();
  if (inside !== "true") return null;
  const gitDir = (await git(cwd, ["rev-parse", "--git-dir"])).trim();
  const commonDir = (await git(cwd, ["rev-parse", "--git-common-dir"])).trim();
  return {
    gitDir: isAbsolute(gitDir) ? gitDir : join(cwd, gitDir),
    commonDir: isAbsolute(commonDir) ? commonDir : join(cwd, commonDir),
  };
}

function parseAheadBehind(raw: string | null): { ahead: number; behind: number } {
  if (!raw) return { ahead: 0, behind: 0 };
  const [ahead, behind] = raw.trim().split(/\s+/).map((n) => Number(n));
  return { ahead: ahead || 0, behind: behind || 0 };
}

export async function readState(cwd: string): Promise<GitState> {
  const inside = (await gitOk(cwd, ["rev-parse", "--is-inside-work-tree"]))?.trim();
  if (inside !== "true") return emptyState(cwd);

  const empty = (await gitOk(cwd, ["rev-parse", "HEAD"])) === null;
  const porcelain = await git(cwd, ["status", "--porcelain=v1", "-uall"]);
  const files = parsePorcelain(porcelain);
  await Promise.all(files.map(async (file) => {
    try {
      const info = await lstat(join(cwd, file.path));
      file.revision = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    } catch {
      file.revision = "missing";
    }
  }));
  const grouped = groupFiles(files);
  if (grouped.staged.length > 0) {
    const indexDiff = await git(cwd, ["diff", "--cached", "--raw", "--no-renames"]);
    const revision = createHash("sha1").update(indexDiff).digest("hex");
    const counts = parseNumstat((await gitOk(cwd, ["diff", "--cached", "--numstat", "--find-renames", "-z"])) ?? "");
    grouped.staged = grouped.staged.map((file) => ({ ...file, revision, ...counts.get(file.path) }));
  }
  if (grouped.changes.length > 0) {
    const counts = parseNumstat((await gitOk(cwd, ["diff", "--numstat", "--find-renames", "-z"])) ?? "");
    grouped.changes = grouped.changes.map((file) => ({ ...file, ...counts.get(file.path) }));
  }
  const priorCounts = untrackedCounts.get(cwd);
  const nextCounts = new Map<string, { revision: string; additions: number | null }>();
  await Promise.all(grouped.untracked.map(async (file) => {
    const cached = priorCounts?.get(file.path);
    let additions: number | null;
    if (cached && cached.revision === file.revision) additions = cached.additions;
    else {
      const content = await readWorktree(cwd, file.path);
      additions = content === null ? null : lineCount(content);
    }
    file.additions = additions;
    file.deletions = additions === null ? null : 0;
    nextCounts.set(file.path, { revision: file.revision ?? "missing", additions });
  }));
  untrackedCounts.set(cwd, nextCounts);
  const abbrev = (await gitOk(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() ?? "HEAD";
  const detached = !empty && abbrev === "HEAD";
  const branch = empty
    ? ((await gitOk(cwd, ["symbolic-ref", "--short", "HEAD"]))?.trim() ?? null)
    : detached
      ? ((await gitOk(cwd, ["rev-parse", "--short", "HEAD"]))?.trim() ?? "HEAD")
      : abbrev;
  const upstream = (await gitOk(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]))?.trim() ?? null;
  const aheadBehind = upstream
    ? parseAheadBehind(await gitOk(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]))
    : { ahead: 0, behind: 0 };
  const remotes = (await gitOk(cwd, ["remote"]))?.split("\n").map((n) => n.trim()).filter(Boolean) ?? [];
  const branches = (await gitOk(cwd, ["branch", "--format=%(refname:short)"]))
    ?.split("\n")
    .map((n) => n.trim())
    .filter(Boolean) ?? [];

  return {
    present: true,
    root: cwd,
    name: basename(cwd),
    empty,
    detached,
    branch,
    upstream,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    remotes,
    branches,
    ...grouped,
  };
}

export async function readDiff(
  cwd: string,
  path: string,
  group: FileGroup,
): Promise<{ path: string; patch: string; oldContent: string; newContent: string }> {
  assertRelPath(path);
  if (group === "untracked") {
    const content = await readWorktree(cwd, path);
    if (content === null || content === "") {
      return { path, patch: "", oldContent: "", newContent: "" };
    }
    return {
      path,
      patch: syntheticAddPatch(path, content),
      oldContent: "",
      newContent: content,
    };
  }
  if (group === "staged") {
    const patch = await git(cwd, ["diff", "--cached", "--", path]);
    const oldContent = await show(cwd, `HEAD:${path}`);
    const newContent = await show(cwd, `:${path}`);
    return { path, patch, oldContent, newContent };
  }
  const patch = await git(cwd, ["diff", "--", path]);
  const oldContent = await show(cwd, `:${path}`);
  const newContent = (await readWorktree(cwd, path)) ?? "";
  return { path, patch, oldContent, newContent };
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classify(err);
  }
}

export async function stage(cwd: string, paths: string[]): Promise<void> {
  paths.forEach(assertRelPath);
  await wrap(() => git(cwd, ["add", "--", ...paths]));
}

export async function unstage(cwd: string, paths: string[]): Promise<void> {
  paths.forEach(assertRelPath);
  await wrap(async () => {
    if (await gitOk(cwd, ["rev-parse", "HEAD"])) {
      await git(cwd, ["restore", "--staged", "--", ...paths]);
    } else {
      await git(cwd, ["rm", "--cached", "-f", "--", ...paths]);
    }
  });
}

export async function discard(cwd: string, paths: string[], group: FileGroup): Promise<void> {
  paths.forEach(assertRelPath);
  await wrap(async () => {
    if (group === "untracked") {
      await git(cwd, ["clean", "-fd", "--", ...paths]);
      return;
    }
    if (group === "staged") {
      if (await gitOk(cwd, ["rev-parse", "HEAD"])) {
        await git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths]);
      } else {
        await git(cwd, ["rm", "--cached", "-f", "--", ...paths]);
        await git(cwd, ["clean", "-fd", "--", ...paths]);
      }
      return;
    }
    await git(cwd, ["restore", "--worktree", "--", ...paths]);
  });
}

export async function commit(cwd: string, message: string): Promise<void> {
  await wrap(() => git(cwd, ["commit", "-m", message]));
}

export async function push(cwd: string): Promise<void> {
  await wrap(() => git(cwd, ["push"]));
}

export async function pullFf(cwd: string): Promise<void> {
  await wrap(() => git(cwd, ["pull", "--ff-only"]));
}

export async function fetchAll(cwd: string): Promise<void> {
  await wrap(() => git(cwd, ["fetch", "--all", "--prune"]));
}

export async function syncFf(cwd: string): Promise<void> {
  await pullFf(cwd);
  await push(cwd);
}

export async function commitPush(cwd: string, message: string): Promise<void> {
  await commit(cwd, message);
  await push(cwd);
}

export async function commitSync(cwd: string, message: string): Promise<void> {
  await commit(cwd, message);
  await syncFf(cwd);
}

export async function publish(cwd: string): Promise<void> {
  await wrap(async () => {
    const remotes = (await git(cwd, ["remote"])).split("\n").map((n) => n.trim()).filter(Boolean);
    const remote = remotes[0];
    if (!remote) throw new Error("No remote configured");
    await git(cwd, ["push", "-u", remote, "HEAD"]);
  });
}

export async function checkout(cwd: string, branch: string): Promise<void> {
  if (!branch.trim() || branch.includes("..")) throw new Error("invalid branch");
  await wrap(() => git(cwd, ["checkout", branch]));
}

export async function createBranch(cwd: string, name: string): Promise<void> {
  if (!name.trim() || name.includes("..")) throw new Error("invalid branch");
  await wrap(() => git(cwd, ["checkout", "-b", name]));
}
