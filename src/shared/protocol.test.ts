import { describe, expect, it } from "vitest";
import { parseYouTubeUrl, playerCommandSchema } from "./protocol.js";

describe("YouTube-Linkvalidierung", () => {
  it("akzeptiert normale Watch-, Kurz-, Shorts- und Embed-Links", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://m.youtube.com/shorts/dQw4w9WgXcQ",
      "https://youtube.com/embed/dQw4w9WgXcQ",
    ]) expect(parseYouTubeUrl(url)).toBe("dQw4w9WgXcQ");
  });
  it("lehnt fremde Hosts, Credentials, Ports, Livestream-URLs und Playlists ab", () => {
    for (const url of [
      "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ",
      "https://name:password@youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com:8443/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/live/dQw4w9WgXcQ",
      "https://youtube.com/playlist?list=abc",
      "javascript:alert(1)",
      "https://youtu.be/dQw4w9WgXcQ/extra",
      "https://youtube.com/watch?v=abc",
    ]) expect(parseYouTubeUrl(url)).toBeNull();
  });
  it("lehnt ungueltige Spulpositionen ab", () => {
    for (const position of [-1, NaN, Infinity, 86401]) {
      expect(playerCommandSchema.safeParse({ type: "seek", instance: "890262f8-d4a6-4b2c-8a94-a998d363fd43", position }).success).toBe(false);
      for (const type of ["play", "pause"]) {
        expect(playerCommandSchema.safeParse({ type, instance: "890262f8-d4a6-4b2c-8a94-a998d363fd43", position }).success).toBe(false);
      }
    }
  });
});
