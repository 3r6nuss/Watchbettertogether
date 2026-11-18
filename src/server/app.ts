import express from "express";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Server } from "socket.io";
import type { ZodType } from "zod";
import { endedSchema, joinSchema, playerCommandSchema, queueCommandSchema } from "../shared/protocol.js";
import type { ClientEvents, ServerEvents } from "../shared/protocol.js";
import { RoomError, Rooms } from "./rooms.js";
import { Store } from "./store.js";

class Limiter {
  private buckets = new Map<string, { count: number; until: number }>();
  take(key: string, limit: number, interval: number): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) {
      bucket = { count: 0, until: now + interval };
      this.buckets.set(key, bucket);
    }
    if (this.buckets.size > 2000) for (const [id, value] of this.buckets) if (value.until <= now) this.buckets.delete(id);
    return ++bucket.count <= limit;
  }
}

type ErrorAck = (reply: { ok: false; error: string }) => void;

export interface AppOptions {
  dbPath: string;
  origins: string[];
  maxRooms?: number;
  trustProxy?: number;
  clientDir?: string;
}

export function createApp(options: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy ?? 0);
  app.use((_req, res, next) => {
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  const http = createServer(app);
  const limiter = new Limiter();
  const originAllowed = (origin: string | undefined) => origin !== undefined && options.origins.includes(origin);
  const io = new Server<ClientEvents, ServerEvents>(http, {
    maxHttpBufferSize: 8192,
    cors: { origin: options.origins },
    allowRequest: (req, callback) => {
      // Same-origin polling GETs omit Origin; Fetch Metadata plus Host identifies them.
      const sameOriginPolling = req.headers.origin === undefined &&
        req.headers["sec-fetch-site"] === "same-origin" &&
        options.origins.some((origin) => new URL(origin).host === req.headers.host);
      const allowed = originAllowed(req.headers.origin) || sameOriginPolling;
      callback(allowed ? null : "Origin nicht erlaubt.", allowed);
    },
  });
  const store = new Store(options.dbPath);
  const rooms = new Rooms(store, (snapshot) => io.to(snapshot.roomId).emit("snapshot", snapshot), Date.now, options.maxRooms);

  app.get("/api/health", (_req, res) => {
    try {
      store.health();
      res.json({ ok: true });
    } catch (error) {
      console.error("Healthcheck fehlgeschlagen:", error);
      res.status(503).json({ ok: false });
    }
  });
  app.post("/api/rooms", (req, res) => {
    if (!originAllowed(req.headers.origin)) {
      res.status(403).json({ error: "Origin nicht erlaubt." });
      return;
    }
    if (!limiter.take(`create:${req.ip}`, 10, 60_000)) {
      res.status(429).json({ error: "Zu viele neue Raeume. Bitte eine Minute warten." });
      return;
    }
    try {
      res.status(201).json({ roomId: rooms.create() });
    } catch (error) {
      if (!(error instanceof RoomError)) console.error("Raumerstellung fehlgeschlagen:", error);
      res.status(error instanceof RoomError ? 429 : 500).json({
        error: error instanceof RoomError ? error.message : "Raumerstellung fehlgeschlagen.",
      });
    }
  });

  io.on("connection", (socket) => {
    let roomId: string | undefined;
    const hasAck = (ack: unknown) => {
      if (typeof ack === "function") return true;
      console.warn("Socket-Befehl ohne Bestaetigungsfunktion abgewiesen.");
      socket.disconnect(true);
      return false;
    };
    const failed = (error: unknown, ack: ErrorAck) => {
      if (!(error instanceof RoomError)) console.error("Socket-Befehl fehlgeschlagen:", error);
      ack({ ok: false, error: error instanceof RoomError ? error.message : "Serverfehler. Bitte erneut verbinden." });
      if (roomId && error instanceof RoomError) socket.emit("snapshot", rooms.snapshot(rooms.get(roomId)));
    };
    const checked = <T>(schema: ZodType<T>, value: unknown, ack: ErrorAck): T | undefined => {
      if (!limiter.take(`socket:${socket.id}`, 40, 10_000)) {
        ack({ ok: false, error: "Zu viele Befehle. Bitte kurz warten." });
        return;
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        ack({ ok: false, error: "Ungueltiger Befehl." });
        return;
      }
      return parsed.data;
    };
    const requireRoom = () => {
      if (!roomId) throw new RoomError("Bitte zuerst einem Raum beitreten.");
      return roomId;
    };
    socket.on("join", (payload, ack) => {
      if (!hasAck(ack)) return;
      const data = checked(joinSchema, payload, ack);
      if (!data) return;
      try {
        if (roomId) throw new RoomError("Du bist bereits einem Raum beigetreten.");
        if (!limiter.take(`join:${socket.handshake.address}`, 100, 60_000)) throw new RoomError("Zu viele Beitritte. Bitte kurz warten.");
        const result = rooms.join(data.roomId, socket.id, data.name, data.token);
        roomId = data.roomId;
        void socket.join(roomId);
        ack({ ok: true, data: result });
      } catch (error) { failed(error, ack); }
    });
    socket.on("player", (payload, ack) => {
      if (!hasAck(ack)) return;
      const data = checked(playerCommandSchema, payload, ack);
      if (!data) return;
      try { rooms.player(requireRoom(), socket.id, data, ack); }
      catch (error) { failed(error, ack); }
    });
    socket.on("queue", (payload, ack) => {
      if (!hasAck(ack)) return;
      const data = checked(queueCommandSchema, payload, ack);
      if (!data) return;
      try {
        rooms.queue(requireRoom(), socket.id, data);
        ack({ ok: true, data: undefined });
      } catch (error) { failed(error, ack); }
    });
    socket.on("ended", (payload, ack) => {
      if (!hasAck(ack)) return;
      const data = checked(endedSchema, payload, ack);
      if (!data) return;
      try {
        rooms.ended(requireRoom(), socket.id, data.instance, data.duration);
        ack({ ok: true, data: undefined });
      } catch (error) { failed(error, ack); }
    });
    socket.on("clock", (ack) => {
      if (!hasAck(ack)) return;
      if (!limiter.take(`clock:${socket.id}`, 30, 10_000)) {
        ack({ ok: false, error: "Zu viele Zeitabfragen." });
        return;
      }
      ack({ ok: true, data: Date.now() });
    });
    socket.on("leave", (ack) => {
      if (!hasAck(ack)) return;
      try {
        const id = requireRoom();
        rooms.disconnect(id, socket.id, true);
        void socket.leave(id);
        roomId = undefined;
        ack({ ok: true, data: undefined });
      } catch (error) { failed(error, ack); }
    });
    socket.on("disconnect", () => {
      if (!roomId) return;
      try { rooms.disconnect(roomId, socket.id); }
      catch (error) { console.error("Teilnehmerabmeldung fehlgeschlagen:", error); }
    });
  });

  const clientDir = options.clientDir ?? resolve("dist/client");
  app.use(express.static(clientDir, { index: false }));
  app.get(["/", "/room/:id"], (_req, res) => res.sendFile(resolve(clientDir, "index.html")));
  app.use((_req, res) => res.status(404).json({ error: "Nicht gefunden." }));

  return {
    http,
    rooms,
    async close() {
      await new Promise<void>((done) => io.close(() => done()));
      rooms.close();
      store.close();
    },
  };
}
