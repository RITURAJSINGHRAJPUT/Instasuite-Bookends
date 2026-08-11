import Link from "next/link";
import { LogoMark } from "@/components/Logo";

export default function Footer() {
  return (
    <footer className="border-t border-[var(--border)]">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-6 py-10 text-center sm:flex-row sm:justify-between sm:text-left">
        <div className="flex items-center gap-2">
          <LogoMark size="sm" />
          <span className="text-[13px] font-bold text-[var(--text-2)]">Instasuite</span>
        </div>

        <p className="text-[12px] text-[var(--text-5)]">
          © {new Date().getFullYear()} Instasuite. All rights reserved.
        </p>

        <div className="flex items-center gap-4 text-[12px] font-semibold text-[var(--text-4)]">
          <Link href="/privacy" className="transition-colors hover:text-[var(--text-2)]">
            Privacy
          </Link>
          <Link href="/terms" className="transition-colors hover:text-[var(--text-2)]">
            Terms
          </Link>
          <Link href="/data-deletion" className="transition-colors hover:text-[var(--text-2)]">
            Data deletion
          </Link>
        </div>
      </div>
    </footer>
  );
}
