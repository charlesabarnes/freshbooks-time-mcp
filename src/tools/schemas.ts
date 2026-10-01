import { z } from 'zod';
import { PERIODS } from '../time/tz.js';

export const ref = (kind: string) =>
  z.union([z.string().min(1), z.number().int().positive()]).describe(`${kind} name or numeric id. Names match case-insensitively; partial names work when unambiguous.`);

export const timezone = z
  .string()
  .optional()
  .describe('IANA timezone used to interpret dates and times, e.g. America/New_York. Defaults to the server default.');

export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const timeString = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm (24h)');

export const period = z.enum(PERIODS as [string, ...string[]]);

export const rangeShape = {
  period: period.optional().describe('Named date range. Ignored when from/to are given.'),
  from: dateString.optional().describe('Start date (inclusive), YYYY-MM-DD, in the chosen timezone.'),
  to: dateString.optional().describe('End date (inclusive), YYYY-MM-DD, in the chosen timezone. Defaults to today.'),
  timezone,
};

export const duration = z
  .union([z.number().positive(), z.string().min(1)])
  .describe('Duration: hours as a number (1.5), "1:30", "1h30m", "90m" or "45 min".');
