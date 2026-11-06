# Voice assistant (phone app 1.7.0)

The phone app's assistant answers questions about your work out loud and can act on what you
say: "What's the update on the migration?", "Tell the lead to go with option two", "Start a task
for the platform crew to add rate limits", "Switch to Mumbai". Hands-free, it wakes on a phrase
you choose ("Hey Nova") with the screen off and the app locked.

## How a conversation goes

```
wake phrase heard on the phone (or the mic button)  →  beep
you speak  →  Android speech recognition (on-device when the offline model is installed)
text  →  POST /m/v1/assistant/ask  →  a Claude turn on the agentbox (the owner's Claude login)
short spoken answer  ←  maybe one proposed action ("I'll tell lead: … Shall I?")
you answer (no wake phrase needed for about 6 seconds)  →  "yes" carries the action out
silence or "that's all"  →  back to listening for the wake phrase
```

## Pieces

| Where | File | What |
|---|---|---|
| agentbox | `server/src/assistant.ts` | `POST /api/assistant/ask`. Builds a snapshot (owner's work in progress and finished today, "needs you", unread replies, routines; the helper's setup work left out), then one Claude turn with read-only tools (`work_detail`, `item_detail`, `team`) and four `propose_*` tools. Answers are spoken text (markdown stripped). |
| gateway | `server/src/mobile.ts` | `POST assistant/ask` is allowlisted; audited as "asked the voice assistant". |
| phone | `mobile/src/lib/assistant.ts` | The conversation: listen, ask, speak, follow-up, yes/no, switching agentboxes, asking all of them. |
| phone | `mobile/src/lib/assistantWords.ts` | The words the phone handles itself (yes, no, "that's all", "switch to …", "… on all agentboxes"). |
| phone | `mobile/src/lib/assistantLink.ts` | The assistant's own signed link to each agentbox while hands-free is on. |
| phone | `mobile/modules/wake-word/` | Native Android module: a foreground service (type microphone) running sherpa-onnx keyword spotting on the phone. |
| phone | `mobile/src/lib/wakeTokens.ts` | The wake phrase as the spotter's word pieces (SentencePiece unigram, Viterbi; vocabulary in `wakeVocab.json`). |
| phone | `mobile/src/screens/AssistantScreen.tsx`, `ui/AssistantHost.tsx` | The Assistant page (menu → Assistant), the Home mic button (tap: talk, hold: open the page), the strip shown while talking. |

## Actions only on a spoken yes

The agentbox never changes anything for the assistant. Its `propose_*` tools only check the
request (the agent or crew exists, the thread can take messages, the plan is still waiting) and
hand back one action; the answer reads it back and ends with "Shall I?". The phone keeps it and,
only if the next thing you say is a short yes ("yes", "go ahead", "haan"), makes the ordinary
request a tap would make:

| Action | Request |
|---|---|
| New task | `POST work {role_id, text, title}` (a crew's name means its lead) |
| Reply to an agent / answer a question | `POST threads/:id/messages {text}`, then `POST attention/:id/seen` |
| Approve, send back or reject a plan | `POST plans/:id/decide {verdict, note}` |
| Run a routine | `POST routines/:id/run` |

So every action goes through the same allowlist, checks and device audit as before. A no, silence
or a new question drops the proposal. Not possible by voice: deleting, settings, integrations,
pushing code, approving pull requests.

## Several agentboxes

"Switch to Mumbai" / "use the other agentbox" changes where questions go; "… on all agentboxes"
asks each one in turn and reads the answers one after another. Turning hands-free on unlocks
every paired agentbox once (a fingerprint each) and keeps a copy of each key in memory, apart
from the app's own key, so the assistant keeps working while the app's screens lock. The copies
are zeroed when hands-free is turned off (in the app, or "Stop listening" in the notification),
when an agentbox is forgotten, and when the app's process ends; they are never written to disk.
Without hands-free, the mic button talks to the agentbox open in the app.

## Hands-free (the wake phrase)

- **Engine:** sherpa-onnx (Apache-2.0) keyword spotter, its 3.3M-parameter English zipformer
  (GigaSpeech), int8, about 5 MB, bundled in the module's assets. Any phrase works without
  training: the phone turns it into the model's word pieces itself. Two or three distinct words
  work best; short names are refused because they wake by mistake. "How easily it wakes" sets the
  spotter's threshold (0.35 / 0.25 / 0.15).
- **Android rules:** a foreground service of type microphone with a notification ("Nova is
  listening", with Stop listening). Android 14+ lets it start only while the app is on screen, so
  hands-free is turned on from the app; after a phone restart, open the app and turn it on again.
  A partial wake lock keeps it listening with the screen off.
- **Privacy:** the audio only goes through the spotter in memory; nothing is recorded or sent.
  After the wake phrase the service lets go of the microphone, Android's recogniser hears the
  question (on-device when the offline model is installed, see Settings → Voice), and only the
  text goes to the agentbox. Anyone near the phone who says the phrase can ask questions and hear
  answers; actions still need the spoken yes.
- **Size:** sherpa-onnx's native libraries are packaged for 64-bit ARM only (about 31 MB); other
  ABIs are excluded in `app.json`, and the module reports hands-free as unavailable there.

## Settings

- Wake phrase and sensitivity: Assistant page; kept in secure storage, cleared on Forget.
- Recognition language and on-device only: Settings → Voice (shared with dictation). Hindi
  questions are understood; answers are spoken in Indian English.
- Agentbox side: `AGENTBOX_ASSISTANT_MODEL` (default `haiku`, for speed; `sonnet` answers better
  and slower). At most 12 questions a minute and 2 at once; an answer times out after 90 s.

## Testing

- `server`: `node --disable-warning=ExperimentalWarning --import tsx --test test/assistant.test.ts`
  (allowlist, snapshot leaves out the helper, tools, proposals change nothing, spoken output).
- `mobile`: `npm run selftest:assistant` (wake-phrase pieces against sentencepiece's output, the
  phone's own words).
