import type { Metadata } from "next";
import { Providers } from "./providers";
import "@xterm/xterm/css/xterm.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "WinkTerm",
  description: "AI + Terminal human-machine unified operations tool",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, padding: 0, overflow: "hidden" }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
