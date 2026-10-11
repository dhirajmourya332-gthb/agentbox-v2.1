# Environment files

- Each repo's `.env` lives in `{{paths.secrets}}/<repo>/.env`, never in the repo.
- In a worktree: `ln -s {{paths.secrets}}/<repo>/.env .env` (it's git-ignored; check `git status`).
- Never print, paste or commit their contents. Refer to variables by name.
- Missing a variable? Ask the owner; don't invent values.
