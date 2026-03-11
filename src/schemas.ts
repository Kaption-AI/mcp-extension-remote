/**
 * Zod schemas for API request validation.
 * Shared between API routes and unit tests.
 */

import { z } from "zod";

/** Phone number: digits only, 8-15 chars after normalization */
const phone = z
  .string()
  .min(1, "Phone number is required")
  .transform((v) => v.replace(/[\s\-\+\(\)]/g, ""))
  .pipe(z.string().regex(/^\d{8,15}$/, "Invalid phone number format"));

/** 6-digit OTP code */
const otpCode = z.string().regex(/^\d{6}$/, "Code must be 6 digits");

export const SendOTPSchema = z.object({
  phone,
  oauthReqInfo: z.string().optional(),
});

export const VerifyOTPSchema = z.object({
  phone,
  code: otpCode,
  oauthReqInfo: z.string().min(1, "Missing OAuth state"),
});

export const ExtSendOTPSchema = z.object({
  phone,
});

export const ExtVerifyOTPSchema = z.object({
  phone,
  code: otpCode,
});

export const RevokeSessionSchema = z.object({
  token: z.string().min(1, "Missing token"),
});

export const RegisterClientSchema = z.object({
  client_id: z.string().min(1, "Missing client_id"),
  client_name: z.string().optional(),
  redirect_uris: z
    .array(z.string().url("Each redirect_uri must be a valid URL"))
    .min(1, "At least one redirect_uri is required"),
});

/** [H4] Allowed redirect URI patterns for OAuth clients */
const ALLOWED_REDIRECT_PATTERNS = [
  /^https:\/\/([a-z0-9-]+\.)?claude\.ai(\/.*)?$/,
  /^http:\/\/localhost(:\d+)?(\/.*)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?(\/.*)?$/,
  /^https:\/\/([a-z0-9-]+\.)?cursor\.sh(\/.*)?$/,
  /^https:\/\/([a-z0-9-]+\.)?cursor\.com(\/.*)?$/,
  /^https:\/\/([a-z0-9-]+\.)?kaptionai\.com(\/.*)?$/,
  /^https:\/\/([a-z0-9-]+\.)?windsurf\.com(\/.*)?$/,
];

export function isAllowedRedirectUri(uri: string): boolean {
  return ALLOWED_REDIRECT_PATTERNS.some((pattern) => pattern.test(uri));
}
