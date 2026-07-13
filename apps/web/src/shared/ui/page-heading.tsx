import type { ReactNode } from "react";

export function PageHeading({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="text-[12px] font-semibold uppercase tracking-normal text-[color:var(--apple-blue)]">{eyebrow}</p> : null}
        <h1 className="mt-1 font-[family-name:var(--apple-font-display)] text-[36px] font-semibold leading-tight tracking-normal sm:text-[44px]">{title}</h1>
        {description ? <p className="mt-3 max-w-3xl text-[15px] leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}
