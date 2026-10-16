import { CServerConfig } from "./Common/CServerConfig.ts";
import { CServerApp } from "./CServerApp.ts";
import manifest from "./package.json";

export async function Main(
  args: readonly string[] = Bun.argv.slice(2),
): Promise<CServerApp> {
  if (Bun.version !== manifest.devDependencies.bun)
    throw new Error(
      `Expected Bun ${manifest.devDependencies.bun}; got ${Bun.version}`,
    );
  let path = "Config/Server.toml";
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--config" || !args[1])
      throw new Error("Usage: bun run Main.ts [--config Config/Server.toml]");
    path = args[1];
  }
  const app = new CServerApp(CServerConfig.Load(path));
  await app.SetUp();
  const shutdown = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    void app.CleanUp().catch(() => {
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Readiness is observable by other processes: install handlers before announcing it.
  console.warn(
    "INCOMPLETE PORT: battle, shop transactions, guild/utility and original Center TCP are NOT implemented. See docs/Coverage.md.",
  );
  console.log(JSON.stringify({ event: "server-started", ...app.GetStatus() }));
  return app;
}
if (import.meta.main) {
  try {
    await Main();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "startup-failed",
        reason:
          error instanceof Error ? error.message : "Unknown startup error",
      }),
    );
    process.exitCode = 1;
  }
}
