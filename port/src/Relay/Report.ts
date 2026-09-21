/** Port-only Bun console adapter for the native CMainWindow report sink. */
export function Report(message: string): void {
  console.log(`[Relay] ${message}`);
}

export function ReportError(message: string): void {
  console.error(`[Relay] ${message}`);
}
