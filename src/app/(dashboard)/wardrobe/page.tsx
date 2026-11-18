import { WardrobeView } from "@/features/wardrobe/components/wardrobe-view";

export const metadata = { title: "Mi armario" };

export default function WardrobePage() {
  return <div className="mx-auto max-w-6xl"><WardrobeView /></div>;
}
