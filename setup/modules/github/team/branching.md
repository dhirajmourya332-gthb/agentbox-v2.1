# Branching (example: edit to fit your team)

- Small work: `feature/`, `fix/`, `chore/` + `<issue#>-<slug>`, off `main`, PR to `main`.
- Big work (several PRs or agents): a parent issue with sub-issues and an `epic/<parent#>-<slug>`
  branch off `main`. Sub-issue branches come off the epic and their PRs target it; the final PR is
  epic → main, approved by the owner.
- Every issue gets its own git worktree: `/work/<repo>-<issue#>`. Never edit in the shared clone
  `/work/<repo>` or in another agent's worktree.
