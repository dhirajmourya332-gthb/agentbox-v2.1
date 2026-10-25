import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";
import { StoreProvider } from "./store.tsx";
import { useRoute } from "./router.ts";
import { Shell } from "./components/Shell.tsx";
import { Team } from "./views/Team.tsx";
import { CreateAgent } from "./views/CreateAgent.tsx";
import { AgentChat } from "./views/AgentChat.tsx";
import { Screen, System, Terminal } from "./views/Computer.tsx";
import { TaskBoard } from "./views/Tasks.tsx";
import { GroupChat, GroupEditor } from "./views/Groups.tsx";
import { RoutineEditor, RoutinesList } from "./views/Routines.tsx";
import { RoutineRunPage } from "./views/RoutineRun.tsx";
import { Activity } from "./views/Activity.tsx";
import { NewTask } from "./views/NewTask.tsx";
import { Crews } from "./views/Crews.tsx";
import { Room } from "./views/Room.tsx";
import { DocumentsPage } from "./views/DocumentsPage.tsx";
import { LinkedFileReader } from "./views/Documents.tsx";
import { Devices } from "./views/Devices.tsx";
import { Integrations } from "./views/Integrations.tsx";
import { Repos } from "./views/Repos.tsx";
// The Setup workspace brings xterm.js: loaded on first use.
const SetupWorkspace = lazy(() => import("./views/SetupWorkspace.tsx").then((m) => ({ default: m.SetupWorkspace })));

/** Clicking a file path anywhere opens it in the reader (Cmd/Ctrl/middle-click still opens a tab). */
function FileLinks() {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[data-file-path]") as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      setPath(a.dataset.filePath ?? null);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return path ? <LinkedFileReader key={path} path={path} onClose={() => setPath(null)} /> : null;
}
import { DraftReview, SkillEditor, SkillsList } from "./views/Skills.tsx";
import { Changes } from "./views/Changes.tsx";

function App() {
  const route = useRoute();
  return (
    <Shell route={route}>
      {route.name === "home" && <Team />}
      {route.name === "new-agent" && <CreateAgent />}
      {route.name === "crews" && <Crews />}
      {route.name === "changes" && <Changes key={route.id} instanceId={route.id} />}
      {route.name === "agent" && <AgentChat key={route.id} agentId={route.id} threadParam={route.thread} msgParam={route.msg} />}
      {route.name === "tasks" && <TaskBoard selected={route.task} />}
      {route.name === "group" && <GroupChat key={route.id} id={route.id} />}
      {route.name === "group-settings" && <GroupEditor key={route.id} id={route.id} />}
      {route.name === "new-group" && <GroupEditor />}
      {route.name === "activity" && <Activity />}
      {route.name === "new-task" && <NewTask key={route.role ?? "any"} roleId={route.role} />}
      {route.name === "room" && <Room key={route.id} id={route.id} />}
      {route.name === "documents" && <DocumentsPage />}
      {route.name === "routines" && <RoutinesList />}
      {route.name === "routine" && <RoutineEditor key={route.id} id={route.id} />}
      {route.name === "routine-run" && <RoutineRunPage key={route.runId} routineId={route.routineId} runId={route.runId} />}
      {route.name === "new-routine" && <RoutineEditor agentId={route.agent} />}
      {route.name === "skills" && <SkillsList />}
      {route.name === "new-skill" && <SkillEditor />}
      {route.name === "skill" && <SkillEditor key={route.skill} name={route.skill} />}
      {route.name === "draft" && <DraftReview key={route.id} id={route.id} />}
      {route.name === "screen" && <Screen />}
      {route.name === "terminal" && <Terminal />}
      {route.name === "system" && <System />}
      {route.name === "devices" && <Devices />}
      {route.name === "integrations" && <Integrations />}
      {route.name === "repos" && <Repos focus={route.repo} />}
      {route.name === "setup" && <Suspense fallback={<div className="page" />}><SetupWorkspace key={route.id ?? "latest"} instanceId={route.id} /></Suspense>}
      <FileLinks />
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
