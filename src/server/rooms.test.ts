import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Rooms } from "./rooms.js";
import { Store } from "./store.js";
import { positionAt, type PlayerCommand, type Reply } from "../shared/protocol.js";

const video = (id = "dQw4w9WgXcQ") => `https://www.youtube.com/watch?v=${id}`;
describe("autoritative Raeume", () => {
  let store: Store;
  let rooms: Rooms;
  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store(":memory:");
    rooms = new Rooms(store, () => {});
  });

  it("sperrt nach einem Datenbankschreibfehler weitere Writes und den Healthcheck", () => {
    const store = new Store(":memory:");
    const prepare = DatabaseSync.prototype.prepare;
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
      if (sql.startsWith("INSERT")) throw new Error("SQLITE_FULL: Testvolume voll");
      return prepare.call(this, sql);
    });
    try {
      expect(() => store.save({ id: "test", revision: 0, playback: null, queue: [], emptySince: 0 })).toThrow("SQLITE_FULL");
      spy.mockRestore();
      expect(() => store.health()).toThrow("SQLITE_FULL");
      expect(() => store.remove("test")).toThrow("SQLITE_FULL");
    } finally { spy.mockRestore(); store.close(); }
  });
  afterEach(() => { rooms.close(); store.close(); vi.useRealTimers(); });
  function setup() {
    const id = rooms.create();
    const first = rooms.join(id, "first", "Erste");
    rooms.join(id, "second", "Zweite");
    const instance = rooms.snapshot(rooms.get(id)).playback!.instance;
    command(id, "first", { type: "play", instance });
    vi.advanceTimersByTime(100);
    return { id, first, instance };
  }
  function command(id: string, socket: string, payload: PlayerCommand) {
    const results: Reply[] = [];
    rooms.player(id, socket, payload, (result) => results.push(result));
    return results;
  }

  it("laedt das Standardvideo pausiert, bis jemand es startet oder ein Queue-Video waehlt", () => {
    const id = rooms.create();
    rooms.join(id, "first", "Erste");
    const snapshot = () => rooms.snapshot(rooms.get(id));
    vi.advanceTimersByTime(5000);
    expect(snapshot().playback).toMatchObject({ entry: { videoId: "M7lc1UVf-VE" }, playing: false, position: 0 });
    expect(positionAt(snapshot().playback!, Date.now())).toBe(0);
    rooms.queue(id, "first", { type: "add", url: video() });
    expect(snapshot().playback?.playing).toBe(false);
    expect(snapshot().queue).toMatchObject([{ videoId: "dQw4w9WgXcQ" }]);
  });

  it("ersetzt beim Neustart das blockierte Startvideo bei 0:00, ohne die Queue oder laufende Videos zu aendern", () => {
    const pausedId = rooms.create();
    const playedId = rooms.create();
    rooms.join(pausedId, "first", "Gast");
    rooms.queue(pausedId, "first", { type: "add", url: video() });
    rooms.close();
    const saved = store.load();
    const paused = saved.find((room) => room.id === pausedId)!;
    const played = saved.find((room) => room.id === playedId)!;
    const previousInstance = paused.playback!.instance;
    paused.playback!.entry.videoId = "y6120QOlsfU";
    played.playback!.entry.videoId = "y6120QOlsfU";
    played.playback!.position = 12;
    store.save(paused);
    store.save(played);
    rooms = new Rooms(store, () => {});
    const restored = rooms.snapshot(rooms.get(pausedId));
    expect(restored.playback).toMatchObject({ entry: { videoId: "M7lc1UVf-VE" }, playing: false, position: 0 });
    expect(restored.playback?.instance).not.toBe(previousInstance);
    expect(restored.queue).toEqual(paused.queue);
    expect(rooms.snapshot(rooms.get(playedId)).playback).toMatchObject({ entry: { videoId: "y6120QOlsfU" }, position: 12 });
    expect(store.load().find((room) => room.id === pausedId)?.playback).toEqual(restored.playback);
  });

  it("priorisiert Join-Rang trotz umgekehrter Eingangsreihenfolge und erlaubt spaetere Alleinsteuerung", () => {
    const { id, instance } = setup();
    expect(rooms.snapshot(rooms.get(id)).playback).toMatchObject({ playing: true, position: 0 });
    const second = command(id, "second", { type: "play", instance });
    vi.advanceTimersByTime(20);
    const first = command(id, "first", { type: "pause", instance });
    vi.advanceTimersByTime(80);
    expect(first[0].ok).toBe(true);
    expect(second[0].ok).toBe(false);
    expect(rooms.snapshot(rooms.get(id)).playback!.playing).toBe(false);
    const later = command(id, "second", { type: "play", instance });
    vi.advanceTimersByTime(100);
    expect(later[0].ok).toBe(true);
    expect(rooms.snapshot(rooms.get(id)).playback!.playing).toBe(true);
  });

  it("haelt Konfliktfenster fest, nimmt den letzten Befehl des Gewinners und verwirft getrennte Teilnehmer", () => {
    const { id, instance } = setup();
    command(id, "first", { type: "play", instance });
    vi.advanceTimersByTime(90);
    const last = command(id, "first", { type: "seek", instance, position: 15 });
    const second = command(id, "second", { type: "play", instance });
    rooms.disconnect(id, "second");
    vi.advanceTimersByTime(10);
    expect(last[0].ok).toBe(true);
    expect(second[0].ok).toBe(false);
    expect(rooms.snapshot(rooms.get(id)).playback!.position).toBe(15);
  });

  it("uebernimmt native Wiedergabe und Position atomar im Konfliktfenster", () => {
    const { id, instance } = setup();
    command(id, "second", { type: "play", instance, position: 45 });
    vi.advanceTimersByTime(100);
    expect(rooms.snapshot(rooms.get(id)).playback).toMatchObject({ playing: true, position: 45 });
    vi.advanceTimersByTime(1000);
    const loser = command(id, "second", { type: "play", instance, position: 70 });
    command(id, "first", { type: "pause", instance, position: 15 });
    vi.advanceTimersByTime(100);
    expect(loser[0].ok).toBe(false);
    expect(rooms.snapshot(rooms.get(id)).playback).toMatchObject({ playing: false, position: 15 });
  });

  it("verankert Tempowechsel ohne Positionssprung und startet das naechste Video mit 1x", () => {
    const { id, instance } = setup();
    vi.advanceTimersByTime(900);
    const rate = command(id, "second", { type: "rate", instance, rate: 2 });
    vi.advanceTimersByTime(100);
    expect(rate[0].ok).toBe(true);
    const playback = () => rooms.snapshot(rooms.get(id)).playback!;
    expect(playback()).toMatchObject({ rate: 2, position: 1 });
    vi.advanceTimersByTime(2000);
    expect(positionAt(playback(), Date.now())).toBe(5);
    rooms.queue(id, "first", { type: "add", url: video("aqz-KE-bpKQ") });
    rooms.ended(id, "first", instance, 6);
    expect(playback()).toMatchObject({ rate: 1, position: 0 });
  });

  it("erhaelt Rang beim kurzen Reconnect, aber nicht nach Ablauf oder bewusstem Verlassen", () => {
    const { id, first } = setup();
    rooms.disconnect(id, "first");
    vi.advanceTimersByTime(59_000);
    const back = rooms.join(id, "back", "Erste", first.token);
    expect(back.participantId).toBe(first.participantId);
    expect(back.snapshot.participants[0].rank).toBe(1);
    rooms.disconnect(id, "back");
    vi.advanceTimersByTime(60_000);
    const late = rooms.join(id, "late", "Erste", back.token);
    expect(late.participantId).not.toBe(first.participantId);
    expect(late.snapshot.participants.find((m) => m.id === late.participantId)!.rank).toBe(3);
    rooms.disconnect(id, "late", true);
    const fresh = rooms.join(id, "fresh", "Erste", late.token);
    expect(fresh.snapshot.participants.find((m) => m.id === fresh.participantId)!.rank).toBe(4);
  });

  it("verarbeitet Queue-Aenderungen mit stabilen IDs und weist entfernte Ziele sichtbar ab", () => {
    const { id } = setup();
    rooms.queue(id, "first", { type: "add", url: video("aqz-KE-bpKQ") });
    rooms.queue(id, "second", { type: "add", url: video("M7lc1UVf-VE") });
    const [a, b] = rooms.snapshot(rooms.get(id)).queue;
    rooms.queue(id, "first", { type: "move", entryId: b.id, beforeId: a.id });
    rooms.queue(id, "second", { type: "remove", entryId: a.id });
    expect(rooms.snapshot(rooms.get(id)).queue.map((item) => item.id)).toEqual([b.id]);
    expect(() => rooms.queue(id, "first", { type: "move", entryId: b.id, beforeId: a.id })).toThrow("Ziel wurde");
    expect(rooms.snapshot(rooms.get(id)).queue.map((item) => item.id)).toEqual([b.id]);
  });

  it("wechselt trotz mehrerer Endmeldungen und wartendem Next nur einmal", () => {
    const { id, instance } = setup();
    rooms.queue(id, "first", { type: "add", url: video("aqz-KE-bpKQ") });
    rooms.queue(id, "first", { type: "add", url: video("M7lc1UVf-VE") });
    command(id, "first", { type: "play", instance });
    vi.advanceTimersByTime(100);
    expect(() => rooms.ended(id, "second", instance, 10)).toThrow("Videoende");
    vi.advanceTimersByTime(10_000);
    const pending = command(id, "first", { type: "next", instance });
    rooms.ended(id, "second", instance, 10);
    rooms.ended(id, "first", instance, 10);
    vi.advanceTimersByTime(100);
    expect(pending[0].ok).toBe(false);
    const state = rooms.snapshot(rooms.get(id));
    expect(state.playback!.entry.videoId).toBe("aqz-KE-bpKQ");
    expect(state.queue).toHaveLength(1);
    expect(() => rooms.player(id, "first", { type: "seek", instance, position: 1 }, () => {})).toThrow("Video wurde");
  });

  it("isoliert Raeume und begrenzt die Teilnehmerzahl", () => {
    const { id } = setup();
    const other = rooms.create();
    expect(() => rooms.queue(other, "first", { type: "add", url: video() })).toThrow("erneut beitreten");
    for (let i = 0; i < 3; i++) rooms.join(id, `more${i}`, "Gast");
    expect(() => rooms.join(id, "sixth", "Gast")).toThrow("5 Teilnehmer");
    expect(rooms.snapshot(rooms.get(other)).playback).toMatchObject({ playing: false, position: 0 });
  });

  it("stellt gespeicherte Raeume pausiert wieder her und laesst Leerstand ueber Neustarts ablaufen", () => {
    const directory = mkdtempSync(join(tmpdir(), "wbt-storage-"));
    const path = join(directory, "rooms.sqlite");
    const disk = new Store(path);
    const original = new Rooms(disk, () => {});
    const id = original.create();
    original.join(id, "first", "Gast");
    const instance = original.snapshot(original.get(id)).playback!.instance;
    original.player(id, "first", { type: "play", instance }, () => {});
    vi.advanceTimersByTime(100);
    original.queue(id, "first", { type: "add", url: video("aqz-KE-bpKQ") });
    vi.advanceTimersByTime(5000);
    original.disconnect(id, "first");
    original.close();
    disk.close();
    vi.advanceTimersByTime(1000);
    const reopened = new Store(path);
    const restored = new Rooms(reopened, () => {});
    const state = restored.snapshot(restored.get(id));
    expect(state.playback!.playing).toBe(false);
    expect(state.playback!.position).toBeCloseTo(5);
    expect(state.queue).toHaveLength(1);
    restored.close();
    reopened.close();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    const finalStore = new Store(path);
    const finalRooms = new Rooms(finalStore, () => {});
    expect(() => finalRooms.get(id)).toThrow("existiert");
    expect(finalStore.load()).toEqual([]);
    finalRooms.close();
    finalStore.close();
    rmSync(directory, { recursive: true });
  });
});
