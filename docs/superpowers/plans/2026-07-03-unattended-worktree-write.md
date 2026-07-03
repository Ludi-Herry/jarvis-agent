# Unattended Worktree Write Plan

## Goal

Unlock unattended coding only for parallel goal worktrees. A goal builder may write files inside its own goal worktree without an approver; the host checkout must stay unchanged until a human runs `loop:finalize --merge`.

## Success Criteria

- `npm run loop -- <objectives> --unattended --parallel 2` can write ordinary files under each goal worktree.
- The same run still denies writes outside that goal worktree, including absolute paths and `..` escapes.
- `.git` and any path containing a `.git` segment are outside the auto-allow surface.
- Symlink, junction, and Windows namespaced path escapes are checked by effective realpath before allow.
- Sensitive paths remain hard-denied before any worktree auto-allow.
- Bash, vision, and unknown write-like tools stay fail-closed without an approver.
- Host checkout drift remains blocked by existing worktree baseline checks; merge remains manual through `loop:finalize --merge`.
- Goal worktrees can run deterministic checks by seeing host `node_modules` through a worktree-local junction/symlink; agent file tools still reject that bridge by effective realpath.

## Design

Add one narrow `DefaultPermissionGate` option: `goalWorktreeWriteRoot`.

When the pure policy returns `ask` for `write` with capability `writes-files`, the gate evaluates the requested path against `goalWorktreeWriteRoot`:

1. Parse only the built-in `write` tool schema (`args.path` string).
2. Resolve the literal target under the goal worktree root.
3. Reject if the literal target is outside root, sensitive, or touches `.git`.
4. Follow symlinks for the effective target, tolerant of a missing leaf.
5. Reject if the effective target leaves root, becomes sensitive, or touches `.git`.
6. Allow with source `goal-worktree` only after all checks pass.

`loop-cli` will set this option only for `parallelMode && unattended`, using that goal's `goalCwd`. Attended parallel runs keep the existing serialized approver. Non-parallel unattended runs keep fail-closed writes.

## Adversarial Checklist

- Git metadata: reject `.git`, `.git/*`, and nested `.git` segments.
- Path tricks: reject `..`, absolute host paths, and `\\?\` namespaced paths that land outside root.
- Link escape: follow symlink/junction targets before allow.
- Check oracle tamper: existing verifier and worktree-baseline checks still run from the goal worktree and detect changed `package.json`, scripts, or Makefile before finalize.
- Merge path: no automatic host write is introduced; `loop:finalize --merge` remains the only host integration path.
- Non-file effects: bash and vision do not read this option and remain `ask -> fail-closed` in unattended mode.

## 2026-07-03 Implementation Notes

- `DefaultPermissionGate.goalWorktreeWriteRoot` is set only by `loop-cli` for `parallelMode && unattended`.
- `safeResolve` now rejects git metadata on both literal and effective targets; `writeTool` keeps a redundant git-metadata refusal.
- Worktree creation/resume links host `node_modules` into the goal worktree when available so `npm run typecheck/lint/test/build` can execute in detached worktrees.
- Two codex xhigh review rounds found no HIGH. LOWs addressed in this slice: network/unknown write-like fail-closed tests, symlink to `.git` file test, and read/write/grep denial through the `node_modules` bridge.
- Real model smoke proved worktree write, bash fail-closed, and host zero drift. A full all-goal autonomous worktree smoke still needs one stable green run.
