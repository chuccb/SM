/** Match SQLite NOCASE and original ANSI account-ID ASCII normalization.
 * Do not apply Unicode toLowerCase(): it folds IDs SQLite treats as different. */
export function NormalizeID(id: string): string {
  return id.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
