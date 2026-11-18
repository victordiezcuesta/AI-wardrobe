import type { CategoryKey, ColorKey, SeasonKey, StatusKey } from "./constants";

export interface ItemDTO {
  id: string;
  name: string;
  category: CategoryKey;
  subcategory: string | null;
  description: string | null;
  primaryColor: ColorKey | null;
  secondaryColors: ColorKey[];
  pattern: string | null;
  material: string | null;
  style: string[];
  seasons: SeasonKey[];
  formality: number | null;
  occasions: string[];
  imageUrl: string | null;
  thumbUrl: string | null;
  needsReview: boolean;
  aiConfidence: number | null;
  isFavorite: boolean;
  status: StatusKey;
  createdAt: string;
}

export type UploadOutcomeDTO =
  | { status: "ok"; items: ItemDTO[] }
  | { status: "no_garment"; items: [] }
  | { status: "analysis_failed"; items: ItemDTO[]; reason: string };
