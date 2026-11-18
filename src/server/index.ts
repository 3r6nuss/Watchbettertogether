import { resolve } from "node:path";
import { z } from "zod";
import { createApp } from "./app.js";

const config = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default("data/watchparty.sqlite"),
  APP_ORIGIN: z.string().optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  MAX_ROOMS: z.coerce.number().int().min(1).max(10000).default(100),
}).parse(process.env);
if (process.env.NODE_ENV === "production" && !config.APP_ORIGIN) {
  throw new Error("APP_ORIGIN muss im Produktivbetrieb gesetzt sein.");
}
const origins = config.APP_ORIGIN
  ? config.APP_ORIGIN.split(",").map((value) => {
    const url = new URL(value.trim());
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== value.trim()) {
      throw new Error("APP_ORIGIN muss aus Origins ohne Pfad bestehen.");
    }
    return url.origin;
  })
  : ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"];
const server = createApp({ dbPath: config.DATABASE_PATH === ":memory:" ? ":memory:" : resolve(config.DATABASE_PATH), origins,
  maxRooms: config.MAX_ROOMS, trustProxy: config.TRUST_PROXY });
server.http.listen(config.PORT, "0.0.0.0", () => console.log(`Watchbettertogether bereit auf Port ${config.PORT}.`));
server.http.on("error", (error) => { console.error("HTTP-Serverfehler:", error); process.exitCode = 1; });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => { console.error("Herunterfahren hat das Zeitlimit ueberschritten."); process.exit(1); }, 10_000);
  timeout.unref();
  await server.close();
  clearTimeout(timeout);
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
