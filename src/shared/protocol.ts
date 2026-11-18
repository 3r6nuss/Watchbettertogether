import { z } from "zod";

export const roomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const idSchema = z.string().uuid();
export const joinSchema = z.object({
  roomId: roomIdSchema,
  name: z.string().trim().min(1).max(32),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
});
export const playerCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("play"), instance: idSchema, position: z.number().finite().min(0).max(86400).optional() }),
  z.object({ type: z.literal("pause"), instance: idSchema, position: z.number().finite().min(0).max(86400).optional() }),
  z.object({ type: z.literal("seek"), instance: idSchema, position: z.number().finite().min(0).max(86400) }),
  z.object({ type: z.literal("next"), instance: idSchema }),
  z.object({ type: z.literal("load"), entryId: idSchema, instance: idSchema.nullable() }),
]);
export const queueCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), url: z.string().trim().min(1).max(2048) }),
  z.object({ type: z.literal("remove"), entryId: idSchema }),
  z.object({ type: z.literal("move"), entryId: idSchema, beforeId: idSchema.nullable() }),
]);
export const endedSchema = z.object({
  instance: idSchema,
  duration: z.number().finite().positive().max(86400),
});

export type PlayerCommand = z.infer<typeof playerCommandSchema>;
export type QueueCommand = z.infer<typeof queueCommandSchema>;
export interface VideoEntry { id: string; videoId: string }
export interface Playback {
  entry: VideoEntry;
  instance: string;
  playing: boolean;
  position: number;
  updatedAt: number;
}
export interface Participant { id: string; name: string; rank: number }
export interface Snapshot {
  roomId: string;
  revision: number;
  serverTime: number;
  playback: Playback | null;
  queue: VideoEntry[];
  participants: Participant[];
}
export type Reply<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };
export type Ack<T = undefined> = (reply: Reply<T>) => void;
export interface ServerEvents { snapshot: (snapshot: Snapshot) => void }
export interface ClientEvents {
  join: (payload: z.infer<typeof joinSchema>, ack: Ack<{ token: string; participantId: string; snapshot: Snapshot }>) => void;
  player: (payload: PlayerCommand, ack: Ack) => void;
  queue: (payload: QueueCommand, ack: Ack) => void;
  ended: (payload: z.infer<typeof endedSchema>, ack: Ack) => void;
  clock: (ack: Ack<number>) => void;
  leave: (ack: Ack) => void;
}

export function positionAt(playback: Playback, serverTime: number): number {
  return playback.position + (playback.playing ? Math.max(0, serverTime - playback.updatedAt) / 1000 : 0);
}

export function parseYouTubeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1) id = parts[0];
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const match = /^\/(?:shorts|embed)\/([^/]+)\/?$/.exec(url.pathname);
      if (match) id = match[1];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}
