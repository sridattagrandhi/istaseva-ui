import { z } from 'zod';

export const updateUserProfileSchema = z.object({
  display_name: z.string().min(1).max(120).optional(),
  // null clears the photo (Remove photo on the profile page).
  avatar_url: z.string().url().max(2048).nullable().optional(),
  bio: z.string().max(1000).optional(),
  phone: z.string().min(7).max(30).optional(),
  location: z.string().max(255).optional(),
  preferred_language: z.string().min(2).max(50).optional(),
}).strict();

export type UpdateUserProfileInput = z.infer<typeof updateUserProfileSchema>;
