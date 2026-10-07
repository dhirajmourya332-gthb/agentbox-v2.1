import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "agent"; id: string }
  | { name: "new-agent" }
  | { name: "screen" }
  | { name: "terminal" }
  | { name: "system" };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "agents" && parts[1] === "new") return { name: "new-agent" };
  if (parts[0] === "agents" && parts[1]) return { name: "agent", id: parts[1] };
  if (parts[0] === "screen" || parts[0] === "terminal" || parts[0] === "system") return { name: parts[0] };
  return { name: "home" };
}

export const href = (r: Route) =>
  r.name === "home" ? "#/" : r.name === "agent" ? `#/agents/${r.id}` : r.name === "new-agent" ? "#/agents/new" : `#/${r.name}`;

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
