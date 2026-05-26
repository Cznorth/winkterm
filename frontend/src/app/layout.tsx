import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import "@xterm/xterm/css/xterm.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "WinkTerm",
  description: "AI + Terminal human-machine unified operations tool",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("winkterm-theme");if(!t||t==="system"){t=window.matchMedia("(prefers-color-scheme:light)").matches?"light":"dark"}document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`,
          }}
        />
      </head>
      <body style={{ margin: 0, padding: 0, overflow: "hidden" }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
