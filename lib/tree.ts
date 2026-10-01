import type { FileGroup, GitFile, GitState } from "../contract.ts";

/** Keep index and working-tree reviews separate, even for the same path. */
export function changeSections(
  state: Pick<GitState, "staged" | "changes" | "untracked" | "conflicts">,
  scope: "all" | "staged" | "unstaged",
) {
  const sections: { id: "staged" | "unstaged" | "conflicts"; label: string; groups: FileGroup[] }[] = [
    { id: "staged", label: "Staged", groups: ["staged"] },
    { id: "unstaged", label: "Unstaged", groups: ["changes", "untracked"] },
    { id: "conflicts", label: "Merge conflicts", groups: ["conflicts"] },
  ];
  return sections
    .filter((section) => scope === "all" || section.id === scope)
    .map((section) => ({
      id: section.id,
      label: section.label,
      entries: section.groups.flatMap((group) => state[group].map((file) => ({
        key: `${group}:${file.path}`, file, group,
      }))),
    }))
    .filter((section) => section.entries.length > 0);
}

/** Right-edge SCM letter. Combined `¡M, M` only on Changes when both sides dirty. */
export function statusBadge(file: GitFile, group: FileGroup): string {
  if (group === "untracked") return "U";
  if (group === "conflicts") return "U";
  const i = file.index === " " ? "" : file.index;
  const w = file.worktree === " " ? "" : file.worktree;
  if (group === "changes" && i && w) return `¡${i}, ${w}`;
  if (group === "staged") return i || file.letter;
  return w || i || file.letter;
}

/** VS Code SCM row: filename, then parent path. */
export function fileParts(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  if (i < 0) return { name: path, dir: "" };
  return { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/** Short type chip (TS, JS, MD). */
export function extLabel(name: string): string {
  const raw = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : "";
  if (raw === "TSX") return "TS";
  if (raw === "JSX") return "JS";
  if (raw === "MDX" || raw === "MARKDOWN") return "MD";
  return (raw || "FILE").slice(0, 4);
}

export function syncCaption(ahead: number, behind: number): string {
  if (behind > 0 && ahead > 0) return `Sync Changes ${behind}↓ ${ahead}↑`;
  if (behind > 0) return `Sync Changes ${behind}↓`;
  if (ahead > 0) return `Sync Changes ${ahead}↑`;
  return "Sync Changes";
}

export function isTextPatch(patch: string): boolean {
  return patch.trim() !== "" && !/^(?:Binary files .* differ|GIT binary patch)$/m.test(patch);
}
