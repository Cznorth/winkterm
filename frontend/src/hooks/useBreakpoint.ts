"use client";

import { useState, useEffect } from "react";

export type Breakpoint = "desktop" | "tablet" | "mobile";

const MOBILE_QUERY = "(max-width: 768px)";
const TABLET_QUERY = "(max-width: 1024px)";

function resolveBreakpoint(): Breakpoint {
  if (typeof window === "undefined") return "desktop";
  if (window.matchMedia(MOBILE_QUERY).matches) return "mobile";
  if (window.matchMedia(TABLET_QUERY).matches) return "tablet";
  return "desktop";
}

export function useBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>("desktop");

  useEffect(() => {
    const mobile = window.matchMedia(MOBILE_QUERY);
    const tablet = window.matchMedia(TABLET_QUERY);

    const update = () => setBreakpoint(resolveBreakpoint());

    update();
    mobile.addEventListener("change", update);
    tablet.addEventListener("change", update);
    return () => {
      mobile.removeEventListener("change", update);
      tablet.removeEventListener("change", update);
    };
  }, []);

  return breakpoint;
}
