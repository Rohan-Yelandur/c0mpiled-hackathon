/**
 * Hospital routing algorithm — loads hospital data from CSV, scores per data_explanation.
 * getOptimalHospital(nlp_extracted_data, current_lat, current_lon) only; dataset path defined below.
 * For real ETAs set REACT_APP_GMAPS_API_KEY; otherwise uses CSV column ambulance_travel_time_min_sim.
 */

// Which dataset to load. For the browser, this path is fetched from the app origin (place CSV in public/).
const HOSPITAL_DATASET_PATH = "austin_hospitals_demo - austin_hospitals_demo.csv";

// Overlay when sendPatient() is called: bed deltas and specialist_patients increments per hospital.
const sentPatientOverlay = {}; // hospital_name -> { edBedsDelta, icuBedsDelta, specialistPatientsDelta: { Cardiology, Trauma, Neurology } }

const SPECIALTY_NAMES = ["Cardiology", "Trauma", "Neurology"];

/** Map NLP required_specialty to CSV specialty name for load calculation. */
function nlpSpecialtyToColumn(specialty) {
  const s = (specialty || "General").toLowerCase();
  if (s.includes("cardiac") || s.includes("stemi") || s.includes("heart")) return "Cardiology";
  if (s.includes("trauma")) return "Trauma";
  if (s.includes("stroke") || s.includes("neuro")) return "Neurology";
  return null;
}

function getRequiredSpecialtiesFromNlp(nlpData) {
  const specs = nlpData?.required_specialties;
  if (Array.isArray(specs)) return specs.map((s) => nlpSpecialtyToColumn(s)).filter(Boolean);
  const one = nlpSpecialtyToColumn(nlpData?.required_specialty);
  return one ? [one] : [];
}

/** Specialist load = (csv specialist_patients + overlay) / specialists. Null if no specialists. */
function getSpecialistLoad(row, specialty, hospitalName) {
  if (!specialty || !SPECIALTY_NAMES.includes(specialty)) return null;
  const colDoc = `specialists_${specialty}`;
  const colPat = `specialist_patients_${specialty}`;
  const numDoctors = num(row[colDoc]);
  if (numDoctors <= 0) return null;
  const csvPatients = num(row[colPat]);
  const overlay = sentPatientOverlay[hospitalName]?.specialistPatientsDelta ?? {};
  const patients = Math.max(0, csvPatients + (overlay[specialty] ?? 0));
  return patients / numDoctors;
}

function hasSpecialistFor(row, specialty, hospitalName) {
  return getSpecialistLoad(row, specialty, hospitalName) !== null;
}

let cachedHospitals = null;

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((s) => s.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(",").map((s) => s.trim());
    const row = {};
    header.forEach((h, j) => (row[h] = vals[j] ?? ""));
    rows.push(row);
  }
  return rows;
}

async function loadHospitalsFromDataset() {
  if (cachedHospitals) return cachedHospitals;
  const base = (typeof process !== "undefined" && process.env?.PUBLIC_URL) ? process.env.PUBLIC_URL : "";
  const url = (base + "/" + HOSPITAL_DATASET_PATH).replace(/\/+/g, "/");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load dataset: ${url}`);
  const text = await res.text();
  const rows = parseCsv(text);
  cachedHospitals = rows;
  return rows;
}

function hasTraumaCapability(traumaLevel) {
  if (!traumaLevel || traumaLevel === "N/A") return false;
  return /^I\b|^II\b|^III|^IV/i.test(traumaLevel);
}

function hasStrokeCapability(strokeLevel) {
  if (!strokeLevel) return false;
  const u = strokeLevel.toLowerCase();
  if (u.includes("none") && !u.includes("capable")) return false;
  return u.includes("primary") || u.includes("comprehensive") || u.includes("capable");
}

function hasCardiacCapability(cardiacCathLab) {
  return String(cardiacCathLab || "").toLowerCase() === "yes";
}

function hasPediatricCapability(pediatricSpecialty) {
  if (!pediatricSpecialty) return false;
  const u = pediatricSpecialty.toLowerCase();
  return u.includes("yes") || u.includes("limited") || u.includes("nicu");
}

function specialtyRequiresCapability(specialty) {
  const s = (specialty || "General").toLowerCase();
  if (s.includes("trauma")) return "trauma";
  if (s.includes("stroke")) return "stroke";
  if (s.includes("cardiac") || s.includes("stemi") || s.includes("heart")) return "cardiac";
  if (s.includes("pediatric") || s.includes("peds")) return "pediatric";
  return null;
}

function hospitalHasRequiredCapability(row, requiredCap) {
  if (!requiredCap) return true;
  switch (requiredCap) {
    case "trauma":
      return hasTraumaCapability(row.trauma_level);
    case "stroke":
      return hasStrokeCapability(row.stroke_center_level);
    case "cardiac":
      return hasCardiacCapability(row.cardiac_cath_lab);
    case "pediatric":
      return hasPediatricCapability(row.pediatric_specialty);
    default:
      return true;
  }
}

function applyHardFilters(rows, nlpData) {
  const acuity = Number(nlpData?.acuity_level) || 3;
  const requiredCap = specialtyRequiresCapability(nlpData?.required_specialty);
  const isCritical = acuity <= 2;

  return rows.filter((row) => {
    if (String(row.ed_diversion_sim || "").toLowerCase() === "yes") return false;
    if (!hospitalHasRequiredCapability(row, requiredCap)) return false;
    if (isCritical) {
      const icuAvail = num(row.available_icu_beds_sim) + (sentPatientOverlay[row.hospital_name]?.icuBedsDelta ?? 0);
      if (icuAvail <= 0) return false;
    }
    return true;
  });
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// Scoring: lower is better. Includes specialist load (patients/doctors) for required_specialty.
function scoreHospital(row, etaMinutes, nlpData) {
  const acuity = Number(nlpData?.acuity_level) || 3;
  const travelWeight = 1.0;
  const waitWeight = 0.5;
  const capacityWeight = 2.0;
  const staffWeight = 0.3;
  const specialistLoadWeight = 20; // higher load = higher score (worse)
  const noSpecialistPenalty = 500;

  const erWait = num(row.er_wait_min_sim);
  const edBedsRaw = num(row.available_ed_beds_sim);
  const overlay = sentPatientOverlay[row.hospital_name] || {};
  const availableEdBeds = Math.max(0, edBedsRaw + (overlay.edBedsDelta ?? 0));
  const physicians = num(row.on_call_ed_physicians_sim);
  const icuAvail = Math.max(0, num(row.available_icu_beds_sim) + (overlay.icuBedsDelta ?? 0));

  let score = travelWeight * etaMinutes + waitWeight * erWait;
  score -= capacityWeight * availableEdBeds;
  score -= staffWeight * physicians;
  if (acuity <= 2 && icuAvail <= 1) score += 50;

  const requiredSpecialty = nlpSpecialtyToColumn(nlpData?.required_specialty);
  if (requiredSpecialty) {
    const load = getSpecialistLoad(row, requiredSpecialty, row.hospital_name);
    if (load == null) {
      if (acuity <= 2) score += noSpecialistPenalty;
    } else {
      score += specialistLoadWeight * load;
    }
  }
  return score;
}

async function fetchEtasFromMatrix(originLat, originLon, hospitals) {
  const apiKey = typeof process !== "undefined" && process.env?.REACT_APP_GMAPS_API_KEY;
  if (!apiKey) return null; // caller will use CSV column

  const origin = `${originLat},${originLon}`;
  const destinations = hospitals.map((h) => `${h.latitude},${h.longitude}`).join("|");
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destinations)}&departure_time=now&key=${apiKey}`;

  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    const response = await res.json();
    const etas = {};
    if (response?.status === "OK" && response?.rows?.[0]) {
      const elements = response.rows[0].elements;
      hospitals.forEach((h, i) => {
        const elem = elements[i];
        if (elem?.status === "OK") {
          const duration = elem.duration_in_traffic ?? elem.duration;
          etas[h.hospital_name] = duration ? duration.value / 60 : 999;
        } else etas[h.hospital_name] = 999;
      });
    } else hospitals.forEach((h) => (etas[h.hospital_name] = 999));
    return etas;
  } catch {
    return null;
  }
}

/**
 * Get the best hospital. Loads dataset from HOSPITAL_DATASET_PATH, applies hard filters, then scores (lowest = best).
 * @param {Object} nlpExtractedData - e.g. { acuity_level, required_specialty }
 * @param {number} currentLat
 * @param {number} currentLon
 * @returns {Promise<{hospital_id, hospital_name, routing_score, eta_minutes, ...}|null>}
 */
export async function getOptimalHospital(nlpExtractedData, currentLat, currentLon) {
  const allRows = await loadHospitalsFromDataset();
  const filtered = applyHardFilters(allRows, nlpExtractedData);
  if (filtered.length === 0) return null;

  const etasFromApi = await fetchEtasFromMatrix(currentLat, currentLon, filtered);
  const useCsvTravel = etasFromApi == null;

  const scored = filtered.map((row) => {
    const etaMinutes = useCsvTravel ? num(row.ambulance_travel_time_min_sim) : (etasFromApi[row.hospital_name] ?? 999);
    const score = scoreHospital(row, etaMinutes, nlpExtractedData);
    return { row, score, etaMinutes };
  });
  scored.sort((a, b) => a.score - b.score);
  const best = scored[0];
  const r = best.row;

  const requiredSpecialty = nlpSpecialtyToColumn(nlpExtractedData?.required_specialty);
  const specialist_load = requiredSpecialty
    ? getSpecialistLoad(r, requiredSpecialty, r.hospital_name)
    : null;
  const specialist_ready = requiredSpecialty ? hasSpecialistFor(r, requiredSpecialty, r.hospital_name) : true;

  return {
    hospital_id: r.hospital_name,
    hospital_name: r.hospital_name,
    routing_score: Math.round(best.score * 100) / 100,
    eta_minutes: Math.round(best.etaMinutes * 10) / 10,
    latitude: num(r.latitude),
    longitude: num(r.longitude),
    available_ed_beds: num(r.available_ed_beds_sim),
    available_icu_beds: num(r.available_icu_beds_sim),
    er_wait_min: num(r.er_wait_min_sim),
    trauma_level: r.trauma_level,
    stroke_center_level: r.stroke_center_level,
    cardiac_cath_lab: r.cardiac_cath_lab,
    specialist_ready,
    specialist_load: specialist_load != null ? Math.round(specialist_load * 100) / 100 : null,
  };
}

/**
 * Record a patient sent to this hospital. Reduces ED/ICU in overlay and increments specialist_patients
 * for each required specialty so future routing sees higher specialist load.
 * @param {string} hospitalId - hospital_name from getOptimalHospital result
 * @param {Object} nlpData - e.g. { acuity_level, required_specialty } or { required_specialties }
 */
export function sendPatient(hospitalId, nlpData) {
  if (!hospitalId) return;
  const acuity = Number(nlpData?.acuity_level) ?? 3;
  sentPatientOverlay[hospitalId] = sentPatientOverlay[hospitalId] || {
    edBedsDelta: 0,
    icuBedsDelta: 0,
    specialistPatientsDelta: {},
  };
  sentPatientOverlay[hospitalId].edBedsDelta -= 1;
  if (acuity <= 2) sentPatientOverlay[hospitalId].icuBedsDelta -= 1;
  for (const specialty of getRequiredSpecialtiesFromNlp(nlpData)) {
    if (!specialty) continue;
    const delta = sentPatientOverlay[hospitalId].specialistPatientsDelta;
    delta[specialty] = (delta[specialty] ?? 0) + 1;
  }
}
