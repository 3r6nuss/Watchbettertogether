import { describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { createApp } from "./app.js";
import type { ClientEvents, ServerEvents, Snapshot } from "../shared/protocol.js";

const origin = "http://watchparty.test";
describe("HTTP und Socket.IO", () => {
  it("prueft Origins, verteilt verbindliche Snapshots und stellt Reconnect-Rang wieder her", async () => {
    const app = createApp({ dbPath: ":memory:", origins: [origin] });
    await new Promise<void>((resolve) => app.http.listen(0, "127.0.0.1", resolve));
    const address = app.http.address();
    if (!address || typeof address === "string") throw new Error("Testserveradresse fehlt.");
    const base = `http://127.0.0.1:${address.port}`;
    const sockets: Socket<ServerEvents, ClientEvents>[] = [];
    const connect = async () => {
      const socket: Socket<ServerEvents, ClientEvents> = io(base, {
        transports: ["websocket"], extraHeaders: { Origin: origin }, reconnection: false,
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", reject);
      });
      return socket;
    };
    try {
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
      expect((await fetch(`${base}/api/rooms`, { method: "POST", headers: { Origin: "http://other.test" } })).status).toBe(403);
      const created = await fetch(`${base}/api/rooms`, { method: "POST", headers: { Origin: origin } });
      expect(created.status).toBe(201);
      const body: unknown = await created.json();
      if (typeof body !== "object" || body === null || !("roomId" in body) || typeof body.roomId !== "string") throw new Error("Raum fehlt.");
      const roomId = body.roomId;
      const a = await connect();
      const b = await connect();
      const joinedA = await a.timeout(1000).emitWithAck("join", { roomId, name: "Anna" });
      expect(joinedA.ok).toBe(true);
      if (!joinedA.ok) throw new Error(joinedA.error);
      const joinedB = await b.timeout(1000).emitWithAck("join", { roomId, name: "Ben" });
      expect(joinedB.ok).toBe(true);
      const states: Snapshot[] = [];
      b.on("snapshot", (snapshot) => states.push(snapshot));
      expect((await a.timeout(1000).emitWithAck("queue", { type: "add", url: "https://youtu.be/dQw4w9WgXcQ" })).ok).toBe(true);
      await expect.poll(() => states.length).toBeGreaterThan(0);
      const instance = states.at(-1)!.playback!.instance;
      const play = b.timeout(1000).emitWithAck("player", { type: "play", instance });
      const pause = a.timeout(1000).emitWithAck("player", { type: "pause", instance });
      expect((await pause).ok).toBe(true);
      expect((await play).ok).toBe(false);
      await expect.poll(() => states.at(-1)!.playback!.playing).toBe(false);
      a.disconnect();
      await expect.poll(() => states.at(-1)!.participants.length).toBe(1);
      const back = await connect();
      const rejoined = await back.timeout(1000).emitWithAck("join", { roomId, name: "Anna", token: joinedA.data.token });
      if (!rejoined.ok) throw new Error(rejoined.error);
      expect(rejoined.data.participantId).toBe(joinedA.data.participantId);
      expect(rejoined.data.snapshot.participants[0].rank).toBe(1);
      const clock = await back.timeout(1000).emitWithAck("clock");
      if (!clock.ok) throw new Error(clock.error);
      expect(Math.abs(clock.data - Date.now())).toBeLessThan(1000);
    } finally {
      for (const socket of sockets) socket.disconnect();
      await app.close();
    }
  });
});
