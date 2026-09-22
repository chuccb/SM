/** Independent SQLite process for registration contention tests; no listeners. */
import { CDBMan, EncodePassword, GetUserHashNo } from "../../src/db/DBMan.ts";

export type RegistrationCommand =
  | { kind: "create" | "authenticate"; accounts: { id: string; password: string }[] }
  | { kind: "hold"; id: string; releaseAfterMs?: number; createWhileLocked?: boolean }
  | { kind: "release" }
  | { kind: "quit" };

export type RegistrationReply =
  | { kind: "ready" | "locked" | "released" }
  | { kind: "result"; results: number[] }
  | { kind: "error"; error: string };

if (import.meta.main) {
  const db = new CDBMan(process.argv[2]!);
  let locked: (typeof db.userInfo)[number] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = (message: RegistrationReply) => process.send!(message);
  const release = () => {
    clearTimeout(timer);
    locked?.exec("COMMIT");
    locked = undefined;
    send({ kind: "released" });
  };
  process.on("message", (message: RegistrationCommand) => {
    try {
      switch (message.kind) {
        case "create":
        case "authenticate": {
          const results = message.accounts.map(({ id, password }) => {
            const encoded = EncodePassword(password);
            return message.kind === "authenticate"
              ? db.prCAAuthUser(id, encoded).retval
              : db.prCreateUser(id, id, encoded, "", 0, 0, "", "", 0, "", "", "", "", "");
          });
          send({ kind: "result", results });
          break;
        }
        case "hold": {
          locked = db.userInfo[GetUserHashNo(message.id)]!;
          locked.exec("BEGIN IMMEDIATE");
          if (message.createWhileLocked) {
            const result = db.prCreateUser(message.id, message.id, "fixture", "", 0, 0, "", "", 0, "", "", "", "", "");
            if (result !== 0) throw new Error("Could not stage lock-holder account");
          }
          send({ kind: "locked" });
          if (message.releaseAfterMs !== undefined) timer = setTimeout(release, message.releaseAfterMs);
          break;
        }
        case "release":
          release();
          break;
        case "quit":
          clearTimeout(timer);
          if (locked?.inTransaction) locked.exec("ROLLBACK");
          for (const connection of [...db.userInfo, ...db.inventory, db.config, db.item, db.guild]) connection.close();
          process.exit(0);
      }
    } catch (error) {
      send({ kind: "error", error: String(error) });
    }
  });
  send({ kind: "ready" });
}
