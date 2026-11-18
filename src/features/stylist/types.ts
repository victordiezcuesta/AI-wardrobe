export interface OutfitItemDTO {
  id: string;
  itemId: string;
  alternatives: string[];
  item: { id: string; name: string; category: string; thumbUrl: string | null; primaryColor: string | null; status: string };
}
export interface OutfitDTO {
  id: string;
  name: string;
  description: string;
  occasion: string | null;
  reasoning: string | null;
  colorNotes: string | null;
  weatherNotes: string | null;
  styleFit: string | null;
  location: string | null;
  isFavorite: boolean;
  discarded: boolean;
  rating: number | null;
  createdAt: string;
  items: OutfitItemDTO[];
}
export interface LiteItemDTO { id: string; name: string; category: string; thumbUrl: string | null; primaryColor: string | null }
export type AlternativeItems = Record<string, LiteItemDTO>;

export interface WeatherDTO {
  date: string;
  daily: { tMin: number | null; tMax: number | null; apparentMin: number | null; apparentMax: number | null; precipProbMax: number | null; windMax: number | null; description: string };
}
export interface PlaceDTO { name: string; latitude: number; longitude: number }
export interface CityDTO { name: string; region: string | null; country: string | null; latitude: number; longitude: number }
