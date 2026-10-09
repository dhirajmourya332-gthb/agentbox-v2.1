# Contracts for backlog 11, 12 and 13 plus push notifications

These are the shared contracts between the parallel workstreams. Each workstream builds to them
exactly. If something is wrong or missing, note it in your final report; don't silently change
it. All `/api/*` routes are portal routes, protected by `guardApi`. Routes marked **phone** must
also be added to the gateway allowlist in `server/src/mobile.ts`, at `/m/v1/<same path>`, signed.
Phone payloads are the same JSON.

## A. Live progress (backlog 11): workstream "live"
**Progress record**, one per working instance (a task in `running` status):
```ts
type Progress = {
  agent_id: string; task_id: string; root_id: string | null;  // root_id = task-room root, or a group thread id for group turns
  group_id: string | null;
  activity: string;          // plain words: "Waiting on CI for PR #4984", "Running tests in digital_risk-4950", "Writing reply"
  step: { name: string; summary: string; started_at: string } | null;  // current step, if any
  started_at: string;        // task start
  last_step_at: string;      // last step start or finish
  state: "working" | "stalled";
  stalled_for_s: number | null;
  summary: string | null;    // latest periodic progress summary for long turns, or null
};
```
- `GET /api/progress` → `Progress[]` (**phone**).
- Bus event `{ type: "progress.updated", progress: Progress }` when activity, state or summary
  changes, throttled to at most 1 per agent every 2 s. `{ type: "progress.cleared", agent_id,
  task_id }` when the turn ends. Both are forwarded to phones.
- **Stalled:** no new step started and no step finished for `STALL_MIN` (default 10) minutes, or
  a single shell step running longer than `STALL_MIN`.
- **Summaries:** for turns longer than 5 min, at most one every 3 min. Rule-based first (e.g.
  parse `gh pr checks` output: "3 checks failed: …; 5 pending"). An LLM summary is optional,
  cheap, and off by default.

## B. Attention ("needs you"): workstream "live"
```ts
type Attention = {
  id: string; kind: "reply" | "failed" | "stalled" | "question";
  agent_id: string; task_id: string | null; room_id: string | null;  // room_id = task-room root id or group id
  title: string;      // short, e.g. "tech-lead#1 replied: MSP API keys"
  created_at: string; seen_at: string | null;
};
```
- **`reply`:** an owner-started task (top-level instance, `created_by="owner"`) or a group turn
  addressed to the owner finishes and posts a reply.
- **`failed`:** any task the owner started, or its room, fails.
- **`stalled`:** from A. Cleared when the agent resumes.
- **`question`:** reserved. An agent explicitly asks the owner something; `reply` covers it for now.
- `GET /api/attention` → `{ items: Attention[] }`, unseen first, at most 100 (**phone**).
- `POST /api/attention/:id/seen` and `POST /api/attention/seen-all` (**phone**).
- Opening a room in the portal marks that room's items seen.
- Bus event `{ type: "attention.updated", item: Attention }` (forwarded to phones).
- **Notification hook:** the attention module exports
  `onAttention(cb: (item: Attention) => void)`. Workstream "push" registers it to send
  notifications.

## C. Voice (backlog 12): workstream "voice"
**Voice v2 (what the clients use):** speech is recognised on the client by a free engine (the
portal: Chrome's Web Speech API, `en-IN` by default, `en-US` and `hi-IN` selectable; the app:
Android's own `SpeechRecognizer`). The server only tidies the text up:

`POST /api/voice/clean` (**phone**, gateway body limit 1 MB). JSON:
`{ text: string (1–4000 chars), purpose: "task"|"message", agent_id?, lang? }` (`lang` a BCP-47
tag such as `en-IN`, a hint for the cleanup) → `{ text, raw, cleaned: boolean }`. When the
cleanup fails (provider error, empty content, or a length change that looks like adding or
dropping content) the answer is still 200 with `text = raw` and `cleaned: false`. Errors:
- 400 bad input (no text, bad `purpose` or `lang`);
- 413 text over 4000 characters;
- 429 over 30 a minute;
- 503 not configured (no `/secrets/zai.env` or no `ZAI_API_KEY`).

The cleanup prompt removes fillers, stutters and false starts, resolves self-corrections, fixes
misheard names from the glossary ("Known names: …": agent and instance names, `/work` repo names,
fixed terms), writes issue and PR numbers as `#4957`, turns Hindi/Hinglish into English, and never
adds, answers or drops anything. The text is never logged or stored. It uses `ZAI_CHAT_URL`,
`ZAI_CLEAN_MODEL` and `ZAI_CHAT_KEY`/`ZAI_API_KEY` below (in the VM: the Coding Plan endpoint
`https://api.z.ai/api/coding/paas/v4/chat/completions` and `glm-5.3-flash`, which always thinks,
so the request sends `max_tokens` of 1024 plus the text length and no `thinking` field).

**Voice v1 (kept, unused by the clients):** Z.ai GLM-ASR on uploaded audio; the account has no
pay-per-use ASR balance.

`POST /api/voice/transcribe` (**phone**, body limit about 21 MB). JSON:
`{ audio: base64, mime, purpose: "task"|"message", agent_id? }`
→ `{ text, raw, duration_s, cleaned: boolean }`. Errors:
- 400 bad input;
- 413 too long or too big (5 min, 15 MB);
- 503 not configured;
- 502 provider failure.

Config is in `/secrets/zai.env`, read on each request: `ZAI_API_KEY`; `ZAI_ASR_URL` (default
`https://api.z.ai/api/paas/v4/audio/transcriptions`); `ZAI_ASR_MODEL` (default `glm-asr-2512`);
`ZAI_CHAT_URL` (default `https://api.z.ai/api/paas/v4/chat/completions`); `ZAI_CLEAN_MODEL`
(default `glm-5.3-flash`); `ZAI_CHAT_KEY` (optional). Full spec: docs/BACKLOG.md item 12.

## D. Push notifications: workstream "push"
- `POST /m/v1/device/push-token` with `{ token: "ExponentPushToken[...]" }`, signed, gateway
  only (not an /api route). Stores the token on the calling device. `DELETE /m/v1/device/push-token`
  removes it. Revoke and forget also delete it.
- On each new Attention item (`onAttention`), send to every active device with a token through
  Expo's push API (`https://exp.host/--/api/v2/push/send`).
  - **Content-free by default:** title `agentbox`, body `Something needs you` (or
    `N things need you`).
  - `data` holds only `{ kind, room_id, attention_id }`: ids, no text.
  - A portal setting, "Show details in notifications" (off by default, stored in `meta`
    `push_details`), adds the attention `title` to the body.
  - Coalesce: at most one push per device every 30 s, summarising the count.
  - Android channel id `attention`.
- Handle Expo's tickets and receipts: drop tokens that come back `DeviceNotRegistered`. Never log
  tokens.
- The portal Devices page shows per device whether notifications are on, plus the details toggle.

## E. Group routes for phones: workstream "push" adds them to the allowlist
Allowlist the existing read and post routes the app needs for groups:
- the list of groups;
- a group's thread view and messages;
- posting to a group (already `POST threads/:id/messages`);
- `GET groups/:id/documents`.

Use the actual route paths in `server/src/index.ts`, and list them in the
MOBILE-PROTOCOL Implementation notes.

## F. App (backlog 13 + voice UI + push client): workstream "mobile"
Builds to A–E:
- Overview home: In progress from A, Needs you from B, Recently finished from `/m/v1/tasks`.
- Members sheet and Documents tab in rooms and groups.
- Groups screens.
- Mic button (C).
- Push registration with `expo-notifications`: ask for permission once, register on unlock,
  unregister on forget. Tapping a notification opens the app (unlock first), then the room or
  attention item from `data`.

## G. Routine runs: active vs. archive (backlog 14)
**What a run is.** A run starts at a `routine_runs` row with `outcome = 'started'`. It is **active** while
the run's own task, or any task in the routine's instance tree created at or after the run's start
(e.g. the routine's lead merging), is queued or running. When nothing is open any more, the run is
**finished**:
- `finished_at` is the last of those tasks' `finished_at`;
- `status` is `failed` if the run's own task failed, `stopped` if it was stopped, otherwise `done`;
- `summary` is the first ~300 characters of the routine agent's last reply in the run.

Skipped runs (`outcome = 'skipped'`) count as finished, with status `skipped` and their `reason`.
Columns are added to `routine_runs` with an additive migration, and existing rows are backfilled.

```ts
type RoutineRun = {
  id: string; routine_id: string; routine_name: string; role_id: string; instance_id: string | null;
  trigger: "schedule" | "manual"; started_at: string; finished_at: string | null;
  status: "running" | "done" | "failed" | "stopped" | "skipped"; reason: string | null;
  summary: string | null; duration_s: number | null; tasks: number;
  members: { id: string; name: string; label: string | null; status: string }[];  // instances active in this run
};
```
- `GET /api/routine-runs?state=active|archive&routine_id=&before=&limit=` (**phone**). `limit` is 1–100,
  default 30. `archive` is newest first, paged with `before` (an ISO timestamp). `active` returns all.
- `GET /api/routine-runs/:id` (**phone**) → `{ run: RoutineRun, messages, tasks, steps, threads, members }`.
  Same shape as the room view, but only items inside the run's window `[started_at, finished_at ?? now]`
  across the routine's instance tree. Steps are capped like room views (`capStep`, running and recent
  tasks only).
- Bus event `{ type: "routine-run.updated", run: RoutineRun }` on start, on any activity change of
  members, and on finish. Forwarded to phones.
- Live progress (contract A) for routine work: a `Progress` whose agent is in a routine tree carries
  `run_id`.
