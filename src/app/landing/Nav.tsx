import Link from "next/link";
import { LogoMark } from "@/components/Logo";

export default function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--app-bg)]/85 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
        <a href="#" className="flex items-center gap-2">
          <LogoMark size="sm" />
          <span className="text-sm font-bold tracking-tight text-[var(--text-1)]">Instasuite</span>
        </a>

        <nav className="hidden items-center gap-6 text-[13px] font-semibold text-[var(--text-3)] md:flex">
          <a href="#how-it-works" className="transition-colors hover:text-[var(--text-1)]">
            How it works
          </a>
          <a href="#features" className="transition-colors hover:text-[var(--text-1)]">
            Features
          </a>
          <a href="#restaurants" className="transition-colors hover:text-[var(--text-1)]">
            For restaurants
          </a>
        </nav>

        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="hidden text-[13px] font-semibold text-[var(--text-4)] transition-colors hover:text-[var(--text-2)] sm:inline"
          >
            Sign in
          </Link>
          <a
            href="#request-access"
            className="rounded-xl bg-[var(--accent)] px-4 py-2 text-[13px] font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)]"
          >
            Request access
          </a>
        </div>
      </div>
    </header>
  );
}
