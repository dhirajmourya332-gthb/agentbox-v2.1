import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Creating an agent is an interview, like hiring: you answer the core questions, Claude asks
 * a few follow-ups specific to that role, then drafts the job description (the agent's
 * CLAUDE.md) for you to review before anything is created.
 */

export const CORE_QUESTIONS = [
  { id: "name", question: "What should we call this agent?", hint: "A short name you'll @mention, e.g. Atlas or reviewer.", kind: "short" },
  { id: "job", question: "What is the one main job you're giving it?", hint: "One or two sentences. Focused agents get better over time.", kind: "long" },
  { id: "where", question: "Where does it work?", hint: "Repos, services, environments, Teams channels — whatever it should look after.", kind: "long" },
  { id: "done", question: "What does great work look like?", hint: "What it delivers and how you'll judge it: a merged PR, a test report, a deploy note…", kind: "long" },
  { id: "tools", question: "Which tools should it use?", hint: "Pick all that apply.", kind: "multi",
    options: ["GitHub (gh)", "AWS (aws)", "Microsoft Teams (browser)", "Web browser", "Docker", "Shell & code editing"] },
  { id: "boundaries", question: "What must it never do without asking you first?", hint: "e.g. merge to main, touch production, delete data, message customers.", kind: "long" },
  { id: "reporting", question: "How and when should it report back?", hint: "e.g. short summary with PR links when done; ping me only if blocked.", kind: "long" },
] as const;

export const TEMPLATES = [
  { id: "tech-lead", label: "Tech lead", name: "lead",
    job: "Own technical direction: break features into tasks, review every pull request, and keep the codebase healthy.",
    done: "Clear plans with acceptance criteria; PR reviews with specific, actionable comments; nothing merged that breaks main." },
  { id: "coder", label: "Coder", name: "coder",
    job: "Implement features and fix bugs from issues and plans, and open well-described pull requests.",
    done: "Small, focused PRs with tests, passing CI, and a description that explains what changed and why." },
  { id: "tester", label: "Tester", name: "tester",
    job: "Test changes before they merge: run the suites, write missing tests, and reproduce and report bugs.",
    done: "A clear pass/fail report per PR, reproducible bug reports with steps, and new tests for regressions." },
  { id: "devops", label: "DevOps", name: "devops",
    job: "Keep CI/CD and environments healthy: deploy to staging, watch pipelines, and fix infrastructure issues.",
    done: "Green pipelines, successful staging deploys with a short release note, and alerts acted on quickly." },
] as const;

export type Answers = Record<string, string | string[]>;

const FOLLOWUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "question", "options"],
        properties: {
          id: { type: "string", description: "short snake_case id" },
          question: { type: "string" },
          options: { type: "array", maxItems: 4, items: { type: "string" }, description: "2-4 short suggested answers, or empty" },
        },
      },
    },
  },
};

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "model", "model_reason", "instructions"],
  properties: {
    title: { type: "string", description: "Role title, 1-4 words, e.g. 'Tech lead'" },
    summary: { type: "string", description: "One sentence describing the agent's job" },
    model: { type: "string", enum: ["opus", "sonnet", "haiku"] },
    model_reason: { type: "string", description: "One short sentence on why this model" },
    instructions: { type: "string", description: "The full job description as markdown (the agent's CLAUDE.md)" },
  },
};

const formatAnswers = (answers: Answers, questions: { id: string; question: string }[]) =>
  questions
    .map((q) => {
      const a = answers[q.id];
      const text = Array.isArray(a) ? a.join(", ") : (a ?? "").trim();
      return `Q: ${q.question}\nA: ${text || "(skipped)"}`;
    })
    .join("\n\n");

async function structured<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
  // A clean, empty working directory: no CLAUDE.md, no tools, nothing written to disk.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-interview-"));
  try {
    const q = query({
      prompt,
      options: {
        cwd,
        model: "sonnet",
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        maxTurns: 4,
        outputFormat: { type: "json_schema", schema },
      },
    });
    for await (const m of q as AsyncIterable<any>) {
      if (m.type === "result") {
        if (m.subtype !== "success" || !m.structured_output) throw new Error(`Claude could not answer (${m.subtype})`);
        return m.structured_output as T;
      }
    }
    throw new Error("No result from Claude");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const CONTEXT = `You are helping the owner of "agentbox" set up a new AI agent teammate. agentbox runs a
team of Claude agents (e.g. tech lead, coder, tester, devops) that share one Linux VM with the
owner's GitHub (gh), AWS CLI, a shared Chromium signed into Microsoft Teams and other web apps,
docker and a shell. The team's purpose is to automate the software development process.`;

export async function followUps(answers: Answers) {
  return structured<{ questions: { id: string; question: string; options: string[] }[] }>(
    `${CONTEXT}

The owner answered the core setup questions:

${formatAnswers(answers, CORE_QUESTIONS as any)}

Ask 2-4 follow-up questions whose answers would most change how this specific agent should
behave. Good follow-ups pin down concrete specifics the role depends on (e.g. for a reviewer:
which standards or checklists apply; for a deployer: which environments and how to verify; for
a coder: branching and test conventions). Do not repeat anything already answered. Keep each
question under 20 words. Offer 2-4 short suggested answers where that helps, else none.`,
    FOLLOWUP_SCHEMA,
  );
}

export async function draft(answers: Answers, extra: { id: string; question: string }[]) {
  return structured<{ title: string; summary: string; model: string; model_reason: string; instructions: string }>(
    `${CONTEXT}

Interview with the owner:

${formatAnswers(answers, [...(CORE_QUESTIONS as any), ...extra])}

Write this agent's job description. It becomes the agent's CLAUDE.md and is read at the start of
every task, so write it to the agent in the second person ("You are …"). Use these markdown
sections, in order, each short and concrete:

# <Name> — <Role title>
## Your job
## Where you work
## How you work         (step-by-step habits for its typical tasks)
## Definition of done
## Ask the owner first  (the boundaries, as a bullet list; never act on these without approval)
## Reporting

Use only facts from the interview. Where a detail the agent will need is missing, write a
placeholder like [REPO NAME] rather than inventing one. No preamble or closing remarks.

Choose the model: opus for judgement-heavy work (planning, architecture, code review), sonnet
for most hands-on engineering (coding, testing, devops), haiku only for simple routine checks.`,
    DRAFT_SCHEMA,
  );
}
