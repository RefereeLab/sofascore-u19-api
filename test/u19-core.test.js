import assert from "node:assert/strict";
import test from "node:test";

import {
  STABILIZATION_MS,
  cacheWindow,
  mergeManualOverride,
  periodData,
  updateRecord
} from "../lib/u19-core.js";

function finishedEvent(home = 80, away = 70, periods = true) {
  return {
    id: 123,
    startTimestamp: 1,
    status: { code: 100, type: "finished" },
    roundInfo: { round: 3 },
    homeTeam: { id: 1, name: "Casa" },
    awayTeam: { id: 2, name: "Ospite" },
    homeScore: {
      current: home,
      normaltime: home,
      ...(periods ? { period1: 20, period2: 20, period3: 20, period4: home - 60 } : {})
    },
    awayScore: {
      current: away,
      normaltime: away,
      ...(periods ? { period1: 18, period2: 17, period3: 17, period4: away - 52 } : {})
    }
  };
}

test("non archivia al primo rilevamento del finale", () => {
  const first = updateRecord(null, finishedEvent(), "2026-10-12T20:00:00.000Z");
  assert.equal(first.archivedAt, undefined);
  assert.equal(first.firstFinishedSeenAt, "2026-10-12T20:00:00.000Z");
  assert.equal(first.lastScoreChangedAt, "2026-10-12T20:00:00.000Z");
});

test("archivia soltanto dopo almeno 60 minuti osservati senza variazioni", () => {
  const first = updateRecord(null, finishedEvent(), "2026-10-12T20:00:00.000Z");
  const early = updateRecord(first, finishedEvent(), "2026-10-12T20:59:59.999Z");
  assert.equal(early.archivedAt, undefined);
  const stable = updateRecord(early, finishedEvent(), new Date(Date.parse("2026-10-12T20:00:00.000Z") + STABILIZATION_MS).toISOString());
  assert.equal(stable.archivedAt, "2026-10-12T21:00:00.000Z");
});

test("una correzione del finale riavvia l'attesa", () => {
  const first = updateRecord(null, finishedEvent(), "2026-10-12T20:00:00.000Z");
  const changed = updateRecord(first, finishedEvent(82, 70), "2026-10-12T20:50:00.000Z");
  const tooSoon = updateRecord(changed, finishedEvent(82, 70), "2026-10-12T21:01:00.000Z");
  assert.equal(tooSoon.archivedAt, null);
  assert.equal(tooSoon.lastScoreChangedAt, "2026-10-12T20:50:00.000Z");
  const stable = updateRecord(tooSoon, finishedEvent(82, 70), "2026-10-12T21:50:00.000Z");
  assert.equal(stable.archivedAt, "2026-10-12T21:50:00.000Z");
});

test("salva il finale stabile anche con quarti mancanti e richiede recupero", () => {
  const first = updateRecord(null, finishedEvent(80, 70, false), "2026-10-12T20:00:00.000Z");
  const stable = updateRecord(first, finishedEvent(80, 70, false), "2026-10-12T21:00:00.000Z");
  assert.equal(stable.archivedAt, "2026-10-12T21:00:00.000Z");
  assert.equal(stable.needsPeriodRecovery, true);
});

test("un conflitto storico resta bloccato e viene ricontrollato a bassa frequenza", () => {
  const first = updateRecord(null, finishedEvent(), "2026-10-12T20:00:00.000Z", {
    archiveBlocked: "finale discordante"
  });
  const later = updateRecord(first, finishedEvent(), "2026-10-13T20:00:00.000Z", {
    archiveBlocked: "finale discordante"
  });
  assert.equal(later.archivedAt, null);
  assert.equal(later.archiveBlocked, "finale discordante");
  assert.equal(cacheWindow([finishedEvent()], { "123": later }).mode, "period-recovery");
});

test("un conflitto risolto viene sbloccato al controllo successivo", () => {
  const blocked = updateRecord(null, finishedEvent(), "2026-10-12T20:00:00.000Z", {
    archiveBlocked: "finale discordante"
  });
  const resolved = updateRecord(blocked, finishedEvent(), "2026-10-13T20:00:00.000Z");
  assert.equal(resolved.archiveBlocked, undefined);
  assert.equal(resolved.archivedAt, "2026-10-13T20:00:00.000Z");
});

test("riconosce quarti e supplementare coerenti", () => {
  const event = finishedEvent(86, 82);
  event.homeScore.normaltime = 80;
  event.awayScore.normaltime = 70;
  event.homeScore.period4 = 20;
  event.awayScore.period4 = 18;
  event.homeScore.overtime = 6;
  event.awayScore.overtime = 12;
  const result = periodData(event);
  assert.equal(result.complete, true);
  assert.equal(result.coherent, true);
});

test("le correzioni manuali prevalgono senza cancellare gli altri campi", () => {
  const event = finishedEvent();
  const merged = mergeManualOverride(event, {
    homeScore: { current: 81 },
    status: { description: "Correzione ufficiale" }
  });
  assert.equal(merged.homeScore.current, 81);
  assert.equal(merged.homeScore.period1, 20);
  assert.equal(merged.status.type, "finished");
  assert.equal(merged.status.description, "Correzione ufficiale");
});

test("la cache distingue live, stabilizzazione e inattività", () => {
  const live = finishedEvent();
  live.status.type = "inprogress";
  assert.equal(cacheWindow([live], {}).mode, "live");
  assert.equal(cacheWindow([finishedEvent()], {}).mode, "stabilizing");
  const upcoming = finishedEvent();
  upcoming.status.type = "notstarted";
  upcoming.startTimestamp = Math.floor((Date.now() + 30 * 60_000) / 1000);
  assert.equal(cacheWindow([upcoming], {}).mode, "imminent");
});

test("una gara live prevale sempre sui conflitti storici", () => {
  const now = Date.parse("2026-10-13T18:00:00Z");
  const live = finishedEvent();
  live.status.type = "inprogress";
  const old = finishedEvent();
  old.id = 456;
  const window = cacheWindow([old, live], {
    "456": { archivedAt: "2026-10-12T20:00:00Z", needsPeriodRecovery: true }
  }, now);
  assert.equal(window.mode, "live");
  assert.ok(window.ttlMs <= 30_000);
});

test("una gara non ancora marcata live viene ricontrollata dopo l'orario di inizio", () => {
  const now = Date.parse("2026-10-13T18:00:00Z");
  const event = finishedEvent();
  event.status.type = "notstarted";
  event.startTimestamp = (now - 45 * 60_000) / 1000;
  const window = cacheWindow([event], {}, now);
  assert.equal(window.mode, "awaiting-live");
  assert.ok(window.ttlMs <= 30_000);
});

test("la cache per i parziali storici non puo' attraversare la prossima partita", () => {
  const now = Date.parse("2026-10-13T18:00:00Z");
  const old = finishedEvent();
  const future = finishedEvent();
  future.id = 456;
  future.status.type = "notstarted";
  future.startTimestamp = (now + 4 * 60 * 60_000) / 1000;
  const window = cacheWindow([old, future], {
    "123": { archivedAt: "2026-10-13T16:00:00Z", needsPeriodRecovery: true }
  }, now);
  const secondsTillNextStart = (future.startTimestamp * 1000 - now) / 1000;
  assert.equal(window.mode, "period-recovery");
  assert.ok(window.ttlMs / 1000 + window.swrSeconds < secondsTillNextStart - 30);
});

test("una partita imminente prevale sul recupero lento dei quarti", () => {
  const now = Date.parse("2026-10-13T18:00:00Z");
  const old = finishedEvent();
  const future = finishedEvent();
  future.id = 456;
  future.status.type = "notstarted";
  future.startTimestamp = (now + 20 * 60_000) / 1000;
  const window = cacheWindow([old, future], {
    "123": { archivedAt: "2026-10-13T16:00:00Z", needsPeriodRecovery: true }
  }, now);
  assert.equal(window.mode, "imminent");
  assert.ok(window.ttlMs <= 60_000);
});
