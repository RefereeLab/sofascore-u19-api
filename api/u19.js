export default async function handler(request, response) {
  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  return response.status(200).json({
    source: "Sincronizzazione SofaScore temporaneamente disattivata",
    disabled: true,
    updatedAt: new Date().toISOString(),
    events: [
      {
        id: "sync-disabled",
        startTimestamp: null,
        status: { type: "notstarted", description: "Disabled" },
        tournamentName: "",
        roundInfo: {},
        homeTeam: { id: null, name: "" },
        awayTeam: { id: null, name: "" },
        homeScore: {},
        awayScore: {}
      }
    ]
  });
}
