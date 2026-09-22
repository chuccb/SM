/** GetTickCount — Center uses this Win32 API for its local elapsed-time
 * deadlines. The port maps it to the same monotonic uint32 process clock as
 * timeGetTime, not Date.now(). Neither absolute Windows boot uptime nor its
 * timer resolution/IOCP scheduling is emulated by this clock mapping. */
export { timeGetTime as GetTickCount } from "./timeGetTime.ts";
