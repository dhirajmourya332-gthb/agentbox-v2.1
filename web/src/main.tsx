import { StrictMode } from "react";
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
import { DraftReview, SkillEditor, SkillsList } from "./views/Skills.tsx";

function App() {
  const route = useRoute();
  return (
    <Shell route={route}>
      {route.name === "home" && <Team />}
      {route.name === "new-agent" && <CreateAgent />}
      {route.name === "agent" && <AgentChat key={route.id} agentId={route.id} threadParam={route.thread} />}
      {route.name === "tasks" && <TaskBoard selected={route.task} />}
      {route.name === "group" && <GroupChat key={route.id} id={route.id} />}
      {route.name === "group-settings" && <GroupEditor key={route.id} id={route.id} />}
      {route.name === "new-group" && <GroupEditor />}
      {route.name === "routines" && <RoutinesList />}
      {route.name === "routine" && <RoutineEditor key={route.id} id={route.id} />}
      {route.name === "new-routine" && <RoutineEditor agentId={route.agent} />}
      {route.name === "skills" && <SkillsList />}
      {route.name === "new-skill" && <SkillEditor />}
      {route.name === "skill" && <SkillEditor key={route.skill} name={route.skill} />}
      {route.name === "draft" && <DraftReview key={route.id} id={route.id} />}
      {route.name === "screen" && <Screen />}
      {route.name === "terminal" && <Terminal />}
      {route.name === "system" && <System />}
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
