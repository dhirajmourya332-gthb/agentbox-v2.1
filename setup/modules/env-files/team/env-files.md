# Environment files (example: edit to fit your team)

- Each repo's `.env` lives in `/secrets/<repo>/.env`, never in the repo.
- In a worktree: `ln -s /secrets/<repo>/.env .env` (it's git-ignored; check `git status`).
- Never print, paste or commit their contents. Refer to variables by name.
- Missing a variable? Ask the owner; don't invent values.
