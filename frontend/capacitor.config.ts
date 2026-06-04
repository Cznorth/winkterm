import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.winkterm.app",
  appName: "WinkTerm",
  // Next.js static export output (next build with output: 'export').
  webDir: "out",
  android: {
    // The WebView origin is https://localhost. Users may point the app at a
    // plain http/ws backend on a LAN, so allow mixed content. For untrusted
    // networks, prefer an https/wss backend.
    allowMixedContent: true,
  },
};

export default config;
