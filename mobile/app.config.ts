/// <reference types="node" />
/**
 * Install-specific Expo config, layered over app.json. Nothing personal is committed: every
 * account-specific value comes from the environment (set them in your shell, or in EAS
 * environment variables, before `eas init` / `eas build`):
 *
 *   EXPO_OWNER            your Expo account or organisation (optional; defaults to the logged-in user)
 *   EAS_PROJECT_ID        the project id `eas init` printed (optional until you build with EAS)
 *   ANDROID_PACKAGE       the Android application id (default org.agentbox.mobile)
 *   GOOGLE_SERVICES_FILE  path to your Firebase google-services.json (optional; default
 *                         ./google-services.json). Push notifications are configured only if
 *                         this file exists. The file is git-ignored; never commit it.
 */
import fs from "node:fs";
import path from "node:path";
import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => {
  const env = process.env;
  const googleServices = env.GOOGLE_SERVICES_FILE || "./google-services.json";
  const hasPush = fs.existsSync(path.resolve(__dirname, googleServices));
  const plugins = [...(config.plugins ?? [])];
  if (hasPush) {
    plugins.push(["expo-notifications", { icon: "./assets/android-icon-monochrome.png", color: "#2f5bd3", defaultChannel: "attention" }]);
  }
  return {
    ...config,
    name: config.name ?? "agentbox",
    slug: config.slug ?? "agentbox",
    ...(env.EXPO_OWNER ? { owner: env.EXPO_OWNER } : {}),
    android: {
      ...config.android,
      package: env.ANDROID_PACKAGE || config.android?.package || "org.agentbox.mobile",
      ...(hasPush ? { googleServicesFile: googleServices } : {}),
    },
    plugins,
    extra: {
      ...config.extra,
      ...(env.EAS_PROJECT_ID ? { eas: { projectId: env.EAS_PROJECT_ID } } : {}),
    },
  };
};
