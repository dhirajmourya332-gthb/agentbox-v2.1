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
  Settings: undefined;
};

export type Props<K extends keyof Stack> = NativeStackScreenProps<Stack, K>;
