/** Native source unit: common/cHost.cpp (CxLogin.pdb: cHost.obj). */
import { cUnreliableQueueIn } from "./cUnreliableQueueIn.ts";

/** cHost — MTUDPBase's per-peer record.  The login server only exercises
 *  the unreliable-in queue (+120) and the unreliable-send counter (+12460);
 *  the rest of the original's ~12 KB (net clocks, reliable windows) never
 *  runs on this link. */
export class cHost {
  m_addrIp: number; // +4, host byte order (ntohl(sin_addr))
  m_nPort: number; // +8
  m_nUnreliableSendCount = 0; // +12460
  m_queueIn = new cUnreliableQueueIn(); // +120

  constructor(ip: number, port: number) {
    this.m_addrIp = ip;
    this.m_nPort = port;
  }
}
