import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const mockApi = readFileSync(new URL("./youtube-mock.js", import.meta.url), "utf8");
const url = (id: string) => `https://www.youtube.com/watch?v=${id}`;
async function mock(page: Page) {
  await page.route("https://www.youtube.com/iframe_api", (route) => route.fulfill({
    contentType: "application/javascript", body: mockApi,
  }));
}
async function joinRoom(page: Page, path: string, name: string) {
  await page.goto(path);
  await page.getByLabel("Dein Anzeigename").fill(name);
  await page.getByRole("button", { name: "Raum beitreten" }).click();
  await expect(page.getByText("Verbunden", { exact: true })).toBeVisible();
}

test("zwei Browser steuern Player und Queue, korrigieren Drift und zeigen Autoplay/Fehler", async ({ browser, request }) => {
  const response = await request.post("/api/rooms", { headers: { Origin: "http://127.0.0.1:3100" } });
  expect(response.status()).toBe(201);
  const { roomId } = await response.json();
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const a = await firstContext.newPage();
  const b = await secondContext.newPage();
  try {
    await mock(a);
    await mock(b);
    await joinRoom(a, `/room/${roomId}`, "Anna");
    await joinRoom(b, `/room/${roomId}`, "Ben");
    await expect(a.getByRole("heading", { name: "Teilnehmer (2/5)" })).toBeVisible();
    await a.getByLabel("YouTube-Link").fill(url("dQw4w9WgXcQ"));
    await a.getByRole("button", { name: "Hinzufuegen" }).click();
    const currentVideoLink = b.locator(".current-video a");
    await expect(currentVideoLink).toHaveText("Titel dQw4w9WgXcQ");
    await expect(currentVideoLink).toHaveAttribute("href", url("dQw4w9WgXcQ"));
    await expect(b.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    for (const page of [a, b]) {
      await expect.poll(() => page.evaluate<number>("window.__player.getPlayerState()")).toBe(1);
      expect(await page.evaluate<boolean>("window.__player.isMuted()")).toBe(true);
    }
    await a.getByRole("button", { name: "Ton einschalten" }).click();
    await b.getByRole("button", { name: "Ton einschalten" }).click();
    await expect.poll(() => b.evaluate<boolean>("window.__player.isMuted()")).toBe(false);
    await expect.poll(async () => Math.abs(await a.evaluate<number>("window.__player.getCurrentTime()") -
      await b.evaluate<number>("window.__player.getCurrentTime()"))).toBeLessThan(1);

    await b.getByLabel("Position in Sekunden").fill("30");
    await b.getByRole("button", { name: "Spulen", exact: true }).click();
    await expect.poll(() => a.evaluate<number>("window.__player.getCurrentTime()")).toBeGreaterThanOrEqual(30);
    await a.evaluate("window.__player.drift(-4)");
    await expect.poll(async () => Math.abs(await a.evaluate<number>("window.__player.getCurrentTime()") -
      await b.evaluate<number>("window.__player.getCurrentTime()"))).toBeGreaterThan(1);
    await expect.poll(async () => Math.abs(await a.evaluate<number>("window.__player.getCurrentTime()") -
      await b.evaluate<number>("window.__player.getCurrentTime()")), { timeout: 5000 }).toBeLessThan(1);

    const started = Date.now();
    await b.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(a.getByRole("button", { name: "Abspielen", exact: true })).toBeVisible({ timeout: 1500 });
    expect(Date.now() - started).toBeLessThan(500);
    console.log(`Lokale Player-Steuerung auf zweitem Browser sichtbar nach ${Date.now() - started} ms.`);
    await expect.poll(() => a.evaluate<number>("window.__player.getPlayerState()")).toBe(2);
    for (const id of ["aqz-KE-bpKQ", "M7lc1UVf-VE"]) {
      await b.getByLabel("YouTube-Link").fill(url(id));
      await b.getByRole("button", { name: "Hinzufuegen" }).click();
    }
    await expect(a.locator(".queue li")).toHaveCount(2);
    await a.getByRole("button", { name: "Video 2 nach oben" }).click();
    await expect(b.locator(".queue li").first()).toContainText("M7lc1UVf-VE");
    await b.getByRole("button", { name: "Naechstes Video" }).click();
    await expect(a.locator(".current-video a")).toHaveText("Titel M7lc1UVf-VE");
    await expect(b.locator(".queue li")).toHaveCount(1);

    await a.frameLocator(".video-frame iframe").getByRole("button", { name: "YouTube Play/Pause" }).click();
    await expect(b.getByRole("button", { name: "Abspielen", exact: true })).toBeVisible();
    await expect.poll(() => b.evaluate<number>("window.__player.getPlayerState()")).toBe(2);
    await b.frameLocator(".video-frame iframe").getByRole("button", { name: "YouTube Play/Pause" }).click();
    await expect(a.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await b.getByLabel("Position in Sekunden").fill("120");
    await b.getByRole("button", { name: "Spulen", exact: true }).click();
    await expect(a.locator(".current-video a")).toHaveText("Titel aqz-KE-bpKQ");
    await expect(b.locator(".queue li")).toHaveCount(0);
    await a.getByLabel("YouTube-Link").fill(url("yyyyyyyyyyy"));
    await a.getByRole("button", { name: "Hinzufuegen" }).click();
    await expect(b.locator(".queue li")).toHaveCount(1);
    await a.getByRole("button", { name: "Naechstes Video" }).click();
    await expect(b.getByRole("alert")).toContainText("YouTube-Fehler 100");
    await b.getByRole("button", { name: "Raum verlassen" }).click();
    await expect(a.getByRole("heading", { name: "Teilnehmer (1/5)" })).toBeVisible();
    await a.screenshot({ path: "test-results/room-desktop.png", fullPage: true });
    await a.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.screenshot({ path: "test-results/room-mobile.png", fullPage: true });
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test("native YouTube-Controls synchronisieren auch pausiertes Spulen; Vollbild und Lautstaerke bleiben lokal", async ({ browser, request }) => {
  const response = await request.post("/api/rooms", { headers: { Origin: "http://127.0.0.1:3100" } });
  const { roomId } = await response.json();
  const first = await browser.newContext();
  const second = await browser.newContext();
  const a = await first.newPage();
  const b = await second.newPage();
  const commands: string[] = [];
  for (const [label, page] of [["a", a], ["b", b]] as const) {
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      if (String(payload).includes('"player"')) commands.push(`${label}: ${payload}`);
    }));
  }
  try {
    await mock(a);
    await mock(b);
    await b.addInitScript(() => Reflect.set(window, "__strictAutoplay", true));
    await joinRoom(a, `/room/${roomId}`, "Anna");
    await joinRoom(b, `/room/${roomId}`, "Ben");
    await a.getByLabel("YouTube-Link").fill(url("dQw4w9WgXcQ"));
    await a.getByRole("button", { name: "Hinzufuegen" }).click();
    const controls = a.frameLocator(".video-frame iframe");
    await expect(b.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect(controls.getByRole("button", { name: "YouTube Play/Pause" })).toBeVisible();
    await a.getByRole("button", { name: "Ton einschalten" }).click();
    await b.getByRole("button", { name: "Ton einschalten" }).click();
    await expect(b.getByText(/Lautsprecher-Symbol/)).toBeVisible();
    await expect(a.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect.poll(() => a.evaluate<number>("window.__player.getPlayerState()")).toBe(1);
    await expect.poll(() => b.evaluate<number>("window.__player.getPlayerState()")).toBe(1);
    expect(await b.evaluate<boolean>("window.__player.isMuted()")).toBe(true);
    await controls.getByLabel("YouTube Position").fill("45");
    await expect.poll(() => b.evaluate<number>("window.__player.getCurrentTime()")).toBeGreaterThanOrEqual(45);
    await controls.getByRole("button", { name: "YouTube Play/Pause" }).click();
    await expect(b.getByRole("button", { name: "Abspielen", exact: true })).toBeVisible();
    await expect.poll(() => b.evaluate<number>("window.__player.getPlayerState()")).toBe(2);
    await controls.getByLabel("YouTube Position").fill("15");
    await expect.poll(() => b.evaluate<number>("window.__player.getCurrentTime()")).toBeCloseTo(15, 0);
    await controls.getByLabel("YouTube Position").fill("65");
    await expect.poll(() => b.evaluate<number>("window.__player.getCurrentTime()")).toBeCloseTo(65, 0);
    await controls.getByLabel("YouTube Lautstaerke").fill("20");
    await controls.getByRole("button", { name: "YouTube Vollbild" }).click();
    await expect.poll(() => a.evaluate(() => document.fullscreenElement?.tagName)).toBe("IFRAME");
    expect(await b.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(await a.evaluate<number>("window.__player.volume")).toBe(20);
    expect(await b.evaluate<number>("window.__player.volume")).toBe(75);
    await expect(b.getByRole("button", { name: "Abspielen", exact: true })).toBeVisible();
    await a.evaluate(() => document.exitFullscreen());
    await expect.poll(() => b.evaluate<number>("window.__player.getCurrentTime()")).toBeCloseTo(65, 0);
    await expect(a.getByRole("alert")).toHaveCount(0);
    await expect(b.getByRole("alert")).toHaveCount(0);
    expect(commands.filter((command) => command.startsWith("a:"))).toHaveLength(4);
    expect(commands.filter((command) => command.startsWith("b:"))).toEqual([]);
  } finally { await first.close(); await second.close(); }
});

test("voruebergehender YouTube-Fehler 5 laedt neu und bleibt synchron", async ({ page, request }) => {
  const response = await request.post("/api/rooms", { headers: { Origin: "http://127.0.0.1:3100" } });
  const { roomId } = await response.json();
  await mock(page);
  await joinRoom(page, `/room/${roomId}`, "Anna");
  await page.getByLabel("YouTube-Link").fill(url("zzzzzzzzzzz"));
  await page.getByRole("button", { name: "Hinzufuegen" }).click();
  await expect.poll(() => page.evaluate<boolean>("Boolean(window.__transientFailed)")).toBe(true);
  await expect.poll(() => page.evaluate<number>("window.__player.getPlayerState()"), { timeout: 5000 }).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("spaeter Beitritt mit langsamem Laden holt die Raumposition ein", async ({ browser, request }) => {
  const response = await request.post("/api/rooms", { headers: { Origin: "http://127.0.0.1:3100" } });
  const { roomId } = await response.json();
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await mock(a);
  await mock(b);
  await b.addInitScript(() => { Reflect.set(window, "__slowLoad", 6000); });
  await joinRoom(a, `/room/${roomId}`, "Anna");
  await a.getByLabel("YouTube-Link").fill(url("dQw4w9WgXcQ"));
  await a.getByRole("button", { name: "Hinzufuegen" }).click();
  await expect.poll(() => a.evaluate<number>("window.__player.getPlayerState()")).toBe(1);
  await a.waitForTimeout(3000);
  await joinRoom(b, `/room/${roomId}`, "Ben");
  await b.waitForTimeout(4000);
  expect(await b.evaluate<number>("window.__player.getPlayerState()")).toBe(-1);
  expect(await b.getByRole("button", { name: "Wiedergabe in diesem Browser freigeben" }).count()).toBe(0);
  await expect.poll(() => b.evaluate<number>("window.__player.getPlayerState()"), { timeout: 5000 }).toBe(1);
  await expect.poll(async () => Math.abs(await a.evaluate<number>("window.__player.getCurrentTime()") -
    await b.evaluate<number>("window.__player.getCurrentTime()")), { timeout: 5000 }).toBeLessThan(0.75);
  expect(await a.evaluate<number>("window.__player.getPlayerState()")).toBe(1);
  await a.context().close();
  await b.context().close();
});

test("Startseite erstellt einen privaten Raum und lehnt ungueltige Links sichtbar ab", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await page.getByLabel("Dein Anzeigename").fill("Test");
  await page.getByRole("button", { name: "Privaten Raum erstellen" }).click();
  await expect(page).toHaveURL(/\/room\/[A-Za-z0-9_-]{32}$/);
  await page.getByRole("button", { name: "Raum beitreten" }).click();
  await expect(page.getByText("Verbunden", { exact: true })).toBeVisible();
  await page.getByLabel("YouTube-Link").fill("https://example.com/watch?v=dQw4w9WgXcQ");
  await page.getByRole("button", { name: "Hinzufuegen" }).click();
  await expect(page.getByRole("alert")).toContainText("gueltigen YouTube");
});

test("echte YouTube-Wiedergabe in zwei Browsern (optional)", async ({ browser, request }) => {
  test.skip(process.env.REAL_YOUTUBE !== "1", "Externe YouTube-Erreichbarkeit separat pruefen.");
  test.setTimeout(90_000);
  const response = await request.post("/api/rooms", { headers: { Origin: "http://127.0.0.1:3100" } });
  const { roomId } = await response.json();
  const first = await browser.newContext();
  const second = await browser.newContext();
  const a = await first.newPage();
  const b = await second.newPage();
  const commands: string[] = [];
  for (const [label, page] of [["a", a], ["b", b]] as const) {
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      if (String(payload).includes('"player"')) commands.push(`${label}: ${payload}`);
    }));
  }
  try {
    for (const page of [a, b]) await page.addInitScript(() => {
      let state = -1;
      window.addEventListener("message", (event) => {
        const frame = document.querySelector<HTMLIFrameElement>(".video-frame iframe");
        if (event.source !== frame?.contentWindow || event.origin !== "https://www.youtube.com" ||
            typeof event.data !== "string" || !event.data.startsWith("{")) return;
        const data = JSON.parse(event.data);
        if (data.event !== "infoDelivery") return;
        if (typeof data.info?.playerState === "number") state = data.info.playerState;
        if (typeof data.info?.currentTime === "number") {
          Reflect.set(window, "__youtubeSample", { position: data.info.currentTime, state, at: Date.now() });
        }
      });
    });
    await joinRoom(a, `/room/${roomId}`, "Anna");
    await joinRoom(b, `/room/${roomId}`, "Ben");
    await a.getByLabel("YouTube-Link").fill(url("M7lc1UVf-VE"));
    await a.getByRole("button", { name: "Hinzufuegen" }).click();
    await expect(a.locator(".video-frame iframe")).toBeVisible({ timeout: 20000 });
    const currentVideoLink = a.locator(".current-video a");
    await expect(currentVideoLink).not.toHaveText("M7lc1UVf-VE", { timeout: 20000 });
    await expect(currentVideoLink).toHaveAttribute("href", url("M7lc1UVf-VE"));
    await expect(b.getByRole("button", { name: "Pause", exact: true })).toBeVisible({ timeout: 20000 });
    for (const page of [a, b]) {
      const unblock = page.getByRole("button", { name: /Ton einschalten|Wiedergabe in diesem Browser freigeben/ });
      await expect(unblock.or(page.getByText("Gemeinsame Wiedergabe", { exact: true }))).toBeVisible();
      if (await unblock.isVisible()) await unblock.click();
    }
    await a.getByLabel("Position in Sekunden").fill("30");
    await a.getByRole("button", { name: "Spulen", exact: true }).click();
    const sample = (page: Page) => page.evaluate<{ position: number; state: number; at: number } | null>("window.__youtubeSample || null");
    let positions: number[] = [];
    await expect.poll(async () => {
      const [x, y] = await Promise.all([sample(a), sample(b)]);
      if (!x || !y || x.state !== 1 || y.state !== 1 || Date.now() - Math.min(x.at, y.at) > 1500) return Infinity;
      positions = [x.position, y.position];
      return Math.min(...positions) >= 30 ? Math.abs(positions[0] - positions[1]) : Infinity;
    }, { timeout: 20000 }).toBeLessThan(1);
    const initial = [...positions];
    await expect.poll(async () => {
      const [x, y] = await Promise.all([sample(a), sample(b)]);
      if (!x || !y || x.state !== 1 || y.state !== 1 || Date.now() - Math.min(x.at, y.at) > 1500) return Infinity;
      positions = [x.position, y.position];
      return x.position > initial[0] + 1 && y.position > initial[1] + 1 ? Math.abs(x.position - y.position) : Infinity;
    }, { timeout: 20000 }).toBeLessThan(1);
    console.log(`Echte YouTube-Positionen: ${positions.map((value) => value.toFixed(3)).join(" / ")} s; Abweichung ${Math.abs(positions[0] - positions[1]).toFixed(3)} s.`);
    await a.bringToFront();
    const native = a.frameLocator(".video-frame iframe");
    const showControls = async () => {
      await native.locator("body").hover();
      const show = native.getByRole("button", { name: "Show player controls", exact: true });
      if (await show.isVisible()) await show.click();
    };
    const toggle = native.locator(".ytp-play-button, .player-control-play-pause-icon");
    await showControls();
    await toggle.click({ timeout: 10000 });
    await expect(b.getByRole("button", { name: "Abspielen", exact: true })).toBeVisible();
    await expect.poll(async () => (await sample(b))?.state).toBe(2);
    const progress = native.locator(".ytp-progress-bar, [role=slider][aria-label='Seek slider']");
    const bounds = await progress.boundingBox();
    if (!bounds) throw new Error("YouTube-Fortschrittsleiste ist nicht sichtbar.");
    await progress.click({ position: { x: bounds.width * 0.4, y: bounds.height / 2 } });
    await expect.poll(async () => {
      const [x, y] = await Promise.all([sample(a), sample(b)]);
      return x && y && x.position > 50 && y.position > 50 ? Math.abs(x.position - y.position) : Infinity;
    }).toBeLessThan(1);
    await showControls();
    await native.locator(".ytp-fullscreen-button, .fullscreen-icon").click({ timeout: 10000 });
    await expect.poll(() => a.evaluate(() => document.fullscreenElement?.tagName)).toBe("IFRAME");
    expect(await b.evaluate(() => document.fullscreenElement)).toBeNull();
    await showControls();
    await toggle.press("Enter", { timeout: 10000 });
    await expect(b.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect.poll(async () => {
      const [x, y] = await Promise.all([sample(a), sample(b)]);
      return x && y && x.state === 1 && y.state === 1 ? Math.abs(x.position - y.position) : Infinity;
    }, { timeout: 20000 }).toBeLessThan(1);
    await showControls();
    const fullscreenBounds = await progress.boundingBox();
    if (!fullscreenBounds) throw new Error("YouTube-Fortschrittsleiste ist im Vollbild nicht sichtbar.");
    await progress.click({ position: { x: fullscreenBounds.width * 0.1, y: fullscreenBounds.height / 2 } });
    await expect.poll(async () => {
      const [x, y] = await Promise.all([sample(a), sample(b)]);
      return x && y && x.state === 1 && y.state === 1 && x.position < 200 && y.position < 200 ?
        Math.abs(x.position - y.position) : Infinity;
    }, { timeout: 20000 }).toBeLessThan(1);
    await showControls();
    await toggle.press("Enter", { timeout: 10000 });
    await expect(b.getByRole("button", { name: "Abspielen", exact: true })).toBeVisible();
    await a.evaluate(() => document.exitFullscreen());
    await expect(a.getByRole("alert")).toHaveCount(0);
    await expect(b.getByRole("alert")).toHaveCount(0);
    expect(commands.filter((command) => command.startsWith("b:"))).toEqual([]);
    await a.screenshot({ path: "test-results/real-youtube.png", fullPage: true });
  } finally { await first.close(); await second.close(); }
});
