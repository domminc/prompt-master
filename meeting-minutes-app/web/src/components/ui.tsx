import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-slate-300 disabled:text-slate-500",
  secondary: "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:text-slate-400",
  ghost: "text-slate-600 hover:bg-slate-100 disabled:text-slate-400",
  danger: "border border-rose-200 bg-white text-rose-700 hover:bg-rose-50",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  block?: boolean;
}

/** 모바일에서도 누르기 쉽도록 최소 높이 44px */
export function Button({ variant = "secondary", loading, block, className = "", children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${
        block ? "w-full" : ""
      } ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {loading && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  // className 에 배경색(bg-*)이 있으면 기본 흰 배경을 깔지 않는다 (Tailwind 는 클래스 순서가 아니라 CSS 순서로 우선순위가 정해져 충돌한다)
  const bg = /(^|\s)bg-/.test(className) ? "" : "bg-white";
  return <section className={`rounded-2xl border border-slate-200 ${bg} ${className}`}>{children}</section>;
}

export function SectionTitle({ icon, children, aside }: { icon?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
        {icon && <span className="text-indigo-600">{icon}</span>}
        {children}
      </h2>
      {aside}
    </div>
  );
}

type Tone = "slate" | "indigo" | "amber" | "rose" | "emerald";
const TONES: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-700",
  indigo: "bg-indigo-50 text-indigo-700",
  amber: "bg-amber-50 text-amber-800",
  rose: "bg-rose-50 text-rose-700",
  emerald: "bg-emerald-50 text-emerald-700",
};

export function Badge({ tone = "slate", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}>
      {children}
    </span>
  );
}
