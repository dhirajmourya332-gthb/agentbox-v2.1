import { createNavigationContainerRef, DarkTheme, DefaultTheme, NavigationContainer, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import * as ScreenCapture from "expo-screen-capture";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Stack } from "./src/nav";
import { initPush, markAsked, onPending, permissionState, requestPermission, syncPushToken, takePending, wasAsked, type PushTarget } from "./src/lib/push";
import { SessionProvider, useSession } from "./src/lib/session";
import { StoreProvider, useStore } from "./src/lib/store";
import { DocScreen } from "./src/screens/DocScreen";
import { GroupScreen } from "./src/screens/GroupScreen";
import { GroupsScreen } from "./src/screens/GroupsScreen";
import { NewTaskScreen } from "./src/screens/NewTaskScreen";
import { NotPairedScreen } from "./src/screens/NotPairedScreen";
import { OverviewScreen } from "./src/screens/OverviewScreen";
import { PairScreen } from "./src/screens/PairScreen";
import { PendingScreen } from "./src/screens/PendingScreen";
import { RoomScreen } from "./src/screens/RoomScreen";
import { RoutinesScreen } from "./src/screens/RoutinesScreen";
import { RunScreen } from "./src/screens/RunScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { UnlockScreen } from "./src/screens/UnlockScreen";
import { WorkScreen } from "./src/screens/WorkScreen";
import { PauseControl } from "./src/ui/PauseControl";
import { DialogHost, showDialog } from "./src/ui/dialog";
import { T } from "./src/ui/kit";
import { isDark, usePalette } from "./src/ui/theme";

const Nav = createNativeStackNavigator<Stack>();
const navRef = createNavigationContainerRef<Stack>();

export default function App() {
  // Block screenshots and screen recording app-wide (Android FLAG_SECURE; also blanks the
  // app-switcher thumbnail). Nothing renders until it's in place.
  // Fails closed: if protection can't be turned on, nothing else is shown.
  const [secured, setSecured] = useState<"pending" | "on" | "failed">("pending");
  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync("agentbox").then(() => setSecured("on"), () => setSecured("failed"));
  }, []);
  // Notification taps are remembered (ids only) and acted on after unlock.
  useEffect(() => initPush(), []);

  const p = usePalette();
  return (
    <SafeAreaProvider>
      <StatusBar style={isDark(p) ? "light" : "dark"} />
      {secured === "on" ? (
        <SessionProvider><Gate /><DialogHost /></SessionProvider>
      ) : secured === "failed" ? (
        <View style={{ flex: 1, backgroundColor: p.bg, justifyContent: "center", padding: 24, gap: 12 }}>
          <T size={22} weight="700">Screen protection unavailable</T>
          <T muted>agentbox couldn't block screenshots on this phone, so it won't show anything. Restart the app to try again.</T>
        </View>
      ) : (
        <View style={{ flex: 1, backgroundColor: p.bg }} />
      )}
    </SafeAreaProvider>
  );
}

/** Picks what to show from the security state. The main app only mounts while unlocked + active. */
function Gate() {
  const { phase } = useSession();
  const p = usePalette();
  const pre = (child: React.ReactNode) => (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={["top", "bottom"]}>{child}</SafeAreaView>
  );
  switch (phase.name) {
    case "boot":
      return pre(<ActivityIndicator style={{ flex: 1 }} color={p.muted} />);
    case "unpaired":
      return pre(<PairScreen />);
    case "locked":
      return pre(<UnlockScreen />);
    case "pending":
      return pre(<PendingScreen pairing={phase.pairing} />);
    case "unrecognized":
      return pre(<NotPairedScreen />);
    case "ready":
      return <MainApp />;
  }
}

function MainApp() {
  const p = usePalette();
  const theme: Theme = useMemo(() => {
    const base = isDark(p) ? DarkTheme : DefaultTheme;
    return { ...base, colors: { ...base.colors, background: p.bg, card: p.surface, text: p.text, border: p.border, primary: p.accent } };
  }, [p]);
  const [navReady, setNavReady] = useState(false);
  return (
    <StoreProvider>
      <NavigationContainer theme={theme} ref={navRef} onReady={() => setNavReady(true)}>
        <Nav.Navigator initialRouteName="Overview" screenOptions={{ headerTitleStyle: { fontSize: 17 }, headerShadowVisible: false }}>
          <Nav.Screen name="Overview" component={OverviewScreen} options={{ title: "agentbox", headerRight: () => <PauseControl /> }} />
          <Nav.Screen name="Work" component={WorkScreen} options={{ title: "Tasks", headerRight: () => <PauseControl /> }} />
          <Nav.Screen name="Room" component={RoomScreen} options={{ title: "Task" }} />
          <Nav.Screen name="Groups" component={GroupsScreen} options={{ title: "Groups" }} />
          <Nav.Screen name="Group" component={GroupScreen} options={{ title: "Group" }} />
          <Nav.Screen name="Doc" component={DocScreen} options={{ title: "Document" }} />
          <Nav.Screen name="NewTask" component={NewTaskScreen} options={{ title: "New task" }} />
          <Nav.Screen name="Routines" component={RoutinesScreen} options={{ title: "Routines", headerRight: () => <PauseControl /> }} />
          <Nav.Screen name="Run" component={RunScreen} options={{ title: "Routine run" }} />
          <Nav.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
        </Nav.Navigator>
      </NavigationContainer>
      <PushBridge navReady={navReady} />
    </StoreProvider>
  );
}

/**
 * While unlocked: asks once for notification permission (with an explanation), keeps the push
 * token registered, and opens whatever a tapped notification pointed at. The notification only
 * carried ids; the details are fetched now, after unlock, like any other screen.
 */
function PushBridge({ navReady }: { navReady: boolean }) {
  const { loaded, groups, markSeen } = useStore();
  const [target, setTarget] = useState<PushTarget | null>(() => takePending());

  useEffect(() => onPending(() => setTarget(takePending())), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if ((await permissionState()) === "ask" && !(await wasAsked())) {
        if (!alive) return;
        showDialog(
          "Get notified when something needs you?",
          "agentbox can notify this phone when an agent replies to you, fails or looks stuck. The notification only says \"Something needs you\", with no details, and opening it still asks you to unlock.",
          [
            { text: "Not now", style: "cancel", onPress: () => { markAsked(); } },
            { text: "Allow", onPress: () => { requestPermission().then((ok) => { if (ok) syncPushToken(); }, () => {}); } },
          ],
        );
        return;
      }
      await syncPushToken();
    })().catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!target || !navReady || !loaded || !navRef.isReady()) return;
    setTarget(null);
    if (target.attentionId) markSeen([target.attentionId]);
    if (target.roomId) {
      const g = groups.find((x) => x.id === target.roomId);
      if (g) navRef.navigate("Group", { id: g.id, title: g.name });
      else navRef.navigate("Room", { id: target.roomId });
    } else {
      navRef.navigate("Overview");
    }
  }, [target, navReady, loaded, groups, markSeen]);

  return null;
}
