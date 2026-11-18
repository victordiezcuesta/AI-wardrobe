import { POSES, SCENARIOS, type PoseKey, type ScenarioKey } from "@/features/virtual-try-on/constants";
import { CATEGORY_LABELS, type CategoryKey } from "@/features/wardrobe/constants";

export interface PromptItem { id: string; name: string; category: CategoryKey; color: string | null; hasImage: boolean }

// Las prendas con más peso visual se llevan primero las referencias limitadas del proveedor.
const PRIORITY: CategoryKey[] = ["DRESS", "TSHIRT", "SHIRT", "HOODIE", "SWEATER", "TROUSERS", "JEANS", "SHORTS", "SKIRT", "JACKET", "COAT", "SHOES", "SNEAKERS", "BOOTS", "BAG", "ACCESSORY", "OTHER"];

/** Elige qué prendas viajan como imagen de referencia (la imagen 1 siempre es la persona). */
export function pickReferences(items: PromptItem[], maxTotalImages: number): PromptItem[] {
  return items
    .filter((i) => i.hasImage)
    .sort((a, b) => PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category))
    .slice(0, Math.max(0, maxTotalImages - 1));
}

export function buildTryOnPrompt(items: PromptItem[], referenced: PromptItem[], scenario: ScenarioKey, pose: PoseKey): string {
  const label = (i: PromptItem) => `${i.name} (${CATEGORY_LABELS[i.category].toLowerCase()}${i.color ? `, ${i.color}` : ""})`;
  const refLines = referenced.map((i, idx) => `- Image ${idx + 2}: ${label(i)}`);
  const refIds = new Set(referenced.map((i) => i.id));
  const textOnly = items.filter((i) => !refIds.has(i.id)).map(label);
  const sc = SCENARIOS.find((s) => s.value === scenario)!;
  const po = POSES.find((p) => p.value === pose)!;

  return [
    "Photorealistic fashion photograph of a real person.",
    "Image 1 is the identity reference: keep this exact person — same face, facial features, hair, skin tone, apparent age, body shape and proportions. Do not alter the face.",
    refLines.length ? `Dress the person in the garments shown in the other reference images, reproducing each one's colour, cut, pattern and material faithfully:\n${refLines.join("\n")}` : "",
    textOnly.length ? `Also include these pieces (no photo available, follow the description): ${textOnly.join("; ")}.` : "",
    `Scene: ${sc.prompt}. Pose: ${po.prompt}.`,
    "Natural realistic lighting, sharp focus, realistic fabric drape and fit, entire outfit visible. No text, logos, watermarks or extra people.",
  ].filter(Boolean).join("\n");
}
