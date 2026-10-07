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

function App() {
  const route = useRoute();
  return (
    <Shell route={route}>
      {route.name === "home" && <Team />}
      {route.name === "new-agent" && <CreateAgent />}
      {route.name === "agent" && <AgentChat key={route.id} agentId={route.id} />}
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
