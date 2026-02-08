import type { ReactNode } from "react";

interface Feature {
  text: string;
  bold?: boolean;
}

interface PricingCardProps {
  title: string;
  price: string;
  priceSubtext: string;
  description: string;
  features: Feature[];
  ctaText: string;
  ctaHref: string;
  footer: string;
  highlighted?: boolean;
  badge?: string;
  variant?: "emerald" | "blue";
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={`mt-0.5 size-5 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}

export function PricingCard({
  title,
  price,
  priceSubtext,
  description,
  features,
  ctaText,
  ctaHref,
  footer,
  highlighted = false,
  badge,
  variant = "emerald",
}: PricingCardProps) {
  const styles = {
    emerald: {
      border: "border-emerald-500/50",
      shadow: "shadow-emerald-900/20",
      badge: "bg-emerald-600",
      textGradient: "from-emerald-400 to-emerald-200",
      button: "bg-emerald-600 hover:bg-emerald-500 text-white",
      icon: "text-emerald-500",
    },
    blue: {
      border: "border-blue-500/50",
      shadow: "shadow-blue-900/20",
      badge: "bg-blue-600",
      textGradient: "from-blue-400 to-blue-200",
      button: "bg-blue-600 hover:bg-blue-500 text-white",
      icon: "text-blue-500",
    },
  };

  const theme = styles[variant];

  return (
    <div
      className={`relative flex flex-col rounded-xl p-6 backdrop-blur-sm ${
        highlighted
          ? `border-2 ${theme.border} bg-slate-800/60 shadow-lg ${theme.shadow}`
          : "border border-slate-700/50 bg-slate-800/40 shadow-md"
      }`}
    >
      {badge && (
        <div
          className={`absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs font-semibold text-white ${theme.badge}`}
        >
          {badge}
        </div>
      )}

      <div className="mb-4">
        <h3 className="text-2xl font-bold text-slate-100">{title}</h3>
        <div className="mt-2 flex items-baseline gap-2">
          <span
            className={`bg-linear-to-r bg-clip-text text-4xl font-bold text-transparent ${theme.textGradient}`}
          >
            {price}
          </span>
          <span className="text-slate-400">{priceSubtext}</span>
        </div>
      </div>

      <p className="mb-6 text-slate-400">{description}</p>

      <ul className="mb-6 grow space-y-3">
        {features.map((feature, index) => (
          <li key={index} className="flex items-start gap-2">
            <CheckIcon className={theme.icon} />
            <span
              className={`text-sm text-slate-300 ${feature.bold ? "font-medium" : ""}`}
            >
              {feature.text}
            </span>
          </li>
        ))}
      </ul>

      <a
        href={ctaHref}
        className={`w-full rounded-md px-4 py-2.5 text-center font-medium transition-all ${
          highlighted
            ? `${theme.button}`
            : "border border-slate-600 bg-slate-700/50 text-slate-200 hover:border-slate-500 hover:bg-slate-700"
        }`}
      >
        {ctaText}
      </a>

      {footer && (
        <p className="mt-4 text-center text-xs text-slate-500">{footer}</p>
      )}
    </div>
  );
}

export function PricingGrid({ children }: { children: ReactNode }) {
  return <div className="mt-8 grid gap-6 md:grid-cols-2">{children}</div>;
}
