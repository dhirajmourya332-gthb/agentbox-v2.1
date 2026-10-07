import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type CoreQuestion, type Draft, type FollowUp, type Template } from "../api.ts";
import { useStore } from "../store.tsx";
import { go } from "../router.ts";
import { Icon, Markdown, Spinner } from "../components/ui.tsx";

type Answers = Record<string, string | string[]>;
type Stage =
  | { name: "role" }
  | { name: "core"; i: number }
  | { name: "thinking"; what: "follow-ups" | "draft" }
  | { name: "follow"; i: number }
  | { name: "review" };

const PHASES = ["Role", "Basics", "Follow-ups", "Review"];
const phaseOf = (s: Stage) =>
  s.name === "role" ? 0 : s.name === "core" ? 1 : s.name === "follow" || (s.name === "thinking" && s.what === "follow-ups") ? 2 : 3;

const SUGGESTED_SKILLS: Record<string, string[]> = {
  "tech-lead": ["file-github-issue", "review-pr"],
  coder: ["open-pr", "file-github-issue"],
  tester: ["file-github-issue"],
  devops: ["file-github-issue"],
};

const MODEL_NOTES: Record<string, string> = {
  opus: "Best judgement — planning, architecture, reviews. Uses the most of your plan.",
  sonnet: "Strong all-rounder for hands-on engineering.",
  haiku: "Fast and light — simple, routine checks.",
};

export function CreateAgent() {
  const [questions, setQuestions] = useState<CoreQuestion[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [stage, setStage] = useState<Stage>({ name: "role" });
  const [role, setRole] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({ tools: ["GitHub (gh)", "Shell & code editing"] });
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState<string[]>([]);

  useEffect(() => {
    api.interview().then((r) => {
      setQuestions(r.questions);
      setTemplates(r.templates);
    }).catch((e) => setError(e.message));
  }, []);

  const set = (id: string, v: string | string[]) => setAnswers((a) => ({ ...a, [id]: v }));
  const text = (id: string) => (typeof answers[id] === "string" ? (answers[id] as string) : "");

  function pickRole(t: Template | null) {
    setRole(t?.id ?? "custom");
    setSkills(SUGGESTED_SKILLS[t?.id ?? ""] ?? []);
    if (t) setAnswers((a) => ({ ...a, name: text("name") || t.name, job: t.job, done: t.done }));
    setStage({ name: "core", i: 0 });
  }

  async function askFollowUps() {
    setError(null);
    setStage({ name: "thinking", what: "follow-ups" });
    try {
      const r = await api.followUps(answers);
      setFollowUps(r.questions.map((q) => ({ ...q, id: `fu_${q.id}` })));
      setStage({ name: "follow", i: 0 });
    } catch (e: any) {
      setError(e.message);
      setStage({ name: "core", i: questions.length - 1 });
    }
  }

  async function makeDraft() {
    setError(null);
    setStage({ name: "thinking", what: "draft" });
    try {
      setDraft(await api.draft(answers, followUps));
      setStage({ name: "review" });
    } catch (e: any) {
      setError(e.message);
      setStage(followUps.length ? { name: "follow", i: followUps.length - 1 } : { name: "core", i: questions.length - 1 });
    }
  }

  async function create() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await api.createAgent({
        name: text("name").trim(),
        title: draft.title,
        summary: draft.summary,
        model: draft.model,
        instructions: draft.instructions,
        interview: { role, answers, followUps },
        skills,
      });
      go({ name: "agent", id: agent.id });
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  const phase = phaseOf(stage);

  return (
    <div className="wizard">
      <div className="wizard-inner">
        <div className="wizard-top">
          <h1>New agent</h1>
          <div className="progress" aria-label={`Step ${phase + 1} of ${PHASES.length}: ${PHASES[phase]}`}>
            {PHASES.map((p, i) => <span key={p} className={i <= phase ? "on" : ""} title={p} />)}
          </div>
          <a className="btn ghost sm" href="#/">Cancel</a>
        </div>

        {error && <div className="error-box" role="alert">{error}</div>}

        {stage.name === "role" && (
          <>
            <div>
              <div className="stage">Start from a role</div>
              <h2 className="question" style={{ marginTop: 8 }}>What kind of teammate are you hiring?</h2>
              <p className="question-hint">Picking a role fills in sensible first answers. You can change all of them.</p>
            </div>
            <div className="cards">
              {templates.map((t) => (
                <button key={t.id} className="card" style={{ textAlign: "left", cursor: "pointer", font: "inherit" }} onClick={() => pickRole(t)}>
                  <strong>{t.label}</strong>
                  <span className="sub">{t.job}</span>
                </button>
              ))}
              <button className="card new" style={{ textAlign: "left", cursor: "pointer", font: "inherit" }} onClick={() => pickRole(null)}>
                <strong style={{ color: "var(--text)" }}>Something else</strong>
                <span className="sub">Describe the job from scratch.</span>
              </button>
            </div>
          </>
        )}

        {stage.name === "core" && questions[stage.i] && (
          <QuestionStep
            key={questions[stage.i].id}
            label={`Question ${stage.i + 1} of ${questions.length}`}
            q={questions[stage.i]}
            value={answers[questions[stage.i].id] ?? (questions[stage.i].kind === "multi" ? [] : "")}
            onChange={(v) => set(questions[stage.i].id, v)}
            required={["name", "job"].includes(questions[stage.i].id)}
            onBack={() => setStage(stage.i === 0 ? { name: "role" } : { name: "core", i: stage.i - 1 })}
            onNext={() => (stage.i + 1 < questions.length ? setStage({ name: "core", i: stage.i + 1 }) : askFollowUps())}
            nextLabel={stage.i + 1 < questions.length ? "Next" : "Continue"}
          />
        )}

        {stage.name === "thinking" && (
          <div className="thinking" role="status">
            <Spinner />
            {stage.what === "follow-ups"
              ? "Claude is reading your answers and preparing a few follow-up questions…"
              : "Claude is drafting the job description…"}
          </div>
        )}

        {stage.name === "follow" && followUps[stage.i] && (
          <QuestionStep
            key={followUps[stage.i].id}
            label={`Follow-up ${stage.i + 1} of ${followUps.length} · from Claude`}
            q={{ ...followUps[stage.i], hint: "Pick a suggestion, write your own, or skip.", kind: "long" }}
            suggestions={followUps[stage.i].options}
            value={answers[followUps[stage.i].id] ?? ""}
            onChange={(v) => set(followUps[stage.i].id, v)}
            onBack={() => setStage(stage.i === 0 ? { name: "core", i: questions.length - 1 } : { name: "follow", i: stage.i - 1 })}
            onNext={() => (stage.i + 1 < followUps.length ? setStage({ name: "follow", i: stage.i + 1 }) : makeDraft())}
            nextLabel={stage.i + 1 < followUps.length ? "Next" : "Draft the job description"}
          />
        )}

        {stage.name === "review" && draft && (
          <Review
            name={text("name")}
            setName={(v) => set("name", v)}
            draft={draft}
            setDraft={setDraft}
            skills={skills}
            setSkills={setSkills}
            busy={busy}
            onBack={() => setStage(followUps.length ? { name: "follow", i: followUps.length - 1 } : { name: "core", i: questions.length - 1 })}
            onRedraft={makeDraft}
            onCreate={create}
          />
        )}
      </div>
    </div>
  );
}

function QuestionStep(props: {
  label: string;
  q: CoreQuestion | (FollowUp & { hint: string; kind: "long" });
  value: string | string[];
  onChange: (v: string | string[]) => void;
  onBack: () => void;
  onNext: () => void;
  nextLabel: string;
  required?: boolean;
  suggestions?: string[];
}) {
  const { q, value, onChange, required } = props;
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const empty = Array.isArray(value) ? value.length === 0 : !value.trim();
  const canNext = !required || !empty;

  const onKey = (e: KeyboardEvent) => {
    const submit = q.kind === "short" ? e.key === "Enter" : e.key === "Enter" && (e.metaKey || e.ctrlKey);
    if (submit && canNext) {
      e.preventDefault();
      props.onNext();
    }
  };

  return (
    <>
      <div>
        <div className="stage">{props.label}</div>
        <h2 className="question" style={{ marginTop: 8 }}>
          <label htmlFor="answer">{q.question}</label>
        </h2>
        <p className="question-hint">{q.hint}</p>
      </div>

      {q.kind === "multi" ? (
        <div className="choices" role="group" aria-label={q.question}>
          {(q as CoreQuestion).options!.map((o) => {
            const on = (value as string[]).includes(o);
            return (
              <button key={o} className="pill" aria-pressed={on}
                onClick={() => onChange(on ? (value as string[]).filter((x) => x !== o) : [...(value as string[]), o])}>
                {on && <Icon name="check" size={14} />}
                {o}
              </button>
            );
          })}
        </div>
      ) : q.kind === "short" ? (
        <input id="answer" ref={ref} className="text" value={value as string} maxLength={32}
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} autoComplete="off" />
      ) : (
        <>
          {props.suggestions && props.suggestions.length > 0 && (
            <div className="choices">
              {props.suggestions.map((s) => (
                <button key={s} className="pill" aria-pressed={value === s} onClick={() => onChange(s)}>{s}</button>
              ))}
            </div>
          )}
          <textarea id="answer" ref={ref} className="text" rows={4} value={value as string}
            onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} />
        </>
      )}

      <div className="wizard-nav">
        <button className="btn ghost" onClick={props.onBack}><Icon name="back" />Back</button>
        <span className="grow" />
        <span className="hint">{q.kind === "short" ? "⏎ to continue" : q.kind === "long" ? "⌘⏎ to continue" : ""}</span>
        {!required && empty && <button className="btn" onClick={props.onNext}>Skip</button>}
        <button className="btn primary" disabled={!canNext} onClick={props.onNext}>{props.nextLabel}</button>
      </div>
    </>
  );
}

function Review(props: {
  name: string;
  setName: (v: string) => void;
  draft: Draft;
  setDraft: (d: Draft) => void;
  skills: string[];
  setSkills: (s: string[]) => void;
  busy: boolean;
  onBack: () => void;
  onRedraft: () => void;
  onCreate: () => void;
}) {
  const { draft, setDraft } = props;
  const library = useStore().skills;
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [suggested] = useState(draft.model);
  const patch = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  return (
    <>
      <div>
        <div className="stage">Review</div>
        <h2 className="question" style={{ marginTop: 8 }}>Here's the job description Claude drafted</h2>
        <p className="question-hint">
          This becomes the agent's instructions, read at the start of every task. Edit anything; you can change it later too.
        </p>
      </div>

      <div className="draft-grid">
        <div className="field">
          <label htmlFor="d-name">Name</label>
          <input id="d-name" className="text" value={props.name} maxLength={32} onChange={(e) => props.setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="d-title">Role title</label>
          <input id="d-title" className="text" value={draft.title} onChange={(e) => patch({ title: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="d-summary">One-line summary</label>
        <input id="d-summary" className="text" value={draft.summary} onChange={(e) => patch({ summary: e.target.value })} />
      </div>
      <div className="field">
        <span style={{ fontWeight: 500 }} id="d-model">Model</span>
        <div className="segmented" role="group" aria-labelledby="d-model">
          {["opus", "sonnet", "haiku"].map((m) => (
            <button key={m} aria-pressed={draft.model === m} onClick={() => patch({ model: m })}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <span className="hint">
          {MODEL_NOTES[draft.model]}
          {draft.model === suggested && draft.model_reason && <> Claude suggested it: {draft.model_reason}</>}
        </span>
      </div>

      <div className="field">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontWeight: 500, marginRight: "auto" }}>Job description</span>
          <div className="segmented" role="group" aria-label="View">
            <button aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>Preview</button>
            <button aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>Edit</button>
          </div>
        </div>
        {mode === "preview" ? (
          <div className="preview-box"><Markdown text={draft.instructions} /></div>
        ) : (
          <textarea className="text mono" rows={22} value={draft.instructions} aria-label="Job description"
            onChange={(e) => patch({ instructions: e.target.value })} />
        )}
        {/\[[A-Z][A-Z0-9 _-]{2,}\]/.test(draft.instructions) && (
          <span className="hint" style={{ color: "var(--warn)" }}>
            Contains placeholders like [REPO NAME]. Fill them in now, or the agent will ask you.
          </span>
        )}
      </div>

      {library.length > 0 && (
        <div className="field">
          <span style={{ fontWeight: 500 }}>Skills</span>
          <div className="choices" role="group" aria-label="Skills">
            {library.map((s) => {
              const on = props.skills.includes(s.name);
              return (
                <button key={s.name} className="pill" aria-pressed={on} title={s.description}
                  onClick={() => props.setSkills(on ? props.skills.filter((x) => x !== s.name) : [...props.skills, s.name])}>
                  {on && <Icon name="check" size={14} />}<span className="mono" style={{ fontSize: 12.5 }}>{s.name}</span>
                </button>
              );
            })}
          </div>
          <span className="hint">Reusable procedures this agent can follow. Hover a skill to see what it's for; change them any time.</span>
        </div>
      )}

      <div className="wizard-nav">
        <button className="btn ghost" onClick={props.onBack}><Icon name="back" />Back to answers</button>
        <button className="btn" onClick={props.onRedraft}>Redraft</button>
        <span className="grow" />
        <button className="btn primary" disabled={props.busy || !props.name.trim()} onClick={props.onCreate}>
          {props.busy ? "Creating…" : `Create ${props.name.trim() || "agent"}`}
        </button>
      </div>
    </>
  );
}
