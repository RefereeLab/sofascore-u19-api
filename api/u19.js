import { get, put } from "@vercel/blob";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

import historicalValidation from "../data/historical-validation.js";
import historicalConflicts from "../data/historical-conflicts.js";
import manualOverrides from "../data/manual-overrides.js";
import {
  SEASON_ID,
  TOURNAMENT_ID,
  cacheWindow,
  compactEvent,
  hasFinalScore,
  mergeManualOverride,
  parseWidgetEvents,
  periodData,
  responseCacheControl,
  statusType,
  updateRecord
} from "../lib/u19-core.js";

const WIDGET_URL =
  "https://widgets.sofascore.com/it/embed/unique-tournament/33926/season/102342/editorFixtures?showCompetitionLogo=true&widgetTheme=light";
const STATE_VERSION = 1;
const DIRECT_TIMEOUT_MS = 12_000;
const BROWSER_TIMEOUT_MS = 45_000;
const inFlightByRound = new Map();

function belongsToU19(event) {
  const id = event?.tournament?.uniqueTournament?.id;
  const name = String(event?.tournament?.name || event?.tournamentName || "");
  return Number(id) === TOURNAMENT_ID || /u19\s+eccellenza/i.test(name);
}

function widgetUrl(round) {
  const url = new URL(WIDGET_URL);
  if (round) url.searchParams.set("round", String(round));
  return url.toString();
}

async function fetchWidgetDirect(round) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
  try {
    const response = await fetch(widgetUrl(round), {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "it-IT,it;q=0.9,en;q=0.7",
        referer: "https://www.sofascore.com/",
        "user-agent": "Mozilla/5.0 (compatible; U19ScoreArchive/2.0)"
      }
    });
    if (!response.ok) throw new Error(`Widget SofaScore ${response.status}`);
    return parseWidgetEvents(await response.text())
      .filter(belongsToU19)
      .map(compactEvent);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWidgetWithBrowser(round) {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 900 },
      executablePath: await chromium.executablePath(),
      headless: "shell"
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
    );
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const type = request.resourceType();
      if (["image", "font", "media", "stylesheet"].includes(type)) request.abort();
      else request.continue();
    });
    await page.goto(widgetUrl(round), {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_TIMEOUT_MS
    });
    await page.waitForSelector("#__NEXT_DATA__", { timeout: 15_000 });
    const events = await page.$eval("#__NEXT_DATA__", (element) => {
      const parsed = JSON.parse(element.textContent || "{}");
      return parsed?.props?.pageProps?.events || [];
    });
    return events.filter(belongsToU19).map(compactEvent);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function acquireEvents(round) {
  try {
    const events = await fetchWidgetDirect(round);
    return { events, acquisition: "http", source: "SofaScore · feed diretto" };
  } catch (directError) {
    const events = await fetchWidgetWithBrowser(round);
    return {
      events,
      acquisition: "chromium-fallback",
      source: "SofaScore · browser di riserva",
      upstreamWarning: directError instanceof Error ? directError.message : "Feed diretto non disponibile"
    };
  }
}

function statePath(round) {
  return `u19/round-${round}.json`;
}

async function readJson(pathname) {
  try {
    const result = await get(pathname, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return JSON.parse(await new Response(result.stream).text());
  } catch (error) {
    if (/not found|404/i.test(String(error?.message || error))) return null;
    throw error;
  }
}

async function writeJson(pathname, value) {
  await put(pathname, JSON.stringify(value), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json"
  });
}

function emptyState(round) {
  return {
    version: STATE_VERSION,
    round,
    updatedAt: null,
    cache: null,
    records: {}
  };
}

function historicalImportIsValid(event) {
  const expected = historicalValidation[String(event.id)];
  if (!expected || statusType(event) !== "finished" || !hasFinalScore(event)) return false;
  const finalMatches = Number(event.homeScore.current) === expected.home &&
    Number(event.awayScore.current) === expected.away &&
    Number(event.roundInfo?.round) === Number(expected.round);
  const periods = periodData(event);
  const expectedPeriods = JSON.stringify(expected.periods || []);
  return finalMatches && periods.complete && periods.coherent &&
    JSON.stringify(periods.periods.slice(0, 4)) === expectedPeriods;
}

function stateEvents(state) {
  const cached = Array.isArray(state?.cache?.events) ? state.cache.events : [];
  return cached.map((event) => {
    const record = state.records?.[String(event.id)];
    const archived = record?.archivedAt && record.event ? record.event : event;
    return mergeManualOverride(archived, manualOverrides[String(event.id)]);
  });
}

function allEventsArchived(state) {
  const events = Array.isArray(state?.cache?.events) ? state.cache.events : [];
  return events.length > 0 && events.every((event) => {
    const record = state.records?.[String(event.id)];
    return record?.archivedAt && !record.needsPeriodRecovery;
  });
}

function cacheIsFresh(state, nowMs) {
  return Number(state?.cache?.expiresAt || 0) > nowMs;
}

function buildPayload(state, events, options = {}) {
  const archivedCount = events.filter((event) => state.records?.[String(event.id)]?.archivedAt).length;
  return {
    source: options.source || state.cache?.source || "Archivio U19",
    tournamentId: TOURNAMENT_ID,
    seasonId: SEASON_ID,
    updatedAt: options.updatedAt || state.updatedAt || new Date().toISOString(),
    selectedRound: state.round,
    selectedRoundLoaded: true,
    cacheMode: options.cacheMode || state.cache?.mode || "archive",
    acquisition: options.acquisition || state.cache?.acquisition || "archive",
    archivedEvents: archivedCount,
    upstreamWarning: options.upstreamWarning || null,
    events
  };
}

async function refreshRound(round, preloaded = null) {
  const key = String(round);
  if (!preloaded && inFlightByRound.has(key)) return inFlightByRound.get(key);

  const operation = (async () => {
    const now = new Date();
    const nowIso = now.toISOString();
    let state;
    let storageWarning = null;
    try {
      state = await readJson(statePath(round));
    } catch (error) {
      storageWarning = error instanceof Error ? error.message : "Archivio temporaneamente non disponibile";
    }
    state = state && state.version === STATE_VERSION ? state : emptyState(round);

    const acquired = preloaded || await acquireEvents(round);
    const events = acquired.events.filter(
      (event) => !event.roundInfo?.round || Number(event.roundInfo.round) === Number(round)
    );
    if (!events.length) {
      const storedEvents = stateEvents(state);
      if (storedEvents.length) {
        return {
          state,
          payload: buildPayload(state, storedEvents, {
            cacheMode: "stale-archive",
            upstreamWarning: "Nessuna partita ricevuta; mantenuti i dati archiviati"
          }),
          window: cacheWindow(storedEvents, state.records)
        };
      }
      return {
        state,
        payload: buildPayload(state, [], {
          source: acquired.source,
          acquisition: acquired.acquisition,
          cacheMode: "empty",
          upstreamWarning: "Nessuna partita disponibile per la giornata"
        }),
        window: { ttlMs: 10 * 60_000, swrSeconds: 1800, mode: "empty" }
      };
    }

    events.forEach((event) => {
      const id = String(event.id);
      const previous = state.records[id];
      const validatedHistoricalImport = !previous?.archivedAt && historicalImportIsValid(event);
      state.records[id] = updateRecord(previous, event, nowIso, {
        source: acquired.source,
        validatedHistoricalImport,
        archiveBlocked: historicalConflicts[id]?.reason || null
      });
    });

    const window = cacheWindow(events, state.records, now.getTime());
    state.updatedAt = nowIso;
    state.cache = {
      fetchedAt: nowIso,
      expiresAt: now.getTime() + window.ttlMs,
      mode: window.mode,
      source: acquired.source,
      acquisition: acquired.acquisition,
      events
    };

    try {
      await writeJson(statePath(round), state);
    } catch (error) {
      storageWarning = error instanceof Error ? error.message : "Salvataggio archivio non disponibile";
    }

    const outputEvents = stateEvents(state);
    return {
      state,
      payload: buildPayload(state, outputEvents, {
        source: acquired.source,
        acquisition: acquired.acquisition,
        cacheMode: window.mode,
        updatedAt: nowIso,
        upstreamWarning: [acquired.upstreamWarning, storageWarning].filter(Boolean).join(" · ") || null
      }),
      window
    };
  })();

  if (!preloaded) inFlightByRound.set(key, operation);
  try {
    return await operation;
  } finally {
    if (!preloaded) inFlightByRound.delete(key);
  }
}

async function loadRound(round, forceRefresh = false) {
  let state = null;
  let storageWarning = null;
  try {
    state = await readJson(statePath(round));
  } catch (error) {
    storageWarning = error instanceof Error ? error.message : "Archivio temporaneamente non disponibile";
  }

  const nowMs = Date.now();
  if (!forceRefresh && state && (allEventsArchived(state) || cacheIsFresh(state, nowMs))) {
    const events = stateEvents(state);
    const window = cacheWindow(events, state.records, nowMs);
    return {
      state,
      payload: buildPayload(state, events, {
        cacheMode: allEventsArchived(state) ? "archive" : `shared-${state.cache?.mode || "cache"}`,
        acquisition: "shared-blob-cache",
        upstreamWarning: storageWarning
      }),
      window
    };
  }

  try {
    return await refreshRound(round);
  } catch (error) {
    if (state) {
      const events = stateEvents(state);
      if (events.length) {
        const window = cacheWindow(events, state.records, nowMs);
        return {
          state,
          payload: buildPayload(state, events, {
            cacheMode: "stale-archive",
            acquisition: "archive-fallback",
            upstreamWarning: error instanceof Error ? error.message : "SofaScore non disponibile"
          }),
          window
        };
      }
    }
    throw error;
  }
}

async function loadCurrentRound() {
  const acquired = await acquireEvents(null);
  const round = Number(acquired.events.find((event) => event.roundInfo?.round)?.roundInfo?.round);
  if (!Number.isInteger(round) || round < 1 || round > 10) {
    return {
      state: emptyState(null),
      payload: {
        source: acquired.source,
        tournamentId: TOURNAMENT_ID,
        seasonId: SEASON_ID,
        updatedAt: new Date().toISOString(),
        selectedRound: null,
        selectedRoundLoaded: true,
        cacheMode: "empty",
        acquisition: acquired.acquisition,
        archivedEvents: 0,
        upstreamWarning: "Nessuna giornata corrente disponibile",
        events: acquired.events
      },
      window: { ttlMs: 10 * 60_000, swrSeconds: 1800, mode: "empty" }
    };
  }
  return refreshRound(round, acquired);
}

function isAuthorizedCron(request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.authorization === `Bearer ${secret}`;
}

export default async function handler(request, response) {
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "GET") return response.status(405).json({ error: "Method not allowed" });

  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");

  const value = Number(request.query?.round);
  const round = Number.isInteger(value) && value >= 1 && value <= 10 ? value : null;
  const cron = String(request.query?.cron || "") === "1";
  if (cron && !isAuthorizedCron(request)) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = round
      ? await loadRound(round, cron)
      : await loadCurrentRound();
    response.setHeader(
      "Cache-Control",
      cron ? "no-store" : responseCacheControl(result.window)
    );
    return response.status(200).json(result.payload);
  } catch (error) {
    console.error("SofaScore U19 feed error", error);
    response.setHeader("Cache-Control", "no-store");
    return response.status(502).json({
      source: "SofaScore / archivio U19",
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Dati temporaneamente non disponibili"
    });
  }
}

