/**
 * ICAO type designator → display name & typical max passenger capacity.
 * Estimates when OpenSky metadata is missing (not exact per airframe).
 */
export const TYPE_INFO = {
  A20N: { name: "A320neo", capacity: 180 },
  A21N: { name: "A321neo", capacity: 244 },
  A319: { name: "A319", capacity: 156 },
  A320: { name: "A320", capacity: 180 },
  A321: { name: "A321", capacity: 220 },
  A332: { name: "A330-200", capacity: 293 },
  A333: { name: "A330-300", capacity: 335 },
  A359: { name: "A350-900", capacity: 325 },
  A388: { name: "A380", capacity: 525 },
  B38M: { name: "B737 MAX 8", capacity: 189 },
  B39M: { name: "B737 MAX 9", capacity: 220 },
  B737: { name: "B737", capacity: 189 },
  B738: { name: "B737-800", capacity: 189 },
  B739: { name: "B737-900", capacity: 220 },
  B744: { name: "B747-400", capacity: 416 },
  B748: { name: "B747-8", capacity: 467 },
  B752: { name: "B757-200", capacity: 239 },
  B763: { name: "B767-300", capacity: 269 },
  B772: { name: "B777-200", capacity: 317 },
  B77W: { name: "B777-300ER", capacity: 396 },
  B788: { name: "B787-8", capacity: 242 },
  B789: { name: "B787-9", capacity: 296 },
  B78X: { name: "B787-10", capacity: 330 },
  E170: { name: "E170", capacity: 78 },
  E190: { name: "E190", capacity: 114 },
  E195: { name: "E195", capacity: 132 },
  DH8D: { name: "Dash 8 Q400", capacity: 78 },
  DH8C: { name: "Dash 8 Q300", capacity: 50 },
  AT76: { name: "ATR 72", capacity: 78 },
  AT75: { name: "ATR 72", capacity: 72 },
  C172: { name: "Cessna 172", capacity: 4 },
  C208: { name: "Caravan", capacity: 14 },
  GLF5: { name: "Gulfstream G550", capacity: 19 },
  A339: { name: "A330-900", capacity: 287 },
  A35K: { name: "A350-1000", capacity: 366 },
};

const CATEGORY_LABELS = {
  1: "LIGHT ACFT",
  2: "SMALL ACFT",
  3: "LARGE ACFT",
  4: "HIGH VORTEX",
  5: "HEAVY",
  6: "HIGH PERF",
  7: "ROTORCRAFT",
  8: "GLIDER",
  9: "LIGHTER-THAN-AIR",
  10: "PARACHUTE",
  11: "ULTRALIGHT",
  12: "UAV",
  13: "SPACE",
  14: "SURFACE",
  15: "SURFACE",
  16: "OBSTACLE",
};

export function categoryLabel(category) {
  if (category == null || category === 0) return null;
  return CATEGORY_LABELS[category] || "AIRCRAFT";
}

export function resolveTypeInfo(typecode, model, category) {
  const code = (typecode || "").trim().toUpperCase();
  if (code && TYPE_INFO[code]) {
    return { typeCode: code, typeName: TYPE_INFO[code].name, capacity: TYPE_INFO[code].capacity };
  }
  if (model) {
    const m = model.trim();
    const upper = m.toUpperCase();
    for (const [key, info] of Object.entries(TYPE_INFO)) {
      if (upper.includes(key) || upper.includes(info.name.toUpperCase())) {
        return { typeCode: key, typeName: info.name, capacity: info.capacity };
      }
    }
    return { typeCode: code || null, typeName: m, capacity: null };
  }
  if (code) {
    return { typeCode: code, typeName: code, capacity: null };
  }
  const cat = categoryLabel(category);
  if (cat) return { typeCode: null, typeName: cat, capacity: null };
  return { typeCode: null, typeName: null, capacity: null };
}
