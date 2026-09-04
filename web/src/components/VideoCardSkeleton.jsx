export function VideoCardSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-soft)]">
      <div className="mb-3 flex gap-[3px]">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-1 flex-1 animate-pulse rounded-full bg-zinc-200" />
        ))}
      </div>
      <div className="flex gap-3.5">
        <div className="h-[68px] w-[120px] flex-shrink-0 animate-pulse rounded-lg bg-zinc-200" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-3 w-1/3 animate-pulse rounded bg-zinc-200" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-zinc-200" />
        </div>
      </div>
    </div>
  );
}
