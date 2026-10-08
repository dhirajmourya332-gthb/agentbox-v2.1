import { useState } from "react";
import { showDialog } from "./dialog";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { Button } from "./kit";

/** Header control: Pause all (with the portal's two options) or Resume. */
export function PauseControl() {
  const { paused } = useStore();
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try { await f(); } catch (e) { showDialog("Couldn't do that", e instanceof Error ? e.message : ""); } finally { setBusy(false); }
  };

  if (paused) return <Button small label="Resume" busy={busy} onPress={() => run(api.resumeAll)} />;

  const ask = async () => {
    setBusy(true);
    let running = 0;
    try { running = (await api.control()).running; } catch { /* still offer to pause */ }
    setBusy(false);
    const body = `Nothing new starts until you resume: queued work waits and routines skip. ${
      running > 0 ? `${running} turn${running > 1 ? "s are" : " is"} running right now.` : "Nothing is running right now."}`;
    showDialog("Pause every agent?", body, running > 0
      ? [
          { text: "Cancel", style: "cancel" },
          { text: "Let them finish", onPress: () => run(() => api.pauseAll(false)) },
          { text: "Stop and pause", style: "destructive", onPress: () => run(() => api.pauseAll(true)) },
        ]
      : [
          { text: "Cancel", style: "cancel" },
          { text: "Pause", style: "destructive", onPress: () => run(() => api.pauseAll(true)) },
        ]);
  };
  return <Button small variant="danger" label="Pause all" busy={busy} onPress={ask} />;
}
