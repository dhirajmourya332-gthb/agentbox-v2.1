import { StyleSheet, View } from "react-native";
import { useSession } from "../lib/session";
import { serverName } from "../lib/vault";
import { Button, Screen, T } from "../ui/kit";

/** Any signed request got a 404: revoked, denied, expired, or the request was refused. */
export function NotPairedScreen() {
  const { phase, servers, forget, retry, switchTo } = useSession();
  const current = phase.name === "unrecognized" ? phase.pairing : null;
  const others = servers.filter((x) => x.deviceId !== current?.deviceId);
  const pending = phase.name === "unrecognized" && phase.pairing?.status === "pending";
  return (
    <Screen style={st.wrap}>
      <View style={st.center}>
        <T size={24} weight="700" style={{ textAlign: "center" }}>
          {current && servers.length > 1 ? `Not paired with ${serverName(current)} any more` : "This phone isn't paired any more"}
        </T>
        <T muted style={{ textAlign: "center" }}>
          {pending
            ? "The request wasn't approved in time, or it was denied."
            : "agentbox didn't recognise this phone. It may have been revoked in the portal."}
        </T>
        <T muted size={13} style={{ textAlign: "center" }}>
          If you think it's still paired, check that this phone's clock is set automatically, then try again.
        </T>
      </View>
      <View style={{ gap: 10 }}>
        <Button variant="primary" label="Pair again" onPress={() => { forget(true); }} />
        {phase.name === "unrecognized" && phase.pairing && !pending && <Button label="Try again" onPress={retry} />}
        {others.map((x) => <Button key={x.deviceId} variant="ghost" label={`Switch to ${serverName(x)}`} onPress={() => { switchTo(x.deviceId); }} />)}
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  wrap: { padding: 24 },
  center: { flex: 1, justifyContent: "center", gap: 14 },
});
