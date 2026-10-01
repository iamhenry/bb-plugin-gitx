import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_ProviderModelPicker,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { GitDiff } from "@/components/git-diff";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { changeSections, extLabel, fileParts, isTextPatch, statusBadge, syncCaption } from "@/lib/tree.ts";
import { DEFAULT_WALKTHROUGH_PROMPT } from "@/lib/walkthrough-prompt.ts";
import {
  GIT_STATE_CHANNEL,
  type FileGroup,
  type GitFile,
  type GitState,
  type WalkthroughSettings,
  type gitxRpc,
} from "./contract.ts";

type DiffView = "unified" | "split";
const ProviderModelPicker = experimental_ProviderModelPicker;

function ChangePatch({
  ctx,
  group,
  path,
  view,
}: {
  ctx: { projectId: string | null; threadId: string | null };
  group: FileGroup;
  path: string;
  view: DiffView;
}) {
  const rpc = useRpc<typeof gitxRpc>();
  const [result, setResult] = useState<{
    path: string; patch: string; oldContent: string; newContent: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    rpc.call("getDiff", { ...ctx, path, group }).then(
      (next) => { if (active) { setResult(next); setError(null); } },
      (reason) => { if (active) setError(errMessage(reason)); },
    );
    return () => { active = false; };
  }, [rpc, ctx, group, path]);

  if (error) return <p role="alert" className="p-2 text-xs text-destructive">{error}</p>;
  if (!result) return <p className="p-2 text-xs text-muted-foreground">Loading diff…</p>;
  if (group === "conflicts") return <p className="p-2 text-xs text-muted-foreground">Merge conflict. Open the file to resolve it, then refresh Changes.</p>;
  if (!isTextPatch(result.patch)) {
    return <p className="p-2 text-xs text-muted-foreground">No text diff available for this file.</p>;
  }
  return <GitDiff {...result} view={view} />;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function letterClass(letter: string) {
  if (letter.includes("U") || letter.includes("A") || letter.includes("D")) return "text-destructive";
  if (letter.includes("M") || letter.includes("R")) return "text-amber-500";
  return "text-muted-foreground";
}

function Flyout({
  align = "right",
  trigger,
  children,
}: {
  align?: "left" | "right";
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex h-full">
      <span
        className="flex h-full"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {trigger}
      </span>
      {open ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-10 cursor-default"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
          <div
            className={cn(
              "absolute z-20 mt-1 min-w-[11rem] rounded-md border border-border bg-background p-1 shadow-md",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            {children(() => setOpen(false))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function MenuItem({
  disabled,
  onClick,
  children,
  pressed,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={pressed}
      className="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-state-hover disabled:opacity-50"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function IconBtn({
  label,
  disabled,
  onClick,
  name,
  header,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  name: ComponentProps<typeof Icon>["name"];
  header?: boolean;
}) {
  return (
    <span title={label}>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={header ? COARSE_POINTER_HEADER_ICON_BUTTON_CLASS : COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS}
        disabled={disabled}
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      >
        <Icon name={name} />
      </Button>
    </span>
  );
}

function SourceControl({
  projectId: projectIdProp,
  threadId: threadIdProp,
}: {
  projectId?: string | null;
  threadId?: string | null;
} = {}) {
  const host = useBbContext();
  const projectId = projectIdProp !== undefined ? projectIdProp : host.projectId;
  const threadId = threadIdProp !== undefined ? threadIdProp : host.threadId;
  const rpc = useRpc<typeof gitxRpc>();
  const navigate = useBbNavigate();
  const ctx = useMemo(
    () => ({ projectId, threadId }),
    [projectId, threadId],
  );
  const [state, setState] = useState<GitState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"all" | "staged" | "unstaged">("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());
  const [layout, setLayout] = useState<DiffView>("unified");
  const [overrides, setOverrides] = useState<Record<string, DiffView>>({});
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  const [refreshDiffs, setRefreshDiffs] = useState(0);
  const changesRef = useRef<HTMLElement>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState<{
    paths: string[];
    group: FileGroup;
  } | null>(null);

  const report = useCallback((err: unknown) => {
    const text = errMessage(err);
    setError(text);
    toast.error(text);
  }, []);

  const refetch = useCallback(() => {
    rpc.call("getState", ctx).then((next) => {
      setState(next);
      setError(null);
    }, report);
  }, [rpc, ctx, report]);

  const fetchRemote = useCallback(
    (force = false) => {
      void rpc.call("fetch", { ...ctx, force }).then((next) => {
        setState(next);
        setError(null);
      }, report);
    },
    [rpc, ctx, report],
  );

  useEffect(() => {
    refetch();
    fetchRemote();
  }, [refetch, fetchRemote]);

  useRealtime(GIT_STATE_CHANNEL, refetch);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      refetch();
      setRefreshDiffs((value) => value + 1);
      fetchRemote();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    // ponytail: worktree edits skip .git; 1s poll while visible
    const poll = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refetch();
    }, 1000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      clearInterval(poll);
    };
  }, [refetch, fetchRemote]);

  const run = async (fn: () => Promise<GitState>) => {
    if (busy) return;
    setBusy(true);
    try {
      setState(await fn());
      setRefreshDiffs((value) => value + 1);
      setError(null);
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  };

  const pathsOf = (group: FileGroup) =>
    (state?.[group] ?? []).map((file) => file.path);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!state) {
    return <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
  }

  if (!state.present) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">No git repository</p>
        <p className="mt-1">Open a project that is a git repo. Gitx does not initialize repos in V1.</p>
      </div>
    );
  }

  const branchLabel = state.detached
    ? `detached ${state.branch ?? "HEAD"}`
    : (state.branch ?? "HEAD");
  const aheadBehind =
    state.upstream == null ? "no upstream" : `↑${state.ahead} ↓${state.behind}`;
  const canCommit = message.trim() !== "" && state.staged.length > 0;
  const canCommitAll =
    message.trim() !== "" &&
    state.staged.length + state.changes.length + state.untracked.length > 0;
  const primary =
    state.staged.length > 0
      ? "commit"
      : state.upstream && (state.ahead > 0 || state.behind > 0)
        ? "sync"
        : state.upstream == null && state.remotes.length > 0 && !state.empty
          ? "publish"
          : "idle";
  const splitH = "h-9 max-md:pointer-coarse:h-10";

  const sections = changeSections(state, scope);
  const visible = sections.flatMap((section) => section.entries);
  const allChangesCount = new Set(
    [...state.staged, ...state.changes, ...state.untracked, ...state.conflicts].map((file) => file.path),
  ).size;
  const stagedCount = new Set(state.staged.map((file) => file.path)).size;
  const unstagedCount = new Set([...state.changes, ...state.untracked].map((file) => file.path)).size;
  const allExpanded = visible.length > 0 && sections.every((section) => !collapsedSections.has(section.id)) && visible.every((entry) => expanded.has(entry.key));
  const allSplit = visible.length > 0 && visible.every((entry) => (overrides[entry.key] ?? layout) === "split");

  const openChanges = () => changesRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });

  const editFile = async (path: string) => {
    try {
      const target = await rpc.call("getEditTarget", { ...ctx, path });
      if (!navigate.experimental_openFileExternally({
        target, location: null,
      })) throw new Error("No editor is available for this file");
    } catch (reason) { report(reason); }
  };

  const doCommit = (kind: "commit" | "push" | "sync") => {
    const next = message.trim();
    if (!next || state.staged.length === 0) return;
    void run(async () => {
      const method = kind === "commit" ? "commit" : kind === "push" ? "commitPush" : "commitSync";
      const result = await rpc.call(method, { ...ctx, message: next });
      setMessage("");
      return result;
    });
  };

  const commitAll = () => {
    const next = message.trim();
    if (!next) return;
    void run(async () => {
      const extra = [...pathsOf("changes"), ...pathsOf("untracked")];
      if (extra.length) await rpc.call("stage", { ...ctx, paths: extra });
      const result = await rpc.call("commit", { ...ctx, message: next });
      setMessage("");
      return result;
    });
  };

  const doSync = () => {
    if (state.upstream) void run(() => rpc.call("sync", ctx));
    else if (state.remotes.length > 0) void run(() => rpc.call("publish", ctx));
  };

  const rowActions = (file: GitFile, group: FileGroup) => (
    <div
      key={group}
      className="flex shrink-0 items-center gap-0.5"
    >
      {group === "staged" ? (
        <IconBtn
          label={`Unstage ${file.path}`}
          name="FolderMinus"
          disabled={busy}
          onClick={() => run(() => rpc.call("unstage", { ...ctx, paths: [file.path] }))}
        />
      ) : group !== "conflicts" ? (
        <>
          <IconBtn
            label={`Discard ${file.path}`}
            name="RotateCcw"
            disabled={busy}
            onClick={() => setDiscarding({ paths: [file.path], group })}
          />
          <IconBtn
            label={`Stage ${file.path}`}
            name="Plus"
            disabled={busy}
            onClick={() => run(() => rpc.call("stage", { ...ctx, paths: [file.path] }))}
          />
        </>
      ) : null}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1 border-b border-border px-2 py-1">
        <select
          className="max-w-[10rem] rounded-md border border-input bg-transparent px-1 py-0.5 text-xs"
          value={state.detached ? "" : (state.branch ?? "")}
          disabled={busy || state.detached}
          aria-label="Branch"
          onChange={(event) => {
            const branch = event.target.value;
            if (branch) void run(() => rpc.call("checkout", { ...ctx, branch }));
          }}
        >
          {state.detached ? <option value="">{branchLabel}</option> : null}
          {state.branches.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
        </select>
        <span className="truncate text-xs text-muted-foreground">{aheadBehind}</span>
        {state.empty ? <span className="text-xs text-muted-foreground">empty</span> : null}
        <div className="ml-auto flex items-center">
          <IconBtn header label="Open Changes" name="FileDiff" onClick={openChanges} />
          <IconBtn header label="Commit All" name="Check" disabled={busy || !canCommitAll} onClick={commitAll} />
          <IconBtn
            header
            label={state.upstream ? "Sync" : "Publish"}
            name="Repeat"
            disabled={busy || (state.upstream == null && state.remotes.length === 0)}
            onClick={doSync}
          />
          <IconBtn header label="Refresh" name="ArrowReloadHorizontal" onClick={() => { refetch(); setRefreshDiffs((value) => value + 1); }} />
          <Flyout
            trigger={
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={COARSE_POINTER_HEADER_ICON_BUTTON_CLASS}
                aria-label="More actions"
              >
                <Icon name="MoreHorizontal" />
              </Button>
            }
          >
            {(close) => (
              <>
                <MenuItem
                  disabled={busy}
                  onClick={() => {
                    close();
                    fetchRemote(true);
                  }}
                >
                  Fetch
                </MenuItem>
                <MenuItem
                  disabled={busy || state.upstream == null}
                  onClick={() => {
                    close();
                    void run(() => rpc.call("pull", ctx));
                  }}
                >
                  Pull
                </MenuItem>
                <MenuItem
                  disabled={busy || state.upstream == null}
                  onClick={() => {
                    close();
                    void run(() => rpc.call("push", ctx));
                  }}
                >
                  Push
                </MenuItem>
                <MenuItem
                  disabled={busy || state.upstream != null || state.remotes.length === 0}
                  onClick={() => {
                    close();
                    void run(() => rpc.call("publish", ctx));
                  }}
                >
                  Publish Branch
                </MenuItem>
                <MenuItem
                  disabled={busy}
                  onClick={() => {
                    close();
                    const name = window.prompt("New branch name");
                    if (name?.trim()) void run(() => rpc.call("createBranch", { ...ctx, name: name.trim() }));
                  }}
                >
                  Create Branch…
                </MenuItem>
              </>
            )}
          </Flyout>
        </div>
      </header>

      {error ? (
        <p role="alert" className="px-3 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="border-b border-border p-2">
        <textarea
          className="mb-2 min-h-[4rem] w-full resize-y rounded-md border border-input bg-transparent p-2 text-sm"
          placeholder="Message (Ctrl+Enter to commit)"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              doCommit("commit");
            }
          }}
        />
        {primary === "sync" ? (
          <Button type="button" className={cn("w-full", splitH)} disabled={busy} onClick={doSync}>
            <Icon name="Repeat" className="size-3.5" />
            {syncCaption(state.ahead, state.behind)}
          </Button>
        ) : primary === "publish" ? (
          <Button type="button" className={cn("w-full", splitH)} disabled={busy} onClick={doSync}>
            Publish Branch
          </Button>
        ) : (
          <div className="flex items-stretch">
            <Button
              type="button"
              className={cn("flex-1 rounded-r-none", splitH)}
              disabled={busy || !canCommit}
              onClick={() => doCommit("commit")}
            >
              Commit {state.staged.length > 0 ? `(${state.staged.length})` : ""}
            </Button>
            <Flyout
              trigger={
                <Button
                  type="button"
                  className={cn("rounded-l-none px-2", splitH)}
                  disabled={busy || !canCommit}
                  aria-label="Commit options"
                >
                  <Icon name="ChevronDown" />
                </Button>
              }
            >
              {(close) => (
                <>
                  <MenuItem
                    disabled={busy || !canCommit}
                    onClick={() => {
                      close();
                      doCommit("commit");
                    }}
                  >
                    Commit
                  </MenuItem>
                  <MenuItem
                    disabled={busy || !canCommit || state.upstream == null}
                    onClick={() => {
                      close();
                      doCommit("push");
                    }}
                  >
                    Commit & Push
                  </MenuItem>
                  <MenuItem
                    disabled={busy || !canCommit || state.upstream == null}
                    onClick={() => {
                      close();
                      doCommit("sync");
                    }}
                  >
                    Commit & Sync
                  </MenuItem>
                  {/* ponytail: amend is V1.5 */}
                </>
              )}
            </Flyout>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section ref={changesRef} aria-label="Changes">
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-2">
            <div className="mr-auto">
              <Flyout align="left" trigger={
                <Button type="button" size="sm" variant="ghost" className="gap-1 font-semibold">
                  {scope === "all" ? `All changes: ${allChangesCount}` : scope === "staged" ? `Staged: ${stagedCount}` : `Unstaged: ${unstagedCount}`}
                  <Icon name="ChevronDown" aria-hidden className="size-3" />
                </Button>
              }>
                {(close) => <>
                  <MenuItem pressed={scope === "all"} onClick={() => { setScope("all"); close(); }}>
                    <span className="flex items-center gap-2"><Icon name="Check" aria-hidden className={cn("size-3", scope !== "all" && "invisible")} />All changes: {allChangesCount}</span>
                  </MenuItem>
                  <MenuItem pressed={scope === "staged"} onClick={() => { setScope("staged"); close(); }}>
                    <span className="flex items-center gap-2"><Icon name="Check" aria-hidden className={cn("size-3", scope !== "staged" && "invisible")} />Staged: {stagedCount}</span>
                  </MenuItem>
                  <MenuItem pressed={scope === "unstaged"} onClick={() => { setScope("unstaged"); close(); }}>
                    <span className="flex items-center gap-2"><Icon name="Check" aria-hidden className={cn("size-3", scope !== "unstaged" && "invisible")} />Unstaged: {unstagedCount}</span>
                  </MenuItem>
                </>}
              </Flyout>
            </div>
            <Button
              type="button" size="sm" variant="ghost" disabled={visible.length === 0}
              onClick={() => {
                setExpanded(allExpanded ? new Set() : new Set(visible.map((entry) => entry.key)));
                if (!allExpanded) setCollapsedSections(new Set());
              }}
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </Button>
            <IconBtn
              label={allSplit ? "Inline for all" : "Split for all"}
              name={allSplit ? "AlignLeft" : "Columns2"}
              disabled={visible.length === 0}
              onClick={() => { setLayout(allSplit ? "unified" : "split"); setOverrides({}); }}
            />
            <Flyout trigger={
              <Button type="button" size="icon" variant="ghost" className={COARSE_POINTER_HEADER_ICON_BUTTON_CLASS} aria-label="More change actions">
                <Icon name="MoreHorizontal" />
              </Button>
            }>
              {(close) => <>
                <MenuItem disabled={busy || state.changes.length === 0} onClick={() => { close(); setDiscarding({ paths: pathsOf("changes"), group: "changes" }); }}>Discard all changes</MenuItem>
                <MenuItem disabled={busy || state.untracked.length === 0} onClick={() => { close(); setDiscarding({ paths: pathsOf("untracked"), group: "untracked" }); }}>Discard all untracked</MenuItem>
              </>}
            </Flyout>
            {/* Future feature: show Generate walkthrough when BB can run a selected provider from plugins.
            <Button type="button" size="sm" variant="outline" onClick={() => setWalkthroughOpen((open) => !open)}>
              Generate walkthrough
            </Button>
            */}
          </div>
          {walkthroughOpen ? (
            <div className="space-y-2 border-b border-border p-3 text-sm">
              <div className="flex items-center justify-between">
                <h3 className="font-medium">Walkthrough · {scope === "all" ? "All changes" : scope === "staged" ? "Staged" : "Unstaged"}</h3>
                <IconBtn label="Close walkthrough" name="X" onClick={() => setWalkthroughOpen(false)} />
              </div>
              <p>No walkthrough yet. Generating one would send the selected code changes to your chosen BB model and consume tokens.</p>
              <p role="status" className="text-xs text-muted-foreground">Generation is unavailable: this BB plugin SDK cannot invoke an arbitrary connected provider for an isolated walkthrough. Your diffs remain available below.</p>
              <Button type="button" size="sm" disabled>Generate</Button>
            </div>
          ) : null}
          {visible.length === 0 ? <p className="p-3 text-sm text-muted-foreground">{allChangesCount === 0 ? "No changes" : "No changes in this scope"}</p> : null}
          {sections.map((section) => (
            <section key={section.id} aria-label={section.label}>
              <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-2 py-1">
                <button
                  type="button"
                  aria-expanded={!collapsedSections.has(section.id)}
                  aria-label={`${collapsedSections.has(section.id) ? "Expand" : "Collapse"} ${section.label} section`}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-semibold"
                  onClick={() => setCollapsedSections((prev) => {
                    const next = new Set(prev);
                    if (next.has(section.id)) next.delete(section.id);
                    else next.add(section.id);
                    return next;
                  })}
                >
                  <Icon name={collapsedSections.has(section.id) ? "ChevronRight" : "ChevronDown"} className="size-3 shrink-0" />
                  {section.label}
                  <span className="text-muted-foreground">{section.entries.length}</span>
                </button>
                {section.id !== "conflicts" ? (
                  <Button
                    type="button" size="sm" variant="ghost" disabled={busy}
                    onClick={() => void run(() => rpc.call(section.id === "staged" ? "unstage" : "stage", {
                      ...ctx, paths: section.entries.map(({ file }) => file.path),
                    }))}
                  >
                    {section.id === "staged" ? "Unstage all" : "Stage all"}
                  </Button>
                ) : null}
              </div>
              {!collapsedSections.has(section.id) ? section.entries.map(({ key, file, group }) => {
                const path = file.path;
                const parts = fileParts(path);
                const isOpen = expanded.has(key);
                const view = overrides[key] ?? layout;
                const deleted = group === "staged" ? file.index === "D" : file.worktree === "D";
                const additions = file.additions;
                const deletions = file.deletions;
                return (
                  <div key={key} className="border-b border-border">
                    <div className="group flex items-center gap-1 px-2 py-1 text-sm hover:bg-state-hover">
                      <button
                        type="button" aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} ${path}`}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => toggle(key)}
                      >
                        <Icon name={isOpen ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0" />
                        <span className="w-6 shrink-0 text-right font-mono text-[10px] text-sky-600 dark:text-sky-400">{extLabel(parts.name)}</span>
                        <span className="min-w-0 truncate">{file.from ? `${fileParts(file.from).name} → ` : ""}{parts.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{parts.dir}</span>
                      </button>
                      <span
                        className="flex shrink-0 gap-1 font-mono text-[10px]"
                        aria-label={`${path}: ${additions ?? "unknown"} additions, ${deletions ?? "unknown"} deletions`}
                        title={additions === null || deletions === null ? "Line counts unavailable for binary or conflicted changes" : undefined}
                      >
                        <span className="text-emerald-600 dark:text-emerald-400">+{additions ?? "?"}</span>
                        <span className="text-red-600 dark:text-red-400">-{deletions ?? "?"}</span>
                      </span>
                      {rowActions(file, group)}
                      <IconBtn
                        label={`Edit ${path} in preferred editor`} name="EditFile" disabled={deleted}
                        onClick={() => void editFile(path)}
                      />
                      <IconBtn
                        label={`${view === "unified" ? "Split" : "Inline"} ${path}`}
                        name={view === "unified" ? "Columns2" : "AlignLeft"}
                        onClick={() => setOverrides((prev) => ({ ...prev, [key]: view === "unified" ? "split" : "unified" }))}
                      />
                      <span className={cn("w-8 shrink-0 text-right font-mono text-[10px]", letterClass(statusBadge(file, group)))}>
                        {statusBadge(file, group)}
                      </span>
                    </div>
                    {isOpen ? (
                      <div className="border-t border-border">
                        <div className="group flex items-center justify-between bg-muted/30 px-2 py-0.5 text-xs text-muted-foreground">
                          <span>{group === "staged" ? "Staged" : group === "changes" ? "Working tree" : group === "untracked" ? "Untracked" : "Conflict"} · {path}</span>
                        </div>
                        <div className={view === "split" ? "overflow-x-auto" : ""}>
                          <ChangePatch key={`${projectId}:${threadId}:${file.revision ?? ""}:${refreshDiffs}`} ctx={ctx} group={group} path={path} view={view} />
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              }) : null}
            </section>
          ))}
        </section>
      </div>

      <Dialog open={discarding !== null} onOpenChange={(open) => !open && setDiscarding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              {discarding
                ? `This cannot be undone. ${discarding.paths.length} file(s) in ${discarding.group}.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscarding(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!discarding) return;
                const payload = discarding;
                setDiscarding(null);
                void run(() =>
                  rpc.call("discard", { ...ctx, paths: payload.paths, group: payload.group }),
                );
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NavSourceControl() {
  return <SourceControl />;
}

function ThreadSourceControl({ threadId }: { threadId: string }) {
  return <SourceControl threadId={threadId} />;
}

function NewThreadSourceControl({ projectId }: { projectId: string | null }) {
  return <SourceControl projectId={projectId} threadId={null} />;
}

function WalkthroughSettings() {
  const rpc = useRpc<typeof gitxRpc>();
  const [settings, setSettings] = useState<WalkthroughSettings | null>(null);
  const [fallback, setFallback] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void rpc.call("getWalkthroughSettings", {}).then(
      (next) => { if (active) setSettings(next); },
      (reason) => { if (active) setError(errMessage(reason)); },
    );
    void rpc.call("getDefaultWalkthroughModel", {}).then(
      (next) => { if (active && next) setFallback({
        providerId: next.providerId, model: next.model,
        reasoningLevel: next.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"],
      }); },
      (reason) => { if (active) setError(errMessage(reason)); },
    );
    return () => { active = false; };
  }, [rpc]);

  if (!settings) return <p className="text-sm text-muted-foreground">{error ?? "Loading walkthrough settings…"}</p>;
  const selected = settings.providerId && settings.model ? {
    providerId: settings.providerId,
    model: settings.model,
    reasoningLevel: settings.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"],
  } : fallback;
  const displayedPrompt = prompt ?? settings.prompt;

  const save = async (updates: Partial<WalkthroughSettings>) => {
    setSaving(true);
    setError(null);
    try {
      setSettings(await rpc.call("setWalkthroughSettings", updates));
      if (updates.prompt !== undefined) setPrompt(null);
    } catch (reason) { setError(errMessage(reason)); }
    finally { setSaving(false); }
  };

  return <div className="space-y-3 text-sm">
    <p>Choose a provider and model already connected to BB. A listed model may still require sign-in when used.</p>
    {selected ? <ProviderModelPicker
      value={selected}
      onChange={(next) => { void save({
        providerId: next.providerId,
        model: next.model,
        reasoningLevel: next.reasoningLevel,
      }); }}
    /> : <p role="status">No available provider model was found on this machine.</p>}
    <label className="block space-y-1">
      <span className="font-medium">Walkthrough prompt</span>
      <textarea
        className="min-h-36 w-full rounded-md border border-input bg-background p-2 text-sm"
        value={displayedPrompt} onChange={(event) => setPrompt(event.target.value)}
      />
    </label>
    <div className="flex gap-2">
      <Button type="button" size="sm" disabled={saving || !displayedPrompt.trim()} onClick={() => void save({ prompt: displayedPrompt })}>Save prompt</Button>
      <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void save({ prompt: DEFAULT_WALKTHROUGH_PROMPT })}>Restore default</Button>
    </div>
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
  </div>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "source-control",
    title: "Source Control",
    icon: "FolderGit",
    path: "scm",
    component: NavSourceControl,
  });
  app.slots.threadPanelAction({
    id: "source-control",
    title: "Source Control",
    icon: "FolderGit",
    layout: "flush",
    component: ThreadSourceControl,
    run: ({ openPanel }) => {
      openPanel();
    },
  });
  app.slots.experimental_newThreadPanelAction({
    id: "source-control",
    title: "Source Control",
    icon: "FolderGit",
    layout: "flush",
    component: NewThreadSourceControl,
    run: ({ openPanel }) => {
      openPanel();
    },
  });
  app.slots.settingsSection({ id: "walkthrough", title: "Changes walkthrough", component: WalkthroughSettings });
});
