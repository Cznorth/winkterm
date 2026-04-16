import SplitLayout from "@/components/Layout";
import AIPanel from "@/components/AIPanel";

export default function Home() {
  return (
    <SplitLayout aiPanel={<AIPanel />} />
  );
}
