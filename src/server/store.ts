import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Playback, VideoEntry } from "../shared/protocol.js";

export interface StoredRoom {
  id: string;
  revision: number;
  playback: Playback | null;
  queue: VideoEntry[];
  emptySince: number | null;
}
const entry = z.object({ id: z.string().uuid(), videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/) });
const roomSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  playback: z.object({
    entry,
    instance: z.string().uuid(),
    playing: z.boolean(),
    position: z.number().finite().nonnegative(),
    updatedAt: z.number().finite(),
  }).nullable(),
  queue: z.array(entry),
  emptySince: z.number().finite().nullable(),
});

export class Store {
  private db: DatabaseSync;
  private writeError: Error | null = null;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
    if (version === 0) {
      this.db.exec("BEGIN; CREATE TABLE rooms (id TEXT PRIMARY KEY, state TEXT NOT NULL); PRAGMA user_version = 1; COMMIT;");
    } else if (version !== 1) {
      throw new Error("Nicht unterstuetzte Datenbankversion.");
    }
  }

  load(): StoredRoom[] {
    return this.db.prepare("SELECT state FROM rooms").all().map((row) => {
      if (typeof row.state !== "string") throw new Error("Ungueltiger gespeicherter Raum.");
      return roomSchema.parse(JSON.parse(row.state));
    });
  }

  save(room: StoredRoom): void {
    this.write(() => {
      this.db.prepare("INSERT INTO rooms(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state")
        .run(room.id, JSON.stringify(room));
    });
  }

  private write(operation: () => void): void {
    this.health();
    try { operation(); }
    catch (error) {
      this.writeError = error instanceof Error ? error : new Error(String(error));
      throw this.writeError;
    }
  }

  remove(id: string): void { this.write(() => { this.db.prepare("DELETE FROM rooms WHERE id = ?").run(id); }); }
  health(): void {
    if (this.writeError) throw this.writeError;
    this.db.prepare("SELECT 1").get();
  }
  close(): void { this.db.close(); }
}
