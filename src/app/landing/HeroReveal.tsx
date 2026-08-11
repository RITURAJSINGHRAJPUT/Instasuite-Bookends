"use client";

import { useRef, type ReactNode } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { EASE } from "./animation/gsapConfig";

/**
 * Staggers the hero's eyebrow/headline/subhead/CTAs/mockup in on mount. Not
 * scroll-triggered — it's above the fold, so it should animate immediately.
 */
export default function HeroReveal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (!ref.current) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      const targets = ref.current.querySelectorAll<HTMLElement>("[data-hero-item]");
      if (!targets.length) return;

      gsap.from(targets, {
        opacity: 0,
        y: 20,
        duration: 0.55,
        ease: EASE,
        stagger: 0.1,
      });
    },
    { scope: ref }
  );

  return <div ref={ref}>{children}</div>;
}
