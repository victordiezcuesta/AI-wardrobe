import { cn } from "@/utils/cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("rounded-card bg-[linear-gradient(110deg,var(--color-linen)_30%,var(--color-sand)_50%,var(--color-linen)_70%)] bg-[length:200%_100%] animate-[shimmer_1.6s_linear_infinite]", className)}
    />
  );
}
