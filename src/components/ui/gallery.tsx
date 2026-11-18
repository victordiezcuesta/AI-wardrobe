import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

/** Rejilla tipo "masonry" por columnas: las fotos mandan, la altura natural se respeta. */
export function Gallery({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("columns-2 gap-4 sm:columns-3 lg:columns-4 [&>*]:mb-4 [&>*]:break-inside-avoid", className)}>{children}</div>;
}
