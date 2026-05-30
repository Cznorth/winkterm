"use client";

import { useEffect, useState } from "react";

function measureKeyboardInset(): number {
  if (typeof window === "undefined") return 0;
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
}

/** Sync --keyboard-inset so the action bar moves up when the system keyboard opens (bottom nav unaffected) */
export function useKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (!enabled) {
      document.documentElement.style.setProperty("--keyboard-inset", "0px");
      setInset(0);
      return;
    }

    const update = () => {
      const next = measureKeyboardInset();
      setInset(next);
      document.documentElement.style.setProperty("--keyboard-inset", `${next}px`);
    };

    update();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.documentElement.style.setProperty("--keyboard-inset", "0px");
    };
  }, [enabled]);

  return inset;
}
