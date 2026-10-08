import type { NativeStackScreenProps } from "@react-navigation/native-stack";

export type Stack = {
  Work: undefined;
  Room: { id: string; title?: string };
  NewTask: undefined;
  Routines: undefined;
  Settings: undefined;
};

export type Props<K extends keyof Stack> = NativeStackScreenProps<Stack, K>;
