import type { HTMLAttributes } from "react";
import { cn } from "@/utils/cn";

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-card bg-linen p-6 shadow-soft", className)} {...rest} />;
}
