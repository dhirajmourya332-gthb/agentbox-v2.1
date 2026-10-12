# Backlog: autonomy hurdles

From the autonomy audit of 2026-10-12: v2.1's data (72 "needs you" items and 26 failed or stopped
tasks over two days) plus a read of the code. These items are deferred. The ones already built are
listed at the end.

## Work that stops and waits

1. **A server restart strands work.** On startup, running and queued tasks are marked
   `failed` ("Interrupted by a server restart") with a raw update (`db.ts`). That bypasses
   `finishTask`/`returnResult`, so leads are never told and nothing resumes; 11 tasks were lost this way
   on 2026-10-12.
   **Fix:** requeue interrupted tasks as "resume where you left off" in the same session, or at least report
   them to their lead.
2. **Rate limits, usage limits and transient errors aren't retried.** The task is marked failed and
   the agent goes to `limited`/`error`.
   **Fix:** requeue with backoff, and resume when the limit resets.

## Decisions that go to the owner by default

3. **Cloud access defaults to read-only.** AWS, GCP and Azure default to `access: read-only`, and every
   change needs the owner's OK. Kubernetes deletes, scale-to-zero and secrets need the owner too. In
   v2.1, `writable_namespaces` is empty, so even dev and staging are read-only.
   **Proposal:** dev and staging writable for devops; the owner only for production and destructive
   actions.
4. **Deploys:** `agents_may_deploy` is off for new repos, so devops can't release a merged fix.
   **Proposal:** the lead (or devops) may deploy to staging; production follows the same "routine and
   not critical" rule as merges.
5. **Setup requests always need the owner's click.** Even safe installs (a CLI, a scope) wait for
   "Set up now".
   **Proposal:** auto-start the setup agent for requests that only install or verify, and keep the owner
   for credentials and logins.
6. **Delegation limits fall back to the owner.** Chains are at most 3 deep ("report back and let
   the owner decide"), there are 5 live instances per role per creator ("wait for a merge or ask the
   owner"), and agents can't start another lead role.
   **Proposal:** at the limit, the lead decides (queue, retire or reuse); only the owner can raise the
   limits.
7. **Approvals only the owner can give:** the setup agent's proposals (role↔integration mappings,
   team rules, repo adds) stay pending until the owner approves them.
   **Proposal:** auto-approve low-risk ones (mapping an integration to the role its module defaults to).
8. **The plan gate doesn't lift from chat.** "Approve a plan first" is opt-in per task, but an owner
   telling the lead "go ahead" in chat doesn't lift it.
   **Proposal:** a chat "go ahead / approve it" from the owner approves the pending plan.

## Environment

9. **No warning before the VM runs out of disk or memory.** On 2026-10-12 a full disk and memory
   starvation (3 GB) stalled everything.
   **Proposal:** a periodic check that warns the lead and cleans old worktrees and caches by itself;
   tell the owner only when cleanup isn't enough.
10. **One shared GitHub account.** Its GraphQL rate limit ran out mid-task.
    **Proposal:** a GitHub App, or a second token for bulk and board work.

## Gaps seen

11. **tech-lead#5 merged #5365 into `main`** while the repo said only the owner merges. Find how the guard
    was bypassed (`gh api` merge, a different repo name or URL form) and close it.

## Built on 2026-10-12 (no longer backlog)

- The work's lead merges routine PRs into protected branches: CI green, not a draft, not an epic;
  breaking or critical changes go to the owner. This is a per-repo setting, on by default.
- A turn that hits the step limit carries on by itself, up to 3 times.
- A helper's stalls and failures go to its lead, which can `stop_task` it and re-delegate. Only the
  lead's own stall or failure reaches the owner.
- Agents set one-time wake-ups (`schedule_wakeup`) instead of polling. The Routines page lists them
  under "One-time wake-ups".
- Group chats no longer pause after 12 agent replies; `AGENTBOX_GROUP_TURN_LIMIT` brings a cap back.
- "Needs you" is only for real asks (`ask_owner`, plans, setup requests, failures and stalls); plain
  replies are "unread", listed apart, and not pushed.
- A helper's plan goes to its lead (`decide_plan`), not the owner.
