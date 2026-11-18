import { profileRepository } from "@/repositories/profile.repository";
import type { ProfileInput } from "@/lib/validations/profile";

export const profileService = {
  get: (userId: string) => profileRepository.get(userId),
  save: (userId: string, input: ProfileInput) => profileRepository.upsert(userId, input),
};
