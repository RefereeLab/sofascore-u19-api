import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const WIDGET_URL =
  "https://widgets.sofascore.com/it/embed/unique-tournament/33926/season/102342/editorFixtures?showCompetitionLogo=true&widgetTheme=light";

function normalizeTeamName(team) {
  const id = team?.id;
  const original = team?.name || team?.shortName || "";

  if (id === 1211259) return "UNA HOTELS REGGIO EMILIA";
  if (id === 1211255) return "RAGGISOLARIS ACADEMY FAEN";

  return original;
}

function compactEvent(event) {
  return {
    id: event.id,
    startTimestamp: event.startTimestamp,
    status: event.status || {},
    tournamentName: event.tournament?.name || "",
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

export default async function handler(request, response) {
  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");

  let browser;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 1200 },
      executablePath: await chromium.executablePath(),
      headless: "shell"
    });

    const page = await browser.newPage();

    await page.setCacheEnabled(false);

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
    );

    await page.setExtraHTTPHeaders({
      "accept-language": "it-IT,it;q=0.9,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache"
    });

    const url = new URL(WIDGET_URL);
    url.searchParams.set("_ts", Date.now().toString());

    await page.goto(url.toString(), {
      waitUntil: "networkidle2",
      timeout: 45000
    });

    await page.waitForSelector("#__NEXT_DATA__", {
      timeout: 15000
    });

    const events = await page.$eval("#__NEXT_DATA__", (element) => {
      const parsed = JSON.parse(element.textContent || "{}");
      return parsed?.props?.pageProps?.events || [];
    });

    const activeEvents = events
      .filter(
        (event) =>
          String(event?.status?.type || "").toLowerCase() !== "notstarted"
      )
      .map(compactEvent);

    if (!activeEvents.length) {
      throw new Error("Nessuna partita iniziata trovata");
    }

    const payload = {
      source: "SofaScore · browser automatico · no cache",
      tournamentId: 33926,
      seasonId: 102342,
      updatedAt: new Date().toISOString(),
      events: activeEvents
    };

    return response.status(200).json(payload);

  } catch (error) {
    console.error("SofaScore bridge error", error);

    return response.status(502).json({
      source: "SofaScore · browser automatico",
      updatedAt: new Date().toISOString(),
      error:
        error instanceof Error
          ? error.message
          : "Dati temporaneamente non disponibili"
    });

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
