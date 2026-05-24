/** ICAO airline designator → display name (Sydney / common overflights). */
export const AIRLINE_BY_ICAO = {
  QFA: "Qantas",
  QLK: "QantasLink",
  QJE: "QantasLink",
  VOZ: "Virgin Australia",
  JST: "Jetstar",
  RXA: "Regional Express",
  SIA: "Singapore Airlines",
  THA: "Thai Airways",
  UAE: "Emirates",
  QTR: "Qatar Airways",
  ANZ: "Air New Zealand",
  CPA: "Cathay Pacific",
  JAL: "Japan Airlines",
  ANA: "All Nippon Airways",
  KAL: "Korean Air",
  AAR: "Asiana",
  CSN: "China Southern",
  CES: "China Eastern",
  CCA: "Air China",
  CHH: "Hainan Airlines",
  MXD: "Batik Air Malaysia",
  MAS: "Malaysia Airlines",
  GIA: "Garuda Indonesia",
  ETH: "Ethiopian Airlines",
  ETD: "Etihad Airways",
  DLH: "Lufthansa",
  BAW: "British Airways",
  AFR: "Air France",
  KLM: "KLM",
  UAL: "United Airlines",
  DAL: "Delta Air Lines",
  AAL: "American Airlines",
  FJI: "Fiji Airways",
  PAL: "Philippine Airlines",
  VNL: "Vincent Aviation",
  PBN: "Virgin Australia Regional",
  NWK: "Network Aviation",
  UTY: "Alliance Airlines",
  TFX: "Toll Aviation",
  SWI: "Swiftair",
  FDX: "FedEx",
  UPS: "UPS",
  DHL: "DHL",
};

export function airlineFromCallsign(callsign) {
  const cs = (callsign || "").trim().toUpperCase();
  const match = cs.match(/^([A-Z]{3})\d/);
  if (match) return AIRLINE_BY_ICAO[match[1]] || null;
  const loose = cs.match(/^([A-Z]{3})/);
  if (loose) return AIRLINE_BY_ICAO[loose[1]] || null;
  return null;
}

export function airlineFromMetadata(meta) {
  const raw = meta?.operator || meta?.owner || meta?.operatorcallsign;
  if (!raw || typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  return name || null;
}
