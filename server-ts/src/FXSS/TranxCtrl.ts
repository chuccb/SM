/** Native source unit: FX/FxShop/TranxCtrl.cpp. */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** CMainPool::OnRequestTranxData's stack buffer and native GetData count. */
export const TRANSACTION_PAGE_BYTES = 500;

const TRANSACTION_LOG_DIRECTORY = "Log";
const TRANSACTION_LOG_PREFIX = "TranxLog_";
const TRANSACTION_LOG_EXTENSION = ".txt";
const TRANSACTION_FORMAT_LINE_ENDING = "\r\n";
const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;
const TEXT_END_OF_FILE = 0x1a;

/** MSVC's text-mode `_write` prefixes every LF with CR. */
function translateWindowsTextWrite(text: string): string {
  return text.replaceAll("\n", "\r\n");
}

/** MSVC's text-mode `_read` folds CRLF and treats Ctrl+Z as end of file. */
function translateWindowsTextRead(diskBytes: Uint8Array): Uint8Array {
  const textBytes = new Uint8Array(diskBytes.length);
  let length = 0;

  for (let index = 0; index < diskBytes.length; index++) {
    const byte = diskBytes[index]!;
    if (byte === TEXT_END_OF_FILE) break;

    if (byte === CARRIAGE_RETURN && diskBytes[index + 1] === LINE_FEED) {
      textBytes[length++] = LINE_FEED;
      index++;
    } else {
      textBytes[length++] = byte;
    }
  }

  return textBytes.subarray(0, length);
}

/** Native Transaction fields emitted by CTranxCtrl::AddTranx.
 * `kind` is 0 for a normal purchase and 1 for a present/gift transaction.
 */
export interface Transaction {
  readonly kind: number;
  readonly stockSN: number;
  readonly itemSN: number;
  readonly amount: number;
  readonly price: number;
}

export interface TransactionPage {
  readonly length: number;
  readonly nextOffset: number;
}

function decimal(value: number): string {
  return (value | 0).toString(10);
}

function dateKey(year: number, month: number, day: number): string {
  return `${decimal(year).padStart(4, "0")}${decimal(month).padStart(2, "0")}${decimal(day).padStart(2, "0")}`;
}

/** CTranxCtrl — the durable purchase-receipt log. */
export class CTranxCtrl {
  static ms_pInstance: CTranxCtrl | null = null;

  private currentDay = 0;
  private currentPath = "";

  constructor(
    private readonly logDirectory = join(process.cwd(), TRANSACTION_LOG_DIRECTORY),
    private readonly now: () => Date = () => new Date(),
  ) {
    CTranxCtrl.ms_pInstance = this;
  }

  /** CTranxCtrl::Init → CreateNewLog. */
  Init(): number {
    this.CreateNewLog();
    return 1;
  }

  private Path(year: number, month: number, day: number): string {
    return join(this.logDirectory, `${TRANSACTION_LOG_PREFIX}${dateKey(year, month, day)}${TRANSACTION_LOG_EXTENSION}`);
  }

  /** CTranxCtrl::CreateNewLog — select today's Log/TranxLog_YYYYMMDD.txt and open a+. */
  CreateNewLog(): void {
    const now = this.now();
    mkdirSync(this.logDirectory, { recursive: true });
    this.currentPath = this.Path(now.getFullYear(), now.getMonth() + 1, now.getDate());
    closeSync(openSync(this.currentPath, "a+"));
    // The native object stores only SYSTEMTIME.wDay and compares that in AddTranx.
    this.currentDay = now.getDate();
  }

  /** Append and synchronously flush one native ASCII line through MSVC text-mode translation. */
  AddTranx(transaction: Transaction): number {
    const now = this.now();
    if (now.getDate() !== this.currentDay) this.CreateNewLog();
    const line = [
      `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`,
      decimal(transaction.kind),
      decimal(transaction.stockSN),
      decimal(transaction.itemSN),
      decimal(transaction.amount),
      decimal(transaction.price),
    ].join(",") + TRANSACTION_FORMAT_LINE_ENDING;
    appendFileSync(this.currentPath, translateWindowsTextWrite(line), { encoding: "ascii", flush: true });
    return 1;
  }

  /** CTranxCtrl::GetData — date-addressed, byte-offset pagination.
   * Missing files preserve the request cursor. EOF resets it to zero. Native
   * out-of-range cursors lead to an invalid memcpy; the port safely returns EOF.
   */
  GetData(year: number, month: number, day: number, destination: Uint8Array, offset: number): TransactionPage {
    const path = this.Path(year, month, day);
    if (!existsSync(path)) return { length: 0, nextOffset: offset >>> 0 };

    const source = translateWindowsTextRead(readFileSync(path));
    const start = offset >>> 0;
    if (start > source.length) return { length: 0, nextOffset: 0 };

    const count = Math.min(destination.length, TRANSACTION_PAGE_BYTES);
    const length = Math.min(count, source.length - start);
    destination.set(source.subarray(start, start + length));
    return {
      length,
      nextOffset: start + count >= source.length ? 0 : start + count,
    };
  }
}
