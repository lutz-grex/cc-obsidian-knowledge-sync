/**
 * Shared utility functions used across the codebase.
 */

/** Escape special regex characters in a string. */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escape special replacement-string characters ($&, $1, etc.) for use in String.replace(). */
export function escapeReplacement(str: string): string {
  return str.replace(/\$/g, "$$$$");
}

/** Get local date as YYYY-MM-DD. */
export function localDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Get local time as HH:MM. */
export function localTime(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${min}`;
}

/** Format a date using simple token substitution (YYYY, MM, DD). */
export function formatDate(date: Date, format: string): string {
  return format
    .replace("YYYY", String(date.getFullYear()))
    .replace("MM", String(date.getMonth() + 1).padStart(2, "0"))
    .replace("DD", String(date.getDate()).padStart(2, "0"));
}

/** Parse a strict YYYY-MM-DD string into a Date (local midnight). Throws on invalid format. */
export function parseDateString(s: string): Date {
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid date format (expected YYYY-MM-DD): ${s}`);
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid date value: ${s}`);
  }
  const date = new Date(year, month - 1, day);
  // Reject impossible dates like Feb 31 (Date constructor silently rolls over)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`Invalid date (day out of range for month): ${s}`);
  }
  return date;
}

/** Validate a git author string: must be non-empty, no control chars, no angle brackets. */
export function validateAuthor(author: string): string | null {
  if (!author || author.trim().length === 0) return "Author must not be empty";
  if (/[\x00-\x1f<>]/.test(author)) return "Author contains invalid characters";
  if (author.length > 128) return "Author exceeds 128 characters";
  return null;
}
