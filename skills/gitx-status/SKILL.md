---
name: gitx-status
description: Read grouped git status as JSON via bb gitx. Use when you need staged/unstaged/untracked files, ahead/behind, or branch state.
---

# Gitx status

Read-only. Writes go through plain `git`.

```
bb gitx status --json
```

Runs in the calling cwd. JSON fields: `present`, `root`, `branch`, `detached`, `empty`, `upstream`, `ahead`, `behind`, `staged`, `changes`, `untracked`, `conflicts`.
