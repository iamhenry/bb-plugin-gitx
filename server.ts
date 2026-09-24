import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { stat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { GIT_STATE_CHANNEL, gitxRpc, type GitState, type WalkthroughSettings } from "./contract.ts";
import {
  assertRelPath,
  checkout,
  commit,
  commitPush,
  commitSync,
  createBranch,
  discard,
  fetchAll,
  GitOpError,
  publish,
  pullFf,
  push,
  readDiff,
  readState,
  stage,
  syncFf,
  unstage,
} from "./lib/git.ts";
import { createLock } from "./lib/lock.ts";
import { watchGitState } from "./lib/watch.ts";
import { DEFAULT_WALKTHROUGH_PROMPT } from "./lib/walkthrough-prompt.ts";

type Ctx = { projectId: string | null; threadId: string | null };

const FETCH_THROTTLE_MS = 30_000;
const AUTO_TICK_MS = 30_000;

export default function plugin(bb: BbPluginApi) {
  const withLock = createLock();
  const watched = new Map<string, AbortController>();
  const lastFetch = new Map<string, number>();
  const inflightFetch = new Map<string, Promise<void>>();
  const authBlocked = new Set<string>();

  const settings = bb.settings.define({
    autofetch: {
      type: "boolean",
      label: "Auto fetch",
      description: "Fetch remotes in the background so ahead/behind stays fresh.",
      default: true,
    },
    autofetchSeconds: {
      type: "string",
      label: "Auto fetch interval (seconds)",
      default: "120",
    },
  });

  const defaultWalkthroughSettings: WalkthroughSettings = {
    providerId: "", model: "", reasoningLevel: "medium", prompt: DEFAULT_WALKTHROUGH_PROMPT,
  };
  const getWalkthroughSettings = async (): Promise<WalkthroughSettings> => ({
    ...defaultWalkthroughSettings,
    ...await bb.storage.kv.get<Partial<WalkthroughSettings>>("walkthrough-settings"),
  });

  const signalChange = () => {
    bb.realtime.publish(GIT_STATE_CHANNEL, null);
  };

  const runFetch = (cwd: string, force: boolean): Promise<void> => {
    const existing = inflightFetch.get(cwd);
    if (existing) return existing;
    if (!force) {
      const prev = lastFetch.get(cwd);
      if (prev !== undefined && Date.now() - prev < FETCH_THROTTLE_MS) {
        return Promise.resolve();
      }
    }
    if (authBlocked.has(cwd)) return Promise.resolve();
    const job = withLock(async () => {
      try {
        await fetchAll(cwd);
        lastFetch.set(cwd, Date.now());
        signalChange();
      } catch (err) {
        if (err instanceof GitOpError && err.code === "auth") authBlocked.add(cwd);
        bb.log.warn(`fetch: ${String(err)}`);
      }
    }).finally(() => {
      inflightFetch.delete(cwd);
    });
    inflightFetch.set(cwd, job);
    return job;
  };

  const ensureWatch = (cwd: string) => {
    if (watched.has(cwd)) return;
    const ac = new AbortController();
    watched.set(cwd, ac);
    void watchGitState(cwd, signalChange, ac.signal).catch((err) => {
      bb.log.warn(`watch failed: ${String(err)}`);
    });
  };

  const autoTick = setInterval(() => {
    void (async () => {
      const cfg = await settings.get();
      if (!cfg.autofetch) return;
      const period = Math.max(30, Number(cfg.autofetchSeconds) || 120) * 1000;
      const now = Date.now();
      for (const cwd of watched.keys()) {
        if (now - (lastFetch.get(cwd) ?? 0) >= period) void runFetch(cwd, false);
      }
    })();
  }, AUTO_TICK_MS);

  bb.onDispose(() => {
    clearInterval(autoTick);
    for (const ac of watched.values()) ac.abort();
    watched.clear();
  });

  async function resolveCwd(ctx: Ctx): Promise<string | null> {
    if (ctx.threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
        if (thread.environmentId) {
          const env = await bb.sdk.environments.get({
            environmentId: thread.environmentId,
          });
          if (env.path) return env.path;
        }
      } catch (err) {
        bb.log.warn(`thread cwd: ${String(err)}`);
      }
    }
    if (ctx.projectId) {
      try {
        const project = await bb.sdk.projects.get({ projectId: ctx.projectId });
        const source = project.sources.find((row) => row.isDefault) ?? project.sources[0];
        return source?.path ?? null;
      } catch (err) {
        bb.log.warn(`project cwd: ${String(err)}`);
      }
    }
    return null;
  }

  async function stateFor(ctx: Ctx): Promise<GitState> {
    const cwd = await resolveCwd(ctx);
    if (!cwd) {
      return {
        present: false,
        root: null,
        name: null,
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
    const state = await readState(cwd);
    if (state.present) ensureWatch(cwd);
    return state;
  }

  async function mutate(ctx: Ctx, fn: (cwd: string) => Promise<void>): Promise<GitState> {
    return withLock(async () => {
      const cwd = await resolveCwd(ctx);
      if (!cwd) throw new Error("No repository");
      try {
        await fn(cwd);
      } catch (err) {
        if (err instanceof GitOpError) throw err;
        throw err;
      }
      const state = await readState(cwd);
      signalChange();
      return state;
    });
  }

  bb.rpc.register(gitxRpc, {
    getState: (ctx) => stateFor(ctx),
    getDiff: async (input) => {
      const cwd = await resolveCwd(input);
      if (!cwd) throw new Error("No repository");
      return readDiff(cwd, input.path, input.group);
    },
    getEditTarget: async (input) => {
      assertRelPath(input.path);
      const cwd = await resolveCwd(input);
      if (!cwd) throw new Error("No repository");
      const actual = await realpath(join(cwd, input.path));
      const inside = relative(await realpath(cwd), actual);
      if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !(await stat(actual)).isFile()) {
        throw new Error("This file is not available to edit in this repository");
      }
      if (input.threadId) {
        const thread = await bb.sdk.threads.get({ threadId: input.threadId });
        if (thread.environmentId) {
          const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          if (environment.path === cwd) {
            return { kind: "workspace" as const, environmentId: thread.environmentId, path: input.path };
          }
        }
      }
      if (input.projectId) {
        const project = await bb.sdk.projects.get({ projectId: input.projectId });
        const source = project.sources.find((row) => row.path === cwd);
        if (source) return { kind: "host" as const, hostId: source.hostId, path: join(cwd, input.path) };
      }
      throw new Error("The repository is not available in BB's file editor");
    },
    getWalkthroughSettings: getWalkthroughSettings,
    getDefaultWalkthroughModel: async () => {
      const providers = await bb.sdk.providers.list();
      for (const provider of providers) {
        if (!provider.available) continue;
        const options = await bb.sdk.providers.models({ providerId: provider.id });
        const model = options.models.find((entry) => entry.isDefault) ?? options.models[0];
        if (model) return { providerId: provider.id, model: model.model, reasoningLevel: model.defaultReasoningEffort };
      }
      return null;
    },
    setWalkthroughSettings: async (input) => {
      const next = { ...await getWalkthroughSettings(), ...input };
      if (!next.prompt.trim() || next.prompt.length > 20_000) throw new Error("Walkthrough prompt must be 1–20,000 characters");
      await bb.storage.kv.set("walkthrough-settings", next);
      return next;
    },
    stage: (input) => mutate(input, (cwd) => stage(cwd, input.paths)),
    unstage: (input) => mutate(input, (cwd) => unstage(cwd, input.paths)),
    discard: (input) => mutate(input, (cwd) => discard(cwd, input.paths, input.group)),
    commit: (input) => mutate(input, (cwd) => commit(cwd, input.message)),
    commitPush: (input) => mutate(input, (cwd) => commitPush(cwd, input.message)),
    commitSync: (input) => mutate(input, (cwd) => commitSync(cwd, input.message)),
    fetch: async (input) => {
      const cwd = await resolveCwd(input);
      if (!cwd) throw new Error("No repository");
      ensureWatch(cwd);
      await runFetch(cwd, input.force === true);
      return readState(cwd);
    },
    push: (input) => mutate(input, (cwd) => push(cwd)),
    pull: (input) => mutate(input, (cwd) => pullFf(cwd)),
    sync: (input) => mutate(input, (cwd) => syncFf(cwd)),
    publish: (input) => mutate(input, (cwd) => publish(cwd)),
    checkout: (input) => mutate(input, (cwd) => checkout(cwd, input.branch)),
    createBranch: (input) => mutate(input, (cwd) => createBranch(cwd, input.name)),
  });

  bb.cli.register({
    name: "gitx",
    summary: "Git source-control helpers",
    commands: [
      {
        name: "status",
        summary: "Print grouped git status as JSON",
        usage: "bb gitx status --json",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      if (args[0] !== "status" || args.length !== 1 || !json) {
        return {
          exitCode: 1,
          stderr: "Usage: bb gitx status --json",
        };
      }
      const cwd = ctx.cwd;
      if (!cwd) {
        return { exitCode: 1, stderr: "No cwd" };
      }
      const state = await readState(cwd);
      return { exitCode: 0, stdout: `${JSON.stringify(state)}\n` };
    },
  });
}
