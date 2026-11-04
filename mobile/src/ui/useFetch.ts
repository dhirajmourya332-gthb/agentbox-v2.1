import { useCallback, useEffect, useRef, useState } from "react";
import { isMissingRoute } from "../lib/store";

/**
 * Loads something once (and on refresh) for a screen that keeps its own data. `missing`: the
 * agentbox doesn't have the route (an older version), so the screen says it isn't available.
 */
export function useFetch<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await loadRef.current();
      if (!alive.current) return;
      setData(d);
      setError(null);
      setMissing(false);
    } catch (e) {
      if (!alive.current) return;
      if (isMissingRoute(e)) setMissing(true);
      else setError(e instanceof Error ? e.message : "Couldn't load");
    }
  }, []);

  const pull = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    if (alive.current) setRefreshing(false);
  }, [refresh]);

  useEffect(() => { refresh(); }, [refresh]);
  return { data, error, missing, refreshing, refresh, pull };
}

export const NOT_AVAILABLE = "This agentbox doesn't have this yet. Update it to the latest version.";
