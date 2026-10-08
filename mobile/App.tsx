import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import * as ScreenCapture from "expo-screen-capture";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Stack } from "./src/nav";
import { SessionProvider, useSession } from "./src/lib/session";
import { StoreProvider } from "./src/lib/store";
import { NewTaskScreen } from "./src/screens/NewTaskScreen";
import { NotPairedScreen } from "./src/screens/NotPairedScreen";
import { PairScreen } from "./src/screens/PairScreen";
import { PendingScreen } from "./src/screens/PendingScreen";
import { RoomScreen } from "./src/screens/RoomScreen";
import { RoutinesScreen } from "./src/screens/RoutinesScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { UnlockScreen } from "./src/screens/UnlockScreen";
import { WorkScreen } from "./src/screens/WorkScreen";
import { PauseControl } from "./src/ui/PauseControl";
import { DialogHost } from "./src/ui/dialog";
import { T } from "./src/ui/kit";
import { isDark, usePalette } from "./src/ui/theme";

const Nav = createNativeStackNavigator<Stack>();

export default function App() {
  // Block screenshots and screen recording app-wide (Android FLAG_SECURE; also blanks the
  // app-switcher thumbnail). Nothing renders until it's in place.
  // Fails closed: if protection can't be turned on, nothing else is shown.
  const [secured, setSecured] = useState<"pending" | "on" | "failed">("pending");
  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync("agentbox").then(() => setSecured("on"), () => setSecured("failed"));
  }, []);

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
  return (
    <StoreProvider>
      <NavigationContainer theme={theme}>
        <Nav.Navigator screenOptions={{ headerTitleStyle: { fontSize: 17 }, headerShadowVisible: false }}>
          <Nav.Screen name="Work" component={WorkScreen} options={{ title: "agentbox", headerRight: () => <PauseControl /> }} />
          <Nav.Screen name="Room" component={RoomScreen} options={{ title: "Task" }} />
          <Nav.Screen name="NewTask" component={NewTaskScreen} options={{ title: "New task" }} />
          <Nav.Screen name="Routines" component={RoutinesScreen} options={{ title: "Routines", headerRight: () => <PauseControl /> }} />
          <Nav.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
        </Nav.Navigator>
      </NavigationContainer>
    </StoreProvider>
  );
}
