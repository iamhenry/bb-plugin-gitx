import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { gitDirInfo } from "./git.ts";

const DEBOUNCE_MS = 300;

export async function watchGitState(
  cwd: string,
  onChange: () => void,
  signal: AbortSignal,
): Promise<void> {
  const info = await gitDirInfo(cwd);
  if (!info || signal.aborted) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, DEBOUNCE_MS);
  };

  const watchers: FSWatcher[] = [];
  // Directory watches (non-recursive): index is replaced in-place as a new inode.
  const targets = [info.gitDir, join(info.commonDir, "refs", "heads")];
  for (const target of targets) {
    try {
      watchers.push(watch(target, { persistent: false, recursive: false }, fire));
    } catch {
      // missing refs/heads in a brand-new repo is fine
    }
  }

  const stop = () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
}
