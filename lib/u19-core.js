export const TOURNAMENT_ID = 33926;
export const SEASON_ID = 102342;
export const STABILIZATION_MS = 60 * 60 * 1000;

export function normalizeTeamName(team) {
  const id = team?.id;
  const original = team?.name || team?.shortName || "";
  if (id === 1211259) return "UNA HOTELS REGGIO EMILIA";
  if (id === 1211255) return "RAGGISOLARIS ACADEMY FAEN";
  return original;
}

export function compactEvent(event) {
  return {
    id: event.id,
    startTimestamp: event.startTimestamp,
    status: event.status || {},
    tournamentName: event.tournamentName || event.tournament?.name || "",
    roundInfo: event.roundInfo || {},
    homeTeam: {
      id: event.homeTeam?.id,
      name: normalizeTeamName(event.homeTeam)
    },
    awayTeam: {
      id: event.awayTeam?.id,
      name: normalizeTeamName(event.awayTeam)
    },
    homeScore: event.homeScore || {},
    awayScore: event.awayScore || {}
  };
}

export function parseWidgetEvents(html) {
  const match = String(html || "").match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match) throw new Error("Calendario SofaScore non riconosciuto");
  const parsed = JSON.parse(match[1]);
  const events = parsed?.props?.pageProps?.events;
  if (!Array.isArray(events)) throw new Error("Dati SofaScore non riconosciuti");
  return events;
}

export function statusType(event) {
  return String(event?.status?.type || "").toLowerCase();
}

export function scoreNumber(score, key = "current") {
  const value = Number(score?.[key]);
  return Number.isFinite(value) ? value : null;
}

export function scoreFingerprint(event) {
  const values = [
    scoreNumber(event?.homeScore),
    scoreNumber(event?.awayScore),
    scoreNumber(event?.homeScore, "normaltime"),
    scoreNumber(event?.awayScore, "normaltime")
  ];
  for (let period = 1; period <= 12; period += 1) {
    values.push(scoreNumber(event?.homeScore, `period${period}`));
    values.push(scoreNumber(event?.awayScore, `period${period}`));
  }
  values.push(scoreNumber(event?.homeScore, "overtime"));
  values.push(scoreNumber(event?.awayScore, "overtime"));
  return JSON.stringify(values);
}

export function hasFinalScore(event) {
  return scoreNumber(event?.homeScore) != null && scoreNumber(event?.awayScore) != null;
}

export function periodData(event) {
  const periods = [];
  for (let period = 1; period <= 12; period += 1) {
    const home = scoreNumber(event?.homeScore, `period${period}`);
    const away = scoreNumber(event?.awayScore, `period${period}`);
    if (home == null && away == null) break;
    if (home == null || away == null) return { periods, complete: false, coherent: false };
    periods.push([home, away]);
  }

  const regulation = periods.slice(0, 4);
  const regulationHome = regulation.reduce((sum, item) => sum + item[0], 0);
  const regulationAway = regulation.reduce((sum, item) => sum + item[1], 0);
  const normaltimeHome = scoreNumber(event?.homeScore, "normaltime");
  const normaltimeAway = scoreNumber(event?.awayScore, "normaltime");
  const finalHome = scoreNumber(event?.homeScore);
  const finalAway = scoreNumber(event?.awayScore);
  const overtimeHome = scoreNumber(event?.homeScore, "overtime") || 0;
  const overtimeAway = scoreNumber(event?.awayScore, "overtime") || 0;
  const extraPeriods = periods.slice(4);
  const extraHome = extraPeriods.reduce((sum, item) => sum + item[0], 0);
  const extraAway = extraPeriods.reduce((sum, item) => sum + item[1], 0);

  const regulationMatches = regulation.length === 4 &&
    (normaltimeHome == null || regulationHome === normaltimeHome) &&
    (normaltimeAway == null || regulationAway === normaltimeAway);
  const extraMatches = finalHome != null && finalAway != null && (
    extraPeriods.length
      ? regulationHome + extraHome === finalHome && regulationAway + extraAway === finalAway
      : regulationHome + overtimeHome === finalHome && regulationAway + overtimeAway === finalAway
  );

  return {
    periods,
    complete: regulation.length === 4,
    coherent: regulationMatches && extraMatches
  };
}

export function mergeManualOverride(event, override) {
  if (!override) return event;
  return {
    ...event,
    ...override,
    id: event.id,
    homeTeam: { ...event.homeTeam, ...(override.homeTeam || {}) },
    awayTeam: { ...event.awayTeam, ...(override.awayTeam || {}) },
    homeScore: { ...event.homeScore, ...(override.homeScore || {}) },
    awayScore: { ...event.awayScore, ...(override.awayScore || {}) },
    status: { ...event.status, ...(override.status || {}) },
    roundInfo: { ...event.roundInfo, ...(override.roundInfo || {}) }
  };
}

export function updateRecord(previous, event, nowIso, options = {}) {
  const now = Date.parse(nowIso);
  const finished = statusType(event) === "finished" && hasFinalScore(event);
  const fingerprint = scoreFingerprint(event);
  const record = previous ? { ...previous } : {};

  if (!finished) return record;

  if (!record.firstFinishedSeenAt) {
    record.firstFinishedSeenAt = nowIso;
    record.lastScoreChangedAt = nowIso;
  } else if (record.lastFingerprint && record.lastFingerprint !== fingerprint) {
    record.lastScoreChangedAt = nowIso;
    if (!record.manual) record.archivedAt = null;
  }

  record.lastFingerprint = fingerprint;
  record.lastVerifiedAt = nowIso;
  record.event = event;
  record.source = options.source || record.source || "SofaScore";
  const periods = periodData(event);
  record.periodsComplete = periods.complete && periods.coherent;
  record.needsPeriodRecovery = !record.periodsComplete;

  if (options.validatedHistoricalImport) {
    record.archivedAt = record.archivedAt || nowIso;
    record.importedValidatedAt = record.importedValidatedAt || nowIso;
  } else if (!record.archivedAt) {
    const stableSince = Math.max(
      Date.parse(record.firstFinishedSeenAt || nowIso),
      Date.parse(record.lastScoreChangedAt || nowIso)
    );
    if (now - stableSince >= STABILIZATION_MS) record.archivedAt = nowIso;
  }

  if (record.archivedAt && record.periodsComplete && !record.periodsCompletedAt) {
    record.periodsCompletedAt = nowIso;
  }
  if (options.archiveBlocked) {
    record.archiveBlocked = options.archiveBlocked;
    record.archivedAt = null;
  } else if (record.archiveBlocked) {
    delete record.archiveBlocked;
  }
  return record;
}

export function cacheWindow(events, records, nowMs = Date.now()) {
  const pendingStarts = events
    .filter((event) => statusType(event) === "notstarted")
    .map((event) => Number(event.startTimestamp) * 1000)
    .filter((start) => Number.isFinite(start) && start > 0);

  const live = events.some((event) => statusType(event) === "inprogress");
  const overdue = pendingStarts.some(
    (start) => start <= nowMs && start >= nowMs - 3 * 60 * 60_000
  );
  const imminent = pendingStarts.some(
    (start) => start > nowMs && start <= nowMs + 30 * 60_000
  );
  const upcoming = pendingStarts.some(
    (start) => start > nowMs && start <= nowMs + 2 * 60 * 60_000
  );
  const waitingForArchive = events.some((event) => {
    const record = records?.[String(event.id)];
    return statusType(event) === "finished" && !record?.archivedAt && !record?.archiveBlocked;
  });
  const incompleteArchive = Object.values(records || {}).some(
    (record) => (record.archivedAt && record.needsPeriodRecovery) || record.archiveBlocked
  );
  const allArchived = events.length > 0 && events.every(
    (event) => records?.[String(event.id)]?.archivedAt
  );

  let window;
  if (live) window = { ttlMs: 20_000, swrSeconds: 10, mode: "live" };
  // Lo stato SofaScore puo' restare "notstarted" dopo l'inizio effettivo:
  // non lasciare in cache per ore una gara che potrebbe essere live.
  else if (overdue) window = { ttlMs: 30_000, swrSeconds: 10, mode: "awaiting-live" };
  else if (imminent) window = { ttlMs: 60_000, swrSeconds: 20, mode: "imminent" };
  else if (waitingForArchive) window = { ttlMs: 2 * 60_000, swrSeconds: 60, mode: "stabilizing" };
  else if (upcoming) window = { ttlMs: 5 * 60_000, swrSeconds: 60, mode: "upcoming" };
  else if (incompleteArchive) window = { ttlMs: 12 * 60 * 60_000, swrSeconds: 3600, mode: "period-recovery" };
  else if (allArchived) window = { ttlMs: 24 * 60 * 60_000, swrSeconds: 604800, mode: "archived" };
  else window = { ttlMs: 30 * 60_000, swrSeconds: 1800, mode: "idle" };

  // Anche una cache lunga dedicata allo storico deve scadere prima
  // del prossimo incontro. Limita anche lo stale-while-revalidate del CDN.
  const nextStart = pendingStarts.filter((start) => start > nowMs)
    .reduce((nearest, start) => Math.min(nearest, start), Infinity);
  if (Number.isFinite(nextStart)) {
    const untilStart = nextStart - nowMs;
    window.ttlMs = Math.min(window.ttlMs, Math.max(15_000, untilStart - 120_000));
    window.swrSeconds = Math.min(
      window.swrSeconds,
      Math.max(0, Math.floor((untilStart - window.ttlMs - 60_000) / 1000))
    );
  }
  return window;
}

export function responseCacheControl(window) {
  const seconds = Math.max(1, Math.floor(window.ttlMs / 1000));
  return `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${window.swrSeconds}`;
}
