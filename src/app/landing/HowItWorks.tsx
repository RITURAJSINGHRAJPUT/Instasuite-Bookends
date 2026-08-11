import { MessageCircle, Bot, ClipboardCheck } from "lucide-react";
import Reveal from "./animation/Reveal";

const STEPS = [
  {
    icon: MessageCircle,
    title: "A guest messages your Instagram",
    body: "Asking about a table, placing a takeaway order, or just asking a question — it all starts as a normal DM.",
  },
  {
    icon: Bot,
    title: "The AI agent replies instantly, in your voice",
    body: "Trained on your restaurant's own script — menu, hours, outlets, policies — it handles the back-and-forth: confirms date, time, and party size for a reservation, or items and pickup time for a takeaway.",
  },
  {
    icon: ClipboardCheck,
    title: "It lands in your dashboard as a real order",
    body: "The moment a reservation or takeaway is finalized, it's captured as a structured order your team confirms with one click. Anything that needs a human — a complaint, a question your script can't answer — is flagged for your team instead of guessed at.",
  },
];

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto max-w-6xl px-6 py-20">
      <Reveal>
        <h2 className="text-2xl font-extrabold tracking-tight text-[var(--text-1)] md:text-3xl">
          From DM to order, without you lifting a finger
        </h2>
      </Reveal>

      <div className="mt-10 grid gap-6 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <Reveal key={step.title} delay={i * 0.08}>
            <div className="h-full rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                <step.icon size={18} strokeWidth={2.2} />
              </div>
              <p className="mt-4 text-[10px] font-bold uppercase tracking-wider text-[var(--text-5)]">
                Step {i + 1}
              </p>
              <h3 className="mt-1 text-[15px] font-bold text-[var(--text-1)]">{step.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-3)]">{step.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
