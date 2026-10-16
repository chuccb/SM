/** Logical lifetime kernel of FXGS CSafeObject: ctor 0042EB78, IsSetFree
 * 00408DE9, SetFree 0042EB8C. Native CUser constructs this base at +16, so
 * CUser+20 is its marked-for-free DWORD, NOT a local-player index.
 *
 * Bun uses one event-loop isolate here: mark-before-callback is synchronous and
 * reentrancy-safe, not an implementation of Win32 InterlockedExchange across
 * workers. Explicit owners + JS GC replace the native deferred deletion lists.
 * This is NOT the native collector or CUser's DB flush/unregister implementation.
 */
export class CSafeObject {
  private m_nSetFree = 0;
  IsSetFree(): number {
    return this.m_nSetFree;
  }
  SetFree(): number {
    if (this.m_nSetFree !== 0) return 0;
    this.m_nSetFree = 1;
    this.SafeFree();
    return 1;
  }
  /** Native virtual hook. Application owners explicitly remove their references;
   * no collection-list scheduling, persistence or service unregister is hidden
   * in this default hook. It deliberately does not pretend to flush user data. */
  protected SafeFree(): void {}
}
