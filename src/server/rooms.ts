import { randomBytes, randomUUID } from "node:crypto";
import { parseYouTubeUrl, positionAt } from "../shared/protocol.js";
import type { Ack, Participant, Playback, PlayerCommand, QueueCommand, Snapshot } from "../shared/protocol.js";
import { Store, type StoredRoom } from "./store.js";

const EMPTY_TTL = 24 * 60 * 60 * 1000;
const RECONNECT_TTL = 60_000;
const DEFAULT_VIDEO_ID = "M7lc1UVf-VE";
const LEGACY_DEFAULT_VIDEO_ID = "y6120QOlsfU";
interface Member extends Participant { token: string; socketId: string | null; disconnectedAt: number | null }
interface Pending { command: PlayerCommand; socketId: string; rank: number; ack: Ack }
interface Room extends StoredRoom {
  members: Map<string, Member>;
  nextRank: number;
  pending: Pending[];
  timer?: ReturnType<typeof setTimeout>;
}
export class RoomError extends Error {}

export class Rooms {
  private rooms = new Map<string, Room>();
  private checkpointTimer: ReturnType<typeof setInterval>;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private store: Store,
    private broadcast: (snapshot: Snapshot) => void,
    private now: () => number = Date.now,
    private maxRooms = 100,
  ) {
    for (const saved of store.load()) {
      if (saved.emptySince !== null && this.now() - saved.emptySince >= EMPTY_TTL) {
        store.remove(saved.id);
        continue;
      }
      if (saved.playback) {
        if (saved.playback.entry.videoId === LEGACY_DEFAULT_VIDEO_ID && !saved.playback.playing &&
            saved.playback.position === 0 && saved.playback.rate === 1) {
          saved.playback.entry.videoId = DEFAULT_VIDEO_ID;
          saved.playback.instance = randomUUID();
        }
        saved.playback.playing = false;
        saved.playback.updatedAt = this.now();
      }
      const room = { ...saved, revision: saved.revision + 1, emptySince: saved.emptySince ?? this.now(),
        members: new Map<string, Member>(), nextRank: 1, pending: [] };
      store.save(room);
      this.rooms.set(saved.id, room);
    }
    this.checkpointTimer = setInterval(() => this.checkpoint(), 5000);
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.checkpointTimer.unref();
    this.cleanupTimer.unref();
  }

  create(): string {
    this.cleanup();
    if (this.rooms.size >= this.maxRooms) throw new RoomError("Das Raumlimit ist erreicht. Bitte spaeter erneut versuchen.");
    const id = randomBytes(24).toString("base64url");
    const now = this.now();
    const playback: Playback = { entry: { id: randomUUID(), videoId: DEFAULT_VIDEO_ID }, instance: randomUUID(),
      playing: false, rate: 1, position: 0, updatedAt: now };
    const room: Room = { id, revision: 0, playback, queue: [], emptySince: now,
      members: new Map(), nextRank: 1, pending: [] };
    this.store.save(room);
    this.rooms.set(id, room);
    return id;
  }

  get(id: string): Room {
    this.store.health();
    const room = this.rooms.get(id);
    if (!room || (room.emptySince !== null && this.now() - room.emptySince >= EMPTY_TTL)) {
      throw new RoomError("Der Raum existiert nicht mehr.");
    }
    return room;
  }

  snapshot(room: Room): Snapshot {
    return {
      roomId: room.id, revision: room.revision, serverTime: this.now(),
      playback: room.playback ? { ...room.playback, entry: { ...room.playback.entry } } : null,
      queue: room.queue.map((entry) => ({ ...entry })),
      participants: [...room.members.values()].filter((m) => m.socketId !== null)
        .sort((a, b) => a.rank - b.rank).map(({ id, name, rank }) => ({ id, name, rank })),
    };
  }

  join(id: string, socketId: string, name: string, token?: string) {
    const room = this.get(id);
    if ([...room.members.values()].filter((m) => m.socketId).length >= 5) {
      throw new RoomError("Dieser Raum hat bereits 5 Teilnehmer.");
    }
    let member = token ? room.members.get(token) : undefined;
    if (member?.socketId) throw new RoomError("Diese Teilnehmerkennung ist bereits verbunden.");
    if (!member || member.disconnectedAt === null || this.now() - member.disconnectedAt >= RECONNECT_TTL) {
      if (member) room.members.delete(member.token);
      member = { id: randomUUID(), token: randomBytes(32).toString("base64url"), name,
        rank: room.nextRank++, socketId, disconnectedAt: null };
      room.members.set(member.token, member);
    } else {
      member.socketId = socketId;
      member.disconnectedAt = null;
      member.name = name;
    }
    room.emptySince = null;
    this.changed(room);
    return { token: member.token, participantId: member.id, snapshot: this.snapshot(room) };
  }

  private member(room: Room, socketId: string): Member {
    const member = [...room.members.values()].find((m) => m.socketId === socketId);
    if (!member) throw new RoomError("Bitte dem Raum erneut beitreten.");
    return member;
  }

  disconnect(id: string, socketId: string, explicit = false): void {
    const room = this.get(id);
    const member = this.member(room, socketId);
    if (explicit) room.members.delete(member.token);
    else { member.socketId = null; member.disconnectedAt = this.now(); }
    if (![...room.members.values()].some((m) => m.socketId)) room.emptySince = this.now();
    this.changed(room);
  }

  queue(id: string, socketId: string, command: QueueCommand): void {
    const room = this.get(id);
    this.member(room, socketId);
    if (command.type === "add") {
      const videoId = parseYouTubeUrl(command.url);
      if (!videoId) throw new RoomError("Bitte einen gueltigen YouTube-Videolink eingeben (keine Playlist oder Livestream-URL).");
      if (room.queue.length >= 100) throw new RoomError("Die Warteschlange ist voll (maximal 100 Videos).");
      const entry = { id: randomUUID(), videoId };
      if (!room.playback) room.playback = { entry, instance: randomUUID(), playing: true, rate: 1, position: 0, updatedAt: this.now() };
      else room.queue.push(entry);
    } else {
      const index = room.queue.findIndex((entry) => entry.id === command.entryId);
      if (index === -1) throw new RoomError("Dieser Warteschlangeneintrag ist nicht mehr vorhanden.");
      if (command.type === "remove") room.queue.splice(index, 1);
      else {
        if (command.beforeId === command.entryId) return;
        if (command.beforeId !== null && !room.queue.some((entry) => entry.id === command.beforeId)) {
          throw new RoomError("Das Ziel wurde bereits entfernt. Bitte erneut versuchen.");
        }
        const [entry] = room.queue.splice(index, 1);
        const target = command.beforeId === null ? room.queue.length : room.queue.findIndex((item) => item.id === command.beforeId);
        room.queue.splice(target, 0, entry);
      }
    }
    this.changed(room);
  }

  player(id: string, socketId: string, command: PlayerCommand, ack: Ack): void {
    const room = this.get(id);
    const member = this.member(room, socketId);
    this.validatePlayer(room, command);
    room.pending.push({ command, socketId, rank: member.rank, ack });
    if (!room.timer) room.timer = setTimeout(() => this.flush(room), 100);
  }

  private validatePlayer(room: Room, command: PlayerCommand): void {
    if ((room.playback?.instance ?? null) !== command.instance) {
      throw new RoomError("Das Video wurde bereits gewechselt. Bitte erneut versuchen.");
    }
    if (command.type === "load") {
      if (!room.queue.some((entry) => entry.id === command.entryId)) throw new RoomError("Dieses Video ist nicht mehr in der Warteschlange.");
    } else if (!room.playback) throw new RoomError("Bitte zuerst ein Video hinzufuegen.");
  }

  private flush(room: Room): void {
    room.timer = undefined;
    const pending = room.pending.splice(0);
    const valid: Pending[] = [];
    for (const item of pending) {
      try {
        this.member(room, item.socketId);
        this.validatePlayer(room, item.command);
        valid.push(item);
      } catch (error) {
        if (!(error instanceof RoomError)) throw error;
        item.ack({ ok: false, error: error.message });
      }
    }
    if (!valid.length) return;
    const bestRank = Math.min(...valid.map((item) => item.rank));
    const winner = valid.filter((item) => item.rank === bestRank).at(-1)!;
    this.applyPlayer(room, winner.command);
    this.changed(room);
    for (const item of valid) {
      const equivalent = JSON.stringify(item.command) === JSON.stringify(winner.command);
      item.ack(item === winner || equivalent
        ? { ok: true, data: undefined }
        : { ok: false, error: "Gleichzeitige Steuerung: Der frueher beigetretene Teilnehmer hat Vorrang." });
    }
  }

  private applyPlayer(room: Room, command: PlayerCommand): void {
    if (command.type === "load") {
      const index = room.queue.findIndex((entry) => entry.id === command.entryId);
      const [entry] = room.queue.splice(index, 1);
      room.playback = { entry, instance: randomUUID(), playing: true, rate: 1, position: 0, updatedAt: this.now() };
    } else if (command.type === "next") this.next(room);
    else if (room.playback) {
      const now = this.now();
      room.playback.position = (command.type === "rate" ? undefined : command.position) ?? positionAt(room.playback, now);
      room.playback.updatedAt = now;
      if (command.type === "rate") room.playback.rate = command.rate;
      if (command.type === "play") room.playback.playing = true;
      if (command.type === "pause") room.playback.playing = false;
    }
  }

  private next(room: Room): void {
    const entry = room.queue.shift();
    room.playback = entry ? { entry, instance: randomUUID(), playing: true, rate: 1, position: 0, updatedAt: this.now() } : null;
  }

  ended(id: string, socketId: string, instance: string, duration: number): void {
    const room = this.get(id);
    this.member(room, socketId);
    const playback = room.playback;
    if (!playback || playback.instance !== instance) return;
    if (!playback.playing || positionAt(playback, this.now()) < duration - 1.5) {
      throw new RoomError("Das Videoende stimmt noch nicht mit der Raumposition ueberein.");
    }
    this.next(room);
    this.changed(room);
  }

  private saved(room: Room): StoredRoom {
    return { id: room.id, revision: room.revision, queue: room.queue, emptySince: room.emptySince,
      playback: room.playback ? { ...room.playback, position: positionAt(room.playback, this.now()), updatedAt: this.now() } : null };
  }

  private changed(room: Room): void {
    room.revision++;
    this.store.save(this.saved(room));
    this.broadcast(this.snapshot(room));
  }

  checkpoint(): void { for (const room of this.rooms.values()) this.store.save(this.saved(room)); }

  cleanup(): void {
    for (const room of this.rooms.values()) {
      for (const member of room.members.values()) {
        if (member.disconnectedAt !== null && this.now() - member.disconnectedAt >= RECONNECT_TTL) room.members.delete(member.token);
      }
      if (room.emptySince !== null && this.now() - room.emptySince >= EMPTY_TTL) {
        if (room.timer) clearTimeout(room.timer);
        for (const item of room.pending) item.ack({ ok: false, error: "Der Raum ist abgelaufen." });
        this.store.remove(room.id);
        this.rooms.delete(room.id);
      }
    }
  }

  close(): void {
    clearInterval(this.checkpointTimer);
    clearInterval(this.cleanupTimer);
    for (const room of this.rooms.values()) {
      if (room.timer) clearTimeout(room.timer);
      for (const item of room.pending.splice(0)) item.ack({ ok: false, error: "Der Server wird neu gestartet." });
    }
    this.checkpoint();
  }
}
