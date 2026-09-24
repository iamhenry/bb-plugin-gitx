import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  assertRelPath,
  checkout,
  commit,
  createBranch,
  discard,
  groupFiles,
  parsePorcelain,
  publish,
  pullFf,
  push,
  readDiff,
  readState,
  stage,
  syntheticAddPatch,
  unstage,
  fetchAll,
  commitPush,
} from "./git.ts";
import { extLabel, fileParts, isTextPatch, statusBadge, syncCaption } from "./tree.ts";
import { watchGitState } from "./watch.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]) {
  await exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd });
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitx-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "gitx@test"]);
  await git(dir, ["config", "user.name", "gitx"]);
  return dir;
}

test("statusBadge: U / staged letter / ¡M, M on dual-dirty changes", () => {
  const both = { path: "a.ts", from: null, index: "M", worktree: "M", letter: "M" };
  assert.equal(statusBadge(both, "staged"), "M");
  assert.equal(statusBadge(both, "changes"), "¡M, M");
  assert.equal(
    statusBadge({ path: "n.ts", from: null, index: "?", worktree: "?", letter: "?" }, "untracked"),
    "U",
  );
  assert.equal(
    statusBadge({ path: "r.ts", from: "o.ts", index: "R", worktree: " ", letter: "R" }, "staged"),
    "R",
  );
});

test("fileParts + extLabel + syncCaption", () => {
  assert.deepEqual(fileParts("server/src/routes/docs.ts"), { name: "docs.ts", dir: "server/src/routes" });
  assert.deepEqual(fileParts("app.tsx"), { name: "app.tsx", dir: "" });
  assert.equal(extLabel("docs.ts"), "TS");
  assert.equal(extLabel("app.tsx"), "TS");
  assert.equal(syncCaption(0, 1), "Sync Changes 1↓");
  assert.equal(syncCaption(2, 1), "Sync Changes 1↓ 2↑");
  assert.equal(syncCaption(3, 0), "Sync Changes 3↑");
});

test("parsePorcelain groups staged/unstaged/untracked/conflict", () => {
  const files = parsePorcelain(
    [
      "M  staged.txt",
      " M unstaged.txt",
      "MM both.txt",
      "?? new.txt",
      "UU conflict.txt",
      "R  old.txt -> renamed.txt",
    ].join("\n"),
  );
  const g = groupFiles(files);
  assert.deepEqual(
    g.staged.map((f) => f.path),
    ["staged.txt", "both.txt", "renamed.txt"],
  );
  assert.deepEqual(
    g.changes.map((f) => f.path),
    ["unstaged.txt", "both.txt"],
  );
  assert.deepEqual(
    g.untracked.map((f) => f.path),
    ["new.txt"],
  );
  assert.deepEqual(
    g.conflicts.map((f) => f.path),
    ["conflict.txt"],
  );
  assert.equal(g.staged.find((f) => f.path === "renamed.txt")?.from, "old.txt");
});

test("syntheticAddPatch is a new-file unified diff", () => {
  const patch = syntheticAddPatch("a.txt", "hello\nworld\n");
  assert.match(patch, /^diff --git a\/a\.txt b\/a\.txt/m);
  assert.match(patch, /^\+hello$/m);
  assert.match(patch, /^\+world$/m);
  assert.equal(syntheticAddPatch("empty.txt", "").includes("@@"), false);
});

test("source mentioning binary markers remains a text patch", () => {
  assert.equal(isTextPatch('diff --git a/app.tsx b/app.tsx\n+  patch.includes("Binary files")\n'), true);
  assert.equal(isTextPatch("diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n"), false);
  assert.equal(isTextPatch("diff --git a/image.png b/image.png\nGIT binary patch\n"), false);
});

test("assertRelPath rejects escapes", () => {
  assert.throws(() => assertRelPath("/etc/passwd"));
  assert.throws(() => assertRelPath("../x"));
  assert.throws(() => assertRelPath("a/../../b"));
  assertRelPath("src/app.tsx");
});

test("readState + diffs + stage/unstage/commit against a real repo", async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, "tracked.txt"), "v1\n");
  await git(dir, ["add", "tracked.txt"]);
  await git(dir, ["commit", "-m", "init"]);

  await writeFile(join(dir, "tracked.txt"), "v1\nstaged\n");
  await git(dir, ["add", "tracked.txt"]);
  await writeFile(join(dir, "tracked.txt"), "v1\nstaged\nunstaged\n");
  await writeFile(join(dir, "free.txt"), "untracked\n");

  const state = await readState(dir);
  assert.equal(state.present, true);
  assert.equal(state.empty, false);
  assert.equal(state.staged[0]?.path, "tracked.txt");
  assert.equal(state.changes[0]?.path, "tracked.txt");
  assert.equal(state.untracked[0]?.path, "free.txt");
  assert.deepEqual([state.staged[0]?.additions, state.staged[0]?.deletions], [1, 0]);
  assert.deepEqual([state.changes[0]?.additions, state.changes[0]?.deletions], [1, 0]);
  assert.deepEqual([state.untracked[0]?.additions, state.untracked[0]?.deletions], [1, 0]);

  const stagedDiff = await readDiff(dir, "tracked.txt", "staged");
  assert.match(stagedDiff.patch, /\+staged/);
  assert.doesNotMatch(stagedDiff.patch, /\+unstaged/);
  assert.equal(stagedDiff.oldContent, "v1\n");
  assert.equal(stagedDiff.newContent, "v1\nstaged\n");

  const unstagedDiff = await readDiff(dir, "tracked.txt", "changes");
  assert.match(unstagedDiff.patch, /\+unstaged/);
  assert.equal(unstagedDiff.oldContent, "v1\nstaged\n");
  assert.equal(unstagedDiff.newContent, "v1\nstaged\nunstaged\n");

  const untrackedDiff = await readDiff(dir, "free.txt", "untracked");
  assert.match(untrackedDiff.patch, /new file mode/);
  assert.equal(untrackedDiff.oldContent, "");
  assert.equal(untrackedDiff.newContent, "untracked\n");

  await writeFile(join(dir, "tracked.txt"), "v1\nnew edit\n");
  const edited = await readState(dir);
  assert.notEqual(edited.changes[0]?.revision, state.changes[0]?.revision);
  assert.equal(edited.staged[0]?.revision, state.staged[0]?.revision);
  assert.deepEqual([edited.changes[0]?.additions, edited.changes[0]?.deletions], [1, 1]);
  assert.deepEqual([edited.staged[0]?.additions, edited.staged[0]?.deletions], [1, 0]);

  await unstage(dir, ["tracked.txt"]);
  assert.equal((await readState(dir)).staged.length, 0);
  await stage(dir, ["tracked.txt", "free.txt"]);
  const staged = await readState(dir);
  assert.equal(staged.staged.length, 2);
  assert.equal(staged.untracked.length, 0);

  await commit(dir, "second");
  const clean = await readState(dir);
  assert.equal(clean.staged.length, 0);
  assert.equal(clean.changes.length, 0);

  await git(dir, ["mv", "tracked.txt", "renamed\tfile.txt"]);
  const renamed = await readState(dir);
  assert.equal(renamed.staged[0]?.path, "renamed\tfile.txt");
  assert.deepEqual([renamed.staged[0]?.additions, renamed.staged[0]?.deletions], [0, 0]);
});

test("untracked symlink never exposes a file outside the repository", async (t) => {
  const dir = await repo();
  const outside = await mkdtemp(join(tmpdir(), "gitx-outside-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(join(outside, "private.txt"), "private content\n");
  await symlink(join(outside, "private.txt"), join(dir, "link.txt"));

  const diff = await readDiff(dir, "link.txt", "untracked");
  assert.equal(diff.patch, "");
  assert.equal(diff.newContent, "");
});

test("discard unstaged restores index; discard untracked deletes", async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "a.txt"), "keep\n");
  await git(dir, ["add", "a.txt"]);
  await git(dir, ["commit", "-m", "init"]);
  await writeFile(join(dir, "a.txt"), "dirty\n");
  await writeFile(join(dir, "gone.txt"), "tmp\n");
  await discard(dir, ["a.txt"], "changes");
  await discard(dir, ["gone.txt"], "untracked");
  const state = await readState(dir);
  assert.equal(state.changes.length, 0);
  assert.equal(state.untracked.length, 0);
});

test("empty repo, detached HEAD, branch create/checkout", async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const empty = await readState(dir);
  assert.equal(empty.present, true);
  assert.equal(empty.empty, true);

  await writeFile(join(dir, "a.txt"), "a\n");
  await stage(dir, ["a.txt"]);
  await commit(dir, "init");
  await createBranch(dir, "feature");
  assert.equal((await readState(dir)).branch, "feature");
  await checkout(dir, "main");
  const after = await readState(dir);
  assert.ok(after.branch === "main" || after.branch === "master");

  const sha = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
  await git(dir, ["checkout", "--detach", sha]);
  const det = await readState(dir);
  assert.equal(det.detached, true);
});

test("ff pull + publish against a local bare remote", async (t) => {
  const dir = await repo();
  const bare = await mkdtemp(join(tmpdir(), "gitx-bare-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  });
  await git(bare, ["init", "--bare"]);
  await writeFile(join(dir, "a.txt"), "a\n");
  await stage(dir, ["a.txt"]);
  await commit(dir, "init");
  await git(dir, ["remote", "add", "origin", bare]);
  await publish(dir);
  const published = await readState(dir);
  assert.ok(published.upstream);

  const clone = await mkdtemp(join(tmpdir(), "gitx-clone-"));
  t.after(() => rm(clone, { recursive: true, force: true }));
  await exec("git", ["clone", bare, clone]);
  await git(clone, ["config", "user.email", "gitx@test"]);
  await git(clone, ["config", "user.name", "gitx"]);
  await writeFile(join(clone, "b.txt"), "b\n");
  await git(clone, ["add", "b.txt"]);
  await git(clone, ["commit", "-m", "other"]);
  await git(clone, ["push"]);

  await pullFf(dir);
  assert.equal((await readState(dir)).behind, 0);

  await writeFile(join(dir, "c.txt"), "c\n");
  await stage(dir, ["c.txt"]);
  await commit(dir, "local");
  assert.equal((await readState(dir)).ahead, 1);
  await push(dir);
  assert.equal((await readState(dir)).ahead, 0);
});

test("fetchAll updates behind without merging", async (t) => {
  const dir = await repo();
  const bare = await mkdtemp(join(tmpdir(), "gitx-bare-"));
  const clone = await mkdtemp(join(tmpdir(), "gitx-clone-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
  });
  await git(bare, ["init", "--bare"]);
  await writeFile(join(dir, "a.txt"), "a\n");
  await stage(dir, ["a.txt"]);
  await commit(dir, "init");
  await git(dir, ["remote", "add", "origin", bare]);
  await publish(dir);

  await exec("git", ["clone", bare, clone]);
  await git(clone, ["config", "user.email", "gitx@test"]);
  await git(clone, ["config", "user.name", "gitx"]);
  await writeFile(join(clone, "b.txt"), "b\n");
  await git(clone, ["add", "b.txt"]);
  await git(clone, ["commit", "-m", "other"]);
  await git(clone, ["push"]);

  assert.equal((await readState(dir)).behind, 0);
  await fetchAll(dir);
  assert.equal((await readState(dir)).behind, 1);
  assert.equal((await readState(dir)).ahead, 0);
});

test("commitPush commits then pushes", async (t) => {
  const dir = await repo();
  const bare = await mkdtemp(join(tmpdir(), "gitx-bare-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  });
  await git(bare, ["init", "--bare"]);
  await writeFile(join(dir, "a.txt"), "a\n");
  await stage(dir, ["a.txt"]);
  await commit(dir, "init");
  await git(dir, ["remote", "add", "origin", bare]);
  await publish(dir);
  await writeFile(join(dir, "b.txt"), "b\n");
  await stage(dir, ["b.txt"]);
  await commitPush(dir, "second");
  const st = await readState(dir);
  assert.equal(st.ahead, 0);
  assert.equal(st.staged.length, 0);
});

test("no-repo state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gitx-none-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "sub"));
  const state = await readState(dir);
  assert.equal(state.present, false);
});

test("watch fires within 2s after git add (index)", async (t) => {
  const dir = await repo();
  const ac = new AbortController();
  t.after(async () => {
    ac.abort();
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "a.txt"), "a\n");
  await git(dir, ["add", "a.txt"]);
  await git(dir, ["commit", "-m", "init"]);
  let hits = 0;
  await watchGitState(dir, () => {
    hits += 1;
  }, ac.signal);
  await writeFile(join(dir, "a.txt"), "b\n");
  await git(dir, ["add", "a.txt"]);
  const start = Date.now();
  while (hits === 0 && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(hits >= 1, `expected watch hit, got ${hits}`);
});

test("merge conflict files land in conflicts", async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "f.txt"), "a\n");
  await git(dir, ["add", "f.txt"]);
  await git(dir, ["commit", "-m", "base"]);
  const start = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir })).stdout.trim();
  await git(dir, ["checkout", "-b", "other"]);
  await writeFile(join(dir, "f.txt"), "b\n");
  await git(dir, ["add", "f.txt"]);
  await git(dir, ["commit", "-m", "other"]);
  await git(dir, ["checkout", start]);
  await writeFile(join(dir, "f.txt"), "c\n");
  await git(dir, ["add", "f.txt"]);
  await git(dir, ["commit", "-m", "mainline"]);
  await exec("git", ["merge", "other"], { cwd: dir }).catch(() => undefined);
  const state = await readState(dir);
  assert.equal(state.conflicts[0]?.path, "f.txt");
});
