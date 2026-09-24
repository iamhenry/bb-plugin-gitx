import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const GIT_STATE_CHANNEL = "git-state-changed";

export const fileGroupSchema = z.enum(["staged", "changes", "untracked", "conflicts"]);
export type FileGroup = z.infer<typeof fileGroupSchema>;

export const gitFileSchema = z.object({
  path: z.string(),
  from: z.string().nullable().optional(),
  index: z.string(),
  worktree: z.string(),
  letter: z.string(),
  revision: z.string().optional(),
  additions: z.number().int().nonnegative().nullable().optional(),
  deletions: z.number().int().nonnegative().nullable().optional(),
});
export type GitFile = z.infer<typeof gitFileSchema>;

export const gitStateSchema = z.object({
  present: z.boolean(),
  root: z.string().nullable(),
  name: z.string().nullable(),
  empty: z.boolean(),
  detached: z.boolean(),
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  remotes: z.array(z.string()),
  branches: z.array(z.string()),
  staged: z.array(gitFileSchema),
  changes: z.array(gitFileSchema),
  untracked: z.array(gitFileSchema),
  conflicts: z.array(gitFileSchema),
});
export type GitState = z.infer<typeof gitStateSchema>;

const walkthroughSettingsSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.string(),
  prompt: z.string(),
});
export type WalkthroughSettings = z.infer<typeof walkthroughSettingsSchema>;

const ctx = z.object({
  projectId: z.string().nullable(),
  threadId: z.string().nullable(),
});

const pathsInput = ctx.extend({
  paths: z.array(z.string().min(1)).min(1).max(500),
});

export const gitxRpc = defineRpcContract({
  getState: {
    input: ctx,
    output: gitStateSchema,
  },
  getDiff: {
    input: ctx.extend({
      path: z.string().min(1),
      group: fileGroupSchema,
    }),
    output: z.object({
      path: z.string(),
      patch: z.string(),
      oldContent: z.string(),
      newContent: z.string(),
    }),
  },
  getEditTarget: {
    input: ctx.extend({ path: z.string().min(1) }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("workspace"), environmentId: z.string(), path: z.string() }),
      z.object({ kind: z.literal("host"), hostId: z.string(), path: z.string() }),
    ]),
  },
  getWalkthroughSettings: { input: z.object({}), output: walkthroughSettingsSchema },
  getDefaultWalkthroughModel: {
    input: z.object({}),
    output: z.object({ providerId: z.string(), model: z.string(), reasoningLevel: z.string() }).nullable(),
  },
  setWalkthroughSettings: {
    input: walkthroughSettingsSchema.partial(), output: walkthroughSettingsSchema,
  },
  stage: { input: pathsInput, output: gitStateSchema },
  unstage: { input: pathsInput, output: gitStateSchema },
  discard: {
    input: pathsInput.extend({ group: fileGroupSchema }),
    output: gitStateSchema,
  },
  commit: {
    input: ctx.extend({ message: z.string().trim().min(1).max(4000) }),
    output: gitStateSchema,
  },
  commitPush: {
    input: ctx.extend({ message: z.string().trim().min(1).max(4000) }),
    output: gitStateSchema,
  },
  commitSync: {
    input: ctx.extend({ message: z.string().trim().min(1).max(4000) }),
    output: gitStateSchema,
  },
  fetch: { input: ctx.extend({ force: z.boolean().optional() }), output: gitStateSchema },
  push: { input: ctx, output: gitStateSchema },
  pull: { input: ctx, output: gitStateSchema },
  sync: { input: ctx, output: gitStateSchema },
  publish: { input: ctx, output: gitStateSchema },
  checkout: {
    input: ctx.extend({ branch: z.string().trim().min(1).max(200) }),
    output: gitStateSchema,
  },
  createBranch: {
    input: ctx.extend({ name: z.string().trim().min(1).max(200) }),
    output: gitStateSchema,
  },
});
