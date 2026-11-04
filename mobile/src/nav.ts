import type { NativeStackScreenProps } from "@react-navigation/native-stack";

export type Stack = {
  Overview: undefined;
  Work: undefined;
  Room: { id: string; title?: string };
  Groups: undefined;
  Group: { id: string; title?: string };
  Doc: { path: string; name: string };
  NewTask: undefined;
  Routines: undefined;
  Run: { id: string; title?: string };
  Settings: undefined;
  // Web parity (v2.1).
  SharedScreen: undefined;
  Team: undefined;
  Agent: { id: string; title?: string };
  Documents: undefined;
  Activity: undefined;
  System: undefined;
  Hosted: undefined;
  Connections: undefined;
  Servers: undefined;
};

export type Props<K extends keyof Stack> = NativeStackScreenProps<Stack, K>;
