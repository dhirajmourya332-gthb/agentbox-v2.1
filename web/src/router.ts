import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "agent"; id: string; thread?: string }
  | { name: "tasks"; task?: string }
  | { name: "group"; id: string }
  | { name: "group-settings"; id: string }
  | { name: "new-group" }
  | { name: "new-agent" }
  | { name: "screen" }
  | { name: "terminal" }
  | { name: "system" }
  | { name: "skills" }
  | { name: "skill"; skill: string }
  | { name: "new-skill" }
  | { name: "draft"; id: string };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "agents" && parts[1] === "new") return { name: "new-agent" };
  if (parts[0] === "agents" && parts[1]) return { name: "agent", id: parts[1], thread: parts[2] === "threads" ? parts[3] : undefined };
  if (parts[0] === "groups" && parts[1] === "new") return { name: "new-group" };
  if (parts[0] === "groups" && parts[1] && parts[2] === "settings") return { name: "group-settings", id: parts[1] };
  if (parts[0] === "groups" && parts[1]) return { name: "group", id: parts[1] };
  if (parts[0] === "tasks") return { name: "tasks", task: parts[1] };
  if (parts[0] === "skills" && parts[1] === "new") return { name: "new-skill" };
  if (parts[0] === "skills" && parts[1] === "drafts" && parts[2]) return { name: "draft", id: parts[2] };
  if (parts[0] === "skills" && parts[1]) return { name: "skill", skill: parts[1] };
  if (parts[0] === "skills") return { name: "skills" };
  if (parts[0] === "screen" || parts[0] === "terminal" || parts[0] === "system") return { name: parts[0] };
  return { name: "home" };
}

export function href(r: Route): string {
  switch (r.name) {
    case "home": return "#/";
    case "agent": return r.thread ? `#/agents/${r.id}/threads/${r.thread}` : `#/agents/${r.id}`;
    case "group": return `#/groups/${r.id}`;
    case "group-settings": return `#/groups/${r.id}/settings`;
    case "new-group": return "#/groups/new";
    case "tasks": return r.task ? `#/tasks/${r.task}` : "#/tasks";
    case "new-agent": return "#/agents/new";
    case "skill": return `#/skills/${r.skill}`;
    case "new-skill": return "#/skills/new";
    case "draft": return `#/skills/drafts/${r.id}`;
    default: return `#/${r.name}`;
  }
}

export const go = (r: Route) => {
  location.hash = href(r);
};

export function useRoute() {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}
