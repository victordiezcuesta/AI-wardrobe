export type JobStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
export interface TryOnDTO {
  id: string; status: JobStatus; scenario: string; pose: string; outfitId: string | null;
  errorMessage: string | null; attempts: number; isFavorite: boolean; createdAt: string; updatedAt: string;
  imageUrl: string | null; downloadUrl: string | null;
}
export interface PhotoDTO { publicId: string; url: string }
export interface ConsentDTO { granted: boolean; at: string | null; version: string }
