import { MessageSquare, BarChart3 } from "lucide-react";
import Reveal from "./animation/Reveal";

const UPCOMING = [
  { icon: MessageSquare, title: "WhatsApp & Messenger" },
  { icon: BarChart3, title: "Richer analytics" },
];

export default function RoadmapTeaser() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <Reveal>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-8 text-center">
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--text-1)]">
            What&apos;s next
          </h2>
          <p className="mx-auto mt-2 max-w-md text-[13px] text-[var(--text-4)]">
            Instagram is where we started. Here&apos;s what we&apos;re building toward.
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            {UPCOMING.map((u) => (
              <span
                key={u.title}
                className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-2 text-[12.5px] font-semibold text-[var(--text-3)]"
              >
                <u.icon size={14} strokeWidth={2.2} />
                {u.title}
                <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--text-5)]">
                  Coming soon
                </span>
              </span>
            ))}
          </div>
        </div>
      </Reveal>
    </section>
  );
}
