import type { UserProfile } from "@/generated/prisma/client";
import type { ProfileFormValues } from "./components/profile-form";

export function toFormValues(name: string | null | undefined, p: UserProfile | null): ProfileFormValues {
  const sizes = (p?.sizes ?? {}) as ProfileFormValues["sizes"];
  return {
    name: name ?? "",
    age: p?.age ?? null,
    heightCm: p?.heightCm ?? null,
    presentation: p?.presentation ?? "",
    usualStyles: p?.usualStyles ?? [],
    exploreStyles: p?.exploreStyles ?? [],
    favoriteColors: p?.favoriteColors ?? [],
    avoidedColors: p?.avoidedColors ?? [],
    favoriteBrands: p?.favoriteBrands ?? [],
    budgetMin: p?.budgetMin ?? null,
    budgetMax: p?.budgetMax ?? null,
    sizes,
    fitPreference: p?.fitPreference ?? "",
    favoriteGarments: p?.favoriteGarments ?? [],
    home: p?.homeCity && p.homeLat != null && p.homeLon != null ? { name: p.homeCity, latitude: p.homeLat, longitude: p.homeLon } : null,
  };
}
