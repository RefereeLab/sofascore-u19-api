// Correzioni ufficiali/manuali, indicizzate per ID SofaScore.
// I campi presenti qui prevalgono sempre sui dati automatici e archiviati.
// I valori null rimuovono dal payload pubblico i parziali SofaScore discordanti,
// lasciando intatto il finale verificato già presente nel calendario del sito.
export default {
  "17003254": {
    status: { type: "finished", code: 100, description: "Terminata" },
    homeScore: {
      current: 58,
      normaltime: null,
      overtime: null,
      period1: null,
      period2: null,
      period3: null,
      period4: null
    },
    awayScore: {
      current: 78,
      normaltime: null,
      overtime: null,
      period1: null,
      period2: null,
      period3: null,
      period4: null
    }
  }
};
