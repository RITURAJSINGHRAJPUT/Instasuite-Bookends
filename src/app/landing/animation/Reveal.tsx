"use client";

import { useRef, type ReactNode } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { EASE, DURATION, Y_OFFSET } from "./gsapConfig";

gsap.registerPlugin(ScrollTrigger);

/**
 * Fades + slides a section in the first time it scrolls into view. Plays once
 * (toggleActions "play none none none") — replaying on every scroll pass reads
 * as gimmicky rather than polished.
 */
export default function Reveal({
  children,
  className,
  delay = 0,
  y = Y_OFFSET,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (!ref.current) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      gsap.from(ref.current, {
        opacity: 0,
        y,
        duration: DURATION,
        delay,
        ease: EASE,
        scrollTrigger: {
          trigger: ref.current,
          start: "top 85%",
          toggleActions: "play none none none",
        },
      });
    },
    { scope: ref }
  );

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
