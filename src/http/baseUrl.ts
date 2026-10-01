import type { Request } from 'express';

export function baseUrlFor(req: Request, publicUrl: string | undefined): string {
  if (publicUrl) return publicUrl;
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol;
  const host = forwardedHost || req.get('host') || 'localhost';
  return `${proto}://${host}`;
}

export const FRESHBOOKS_CALLBACK_PATH = '/oauth/callback';

export const freshbooksRedirectUri = (baseUrl: string): string => `${baseUrl}${FRESHBOOKS_CALLBACK_PATH}`;
