import fs from "node:fs";
import path from "node:path";

const apiRoot = path.resolve(new URL("..", import.meta.url).pathname);
const siteRoot = process.argv[2];
if (!siteRoot) throw new Error("Indicare la directory del progetto Sites");

const u19Path = path.join(siteRoot, "site/u19.json");
const rawU19 = fs.readFileSync(u19Path, "utf8");
const data = JSON.parse(rawU19);
const fixtures = data.groups.flatMap((group) =>
  group.matches.map((match) => ({ match, group: group.name }))
);

function tokens(value) {
  const aliases = {
    "UNA HOTELS REGGIO EMILIA": "Pall. Reggiana U19",
    "RAGGISOLARIS ACADEMY FAENZA": "Raggisolaris U19",
    "UMANA Spa REYER": "Reyer Venezia U19",
    "AMICI PALLACANESTRO UDINESE": "APU Udine U19",
    "VIRTUS PALL. BOLOGNA": "Virtus Bologna U19",
    "VIRTUS BK. PADOVA": "Virtus Basket Padova U19",
    "B.S.L. SAN LAZZARO": "BSL San Lazzaro U19"
  };
  const stop = new Set([
    "u19", "under", "19", "basket", "basketball", "pall", "pallacanestro",
    "bk", "bc", "asd", "ssd", "spa", "academy", "2004", "1958"
  ]);
  return String(aliases[value] || value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
    .filter((token) => token && !stop.has(token));
}

function similarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.length || !b.length) return 0;
  const shared = a.filter((token) => b.some((other) =>
    token === other || (token.length >= 5 && other.length >= 5 &&
      (token.startsWith(other) || other.startsWith(token)))
  )).length;
  return shared / Math.min(a.length, b.length);
}

function eventDate(timestamp) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(Number(timestamp) * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function findFixture(event, round) {
  const byId = fixtures.find(({ match }) =>
    match.sofascoreEventId != null && String(match.sofascoreEventId) === String(event.id)
  );
  if (byId) return byId;

  const date = eventDate(event.startTimestamp);
  const candidates = fixtures.filter(({ match }) => Number(match.round) === round && match.date === date)
    .map((entry) => ({
      entry,
      home: similarity(entry.match.home, event.homeTeam?.name),
      away: similarity(entry.match.away, event.awayTeam?.name)
    }))
    .filter((candidate) => candidate.home >= 0.34 && candidate.away >= 0.34)
    .sort((a, b) => (b.home + b.away) - (a.home + a.away));
  return candidates[0]?.entry || null;
}

function extractEvents(html) {
  const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error("__NEXT_DATA__ non trovato");
  return JSON.parse(match[1]).props.pageProps.events;
}

const validation = {};
const report = [];
const skipped = [];
const siteUpdates = [];

for (const round of [1, 2]) {
  const url = `https://widgets.sofascore.com/it/embed/unique-tournament/33926/season/102342/editorFixtures?showCompetitionLogo=true&widgetTheme=light&round=${round}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`SofaScore ${response.status} per G${round}`);
  const events = extractEvents(await response.text());
  const used = new Set();

  for (const event of events) {
    const found = findFixture(event, round);
    if (!found) {
      skipped.push({ round, id: event.id, reason: "fixture non abbinata" });
      continue;
    }
    if (used.has(found.match)) throw new Error(`Abbinamento duplicato per evento ${event.id} G${round}`);
    used.add(found.match);

    const home = Number(event.homeScore?.current);
    const away = Number(event.awayScore?.current);
    if (home !== Number(found.match.scoreHome) || away !== Number(found.match.scoreAway)) {
      skipped.push({
        round,
        id: event.id,
        fixture: `${found.match.home} - ${found.match.away}`,
        reason: `finale discordante: sito ${found.match.scoreHome}-${found.match.scoreAway}, feed ${home}-${away}`
      });
      continue;
    }

    const periods = [1, 2, 3, 4].map((period) => [
      event.homeScore?.[`period${period}`],
      event.awayScore?.[`period${period}`]
    ]);
    if (periods.some((period) => !period.every(Number.isFinite))) {
      throw new Error(`Parziali incompleti per evento ${event.id}`);
    }
    const regulationHome = periods.reduce((sum, period) => sum + period[0], 0);
    const regulationAway = periods.reduce((sum, period) => sum + period[1], 0);
    const overtime = [home - regulationHome, away - regulationAway];
    if (overtime[0] < 0 || overtime[1] < 0) {
      throw new Error(`Somma parziali incoerente per evento ${event.id}`);
    }

    validation[String(event.id)] = {
      round,
      group: found.group,
      home,
      away,
      periods,
      overtime: overtime[0] || overtime[1] ? overtime : null
    };

    if (round === 2) {
      siteUpdates.push({
        identity: {
          round: found.match.round,
          date: found.match.date,
          home: found.match.home,
          away: found.match.away
        },
        values: {
          sofascoreEventId: event.id,
          sofascoreHomeName: event.homeTeam?.name,
          sofascoreAwayName: event.awayTeam?.name,
          periods,
          ...(overtime[0] || overtime[1] ? { overtime } : {})
        }
      });
    }
  }
  report.push({ round, events: events.length, matched: used.size });
}

fs.writeFileSync(
  path.join(apiRoot, "data/historical-validation.js"),
  "// Importazione storica validata confrontando finali del sito e feed SofaScore.\n" +
  `export default ${JSON.stringify(validation, null, 2)};\n`
);
const conflicts = Object.fromEntries(skipped
  .filter((item) => item.id && /finale discordante/.test(item.reason))
  .map((item) => [String(item.id), item]));
fs.writeFileSync(
  path.join(apiRoot, "data/historical-conflicts.js"),
  "// Eventi storici non importati automaticamente per conflitto con un finale già verificato.\n" +
  `export default ${JSON.stringify(conflicts, null, 2)};\n`
);

function patchSiteJson(source, updates) {
  const spans = [];
  const startPattern = /\n( {8,})\{\n\1  "round":/g;
  let match;
  while ((match = startPattern.exec(source))) {
    const indent = match[1];
    const start = match.index + 1 + indent.length;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          spans.push({ start, end: index + 1, indent, value: JSON.parse(source.slice(start, index + 1)) });
          break;
        }
      }
    }
  }

  const patches = updates.flatMap((update) => {
    const span = spans.find(({ value }) =>
      Number(value.round) === Number(update.identity.round) &&
      value.date === update.identity.date &&
      value.home === update.identity.home &&
      value.away === update.identity.away
    );
    if (!span) throw new Error(`Oggetto partita non trovato: ${update.identity.home} - ${update.identity.away}`);
    if (String(span.value.sofascoreEventId || "") === String(update.values.sofascoreEventId)) return [];
    const additions = Object.entries(update.values).map(([key, value]) =>
      `${span.indent}  ${JSON.stringify(key)}: ${JSON.stringify(value)}`
    ).join(",\n");
    const closingLine = source.lastIndexOf(`\n${span.indent}`, span.end - 1);
    if (closingLine < span.start) throw new Error("Chiusura oggetto partita non riconosciuta");
    return [{ index: closingLine, text: `,\n${additions}` }];
  }).sort((a, b) => b.index - a.index);

  return patches.reduce(
    (result, patch) => result.slice(0, patch.index) + patch.text + result.slice(patch.index),
    source
  );
}

fs.writeFileSync(u19Path, patchSiteJson(rawU19, siteUpdates));
console.log(JSON.stringify({ report, validationEntries: Object.keys(validation).length, skipped }, null, 2));
