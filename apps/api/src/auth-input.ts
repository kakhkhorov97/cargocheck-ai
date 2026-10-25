import { z } from "zod";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const emailInput = z
  .string()
  .trim()
  .pipe(z.email().max(254))
  .transform(normalizeEmail);
