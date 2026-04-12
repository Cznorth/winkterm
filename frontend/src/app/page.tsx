import dynamic from "next/dynamic";
import SplitLayout from "@/components/Layout";
import AIPanel from "@/components/AIPanel";

// xterm.js 必须禁用 SSR
const TerminalPanel = dynamic(() => import("@/components/Terminal"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "#1a1a2e",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#444",
        fontFamily: "monospace",
        fontSize: "13px",
      }}
    >
      Loading terminal...
    </div>
  ),
});

export default function Home() {
  return (
    <SplitLayout
      terminal={<TerminalPanel />}
      aiPanel={<AIPanel />}
    />
  );
}
