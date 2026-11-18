import { Suspense } from "react";
import { TryOnStudio } from "@/features/virtual-try-on/components/tryon-studio";

export const metadata = { title: "Probador virtual" };

export default function TryOnPage() {
  return <div className="mx-auto max-w-6xl"><Suspense><TryOnStudio /></Suspense></div>;
}
