/** Port-only declaration module for Relay MTUDP constants recovered from CXRELAY.EXE. */
import { MTUDP_CRC_BYTES, MTUDP_LENGTH_BYTES, MTUDP_MAX_TOTAL_LENGTH } from "../shared/MTUDP.ts";

export const RELAY_SERIAL_BYTES = 4;
export const RELAY_ADDRESSING_BYTES = RELAY_SERIAL_BYTES * 2;
export const RELAY_SOURCE_SERIAL_OFFSET = MTUDP_LENGTH_BYTES;
export const RELAY_DESTINATION_SERIAL_OFFSET = RELAY_SOURCE_SERIAL_OFFSET + RELAY_SERIAL_BYTES;
export const RELAY_BODY_OFFSET = MTUDP_LENGTH_BYTES + RELAY_ADDRESSING_BYTES;

export const HOST_SWEEP_PERIOD = 0x1d4c0;
export const HOST_IDLE = 0xea60;
export const DISPATCH_BUFFER_MAX = 0x3e8000;
export const DISPATCH_REPORT_STRIDE = 0x1388;
export const MAX_FRAME_SIZE = MTUDP_MAX_TOTAL_LENGTH;
export const TIMER_TICK = 0x190;
export const TIMER_DATE_STRIDE = 750;
export const IDLE_SLEEP = 0x0a;
export const WEEK_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The complete frame limit includes its trailing CRC byte. */
export const RELAY_FRAME_CRC_BYTES = MTUDP_CRC_BYTES;
