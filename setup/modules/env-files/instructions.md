# Environment files

- Each repo's env files live in `{{paths.secrets}}/<repo>/`, never in the repo. The folder mirrors
  the repo's layout: `{{paths.secrets}}/<repo>/frontend/.env.local` belongs at `frontend/.env.local`
  in your worktree. List them (names only) with `find {{paths.secrets}}/<repo> -type f`.
- In a worktree, symlink the ones you need, e.g. from the worktree root:
  `ln -s {{paths.secrets}}/<repo>/frontend/.env.local frontend/.env.local`
  (they're git-ignored; check `git status`). If the repo already tracks a file with that name, leave
  the tracked one alone and ask the owner which to use.
- Never print, paste or commit their contents. Refer to variables by name.
- Missing a variable? Ask the owner; don't invent values.
