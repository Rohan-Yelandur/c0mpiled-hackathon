"""
Hospital routing algorithm — loads hospital data from CSV, scores per data_explanation.
get_optimal_hospital(nlp_extracted_data, current_lat, current_lon) only; dataset path defined below.
"""
import os
import csv
import requests

# Which dataset to load (path relative to this file's directory or cwd).
HOSPITAL_DATASET_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "austin_hospitals_demo - austin_hospitals_demo.csv",
)

# Overlay when send_patient() is called: bed deltas and specialist_patients increments per hospital.
_sent_patient_overlay = {}  # hospital_name -> {"ed_beds_delta", "icu_beds_delta", "specialist_patients_delta": { specialty: int }}

SPECIALTY_NAMES = ("Cardiology", "Trauma", "Neurology")


def _nlp_specialty_to_column(specialty):
    """Map NLP required_specialty to CSV specialty name for load calculation."""
    if not specialty or (specialty or "").lower() == "general":
        return None
    s = specialty.lower()
    if "cardiac" in s or "stemi" in s or "heart" in s:
        return "Cardiology"
    if "trauma" in s:
        return "Trauma"
    if "stroke" in s or "neuro" in s:
        return "Neurology"
    return None


def _get_required_specialties_from_nlp(nlp_data):
    specs = nlp_data.get("required_specialties")
    if isinstance(specs, (list, tuple)):
        return [s for s in (_nlp_specialty_to_column(x) for x in specs) if s]
    one = _nlp_specialty_to_column(nlp_data.get("required_specialty"))
    return [one] if one else []


def _get_specialist_load(row, specialty, hospital_name):
    """Specialist load = (csv specialist_patients + overlay) / specialists. None if no specialists."""
    if not specialty or specialty not in SPECIALTY_NAMES:
        return None
    col_doc = f"specialists_{specialty}"
    col_pat = f"specialist_patients_{specialty}"
    num_doctors = _num(row.get(col_doc))
    if num_doctors <= 0:
        return None
    csv_patients = _num(row.get(col_pat))
    overlay = _sent_patient_overlay.get(hospital_name, {}).get("specialist_patients_delta", {})
    patients = max(0, csv_patients + overlay.get(specialty, 0))
    return patients / num_doctors


def _has_specialist_for(row, specialty, hospital_name):
    return _get_specialist_load(row, specialty, hospital_name) is not None

_cached_hospitals = None


def _load_hospitals_from_dataset():
    global _cached_hospitals
    if _cached_hospitals is not None:
        return _cached_hospitals
    if not os.path.isfile(HOSPITAL_DATASET_PATH):
        raise FileNotFoundError(f"Hospital dataset not found: {HOSPITAL_DATASET_PATH}")
    with open(HOSPITAL_DATASET_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        _cached_hospitals = list(reader)
    return _cached_hospitals


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _has_trauma_capability(trauma_level):
    if not trauma_level or trauma_level == "N/A":
        return False
    return trauma_level.upper().startswith("I")  # I, II, III, IV


def _has_stroke_capability(stroke_level):
    if not stroke_level:
        return False
    u = stroke_level.lower()
    if "none" in u and "capable" not in u:
        return False
    return "primary" in u or "comprehensive" in u or "capable" in u


def _has_cardiac_capability(cardiac_cath_lab):
    return (cardiac_cath_lab or "").strip().lower() == "yes"


def _has_pediatric_capability(pediatric_specialty):
    if not pediatric_specialty:
        return False
    u = pediatric_specialty.lower()
    return "yes" in u or "limited" in u or "nicu" in u


def _specialty_requires_capability(specialty):
    if not specialty or (specialty or "").lower() == "general":
        return None
    s = specialty.lower()
    if "trauma" in s:
        return "trauma"
    if "stroke" in s:
        return "stroke"
    if "cardiac" in s or "stemi" in s or "heart" in s:
        return "cardiac"
    if "pediatric" in s or "peds" in s:
        return "pediatric"
    return None


def _hospital_has_required_capability(row, required_cap):
    if not required_cap:
        return True
    if required_cap == "trauma":
        return _has_trauma_capability(row.get("trauma_level"))
    if required_cap == "stroke":
        return _has_stroke_capability(row.get("stroke_center_level"))
    if required_cap == "cardiac":
        return _has_cardiac_capability(row.get("cardiac_cath_lab"))
    if required_cap == "pediatric":
        return _has_pediatric_capability(row.get("pediatric_specialty"))
    return True


def _apply_hard_filters(rows, nlp_data):
    acuity = int(nlp_data.get("acuity_level", 3))
    required_cap = _specialty_requires_capability(nlp_data.get("required_specialty"))
    is_critical = acuity <= 2
    out = []
    for row in rows:
        if (row.get("ed_diversion_sim") or "").strip().lower() == "yes":
            continue
        if not _hospital_has_required_capability(row, required_cap):
            continue
        if is_critical:
            icu_avail = _num(row.get("available_icu_beds_sim"))
            overlay = _sent_patient_overlay.get(row["hospital_name"], {})
            icu_avail += overlay.get("icu_beds_delta", 0)
            if icu_avail <= 0:
                continue
        out.append(row)
    return out


def _score_hospital(row, eta_minutes, nlp_data):
    """Lower score = better. Includes specialist load (patients/doctors) for required_specialty."""
    acuity = int(nlp_data.get("acuity_level", 3))
    travel_weight = 1.0
    wait_weight = 0.5
    capacity_weight = 2.0
    staff_weight = 0.3
    specialist_load_weight = 20
    no_specialist_penalty = 500

    er_wait = _num(row.get("er_wait_min_sim"))
    ed_beds_raw = _num(row.get("available_ed_beds_sim"))
    overlay = _sent_patient_overlay.get(row["hospital_name"], {})
    available_ed_beds = max(0, ed_beds_raw + overlay.get("ed_beds_delta", 0))
    physicians = _num(row.get("on_call_ed_physicians_sim"))
    icu_avail = max(0, _num(row.get("available_icu_beds_sim")) + overlay.get("icu_beds_delta", 0))

    score = travel_weight * eta_minutes + wait_weight * er_wait
    score -= capacity_weight * available_ed_beds
    score -= staff_weight * physicians
    if acuity <= 2 and icu_avail <= 1:
        score += 50

    required_specialty = _nlp_specialty_to_column(nlp_data.get("required_specialty"))
    if required_specialty:
        load = _get_specialist_load(row, required_specialty, row["hospital_name"])
        if load is None:
            if acuity <= 2:
                score += no_specialist_penalty
        else:
            score += specialist_load_weight * load
    return score


def fetch_etas_from_matrix(origin_lat, origin_lon, rows):
    """One call to Google Distance Matrix; returns dict hospital_name -> eta minutes."""
    api_key = os.getenv("GMAPS_API_KEY")
    if not api_key:
        return None
    origin = f"{origin_lat},{origin_lon}"
    destinations = "|".join([f"{r['latitude']},{r['longitude']}" for r in rows])
    url = (
        "https://maps.googleapis.com/maps/api/distancematrix/json"
        f"?origins={origin}&destinations={destinations}&departure_time=now&key={api_key}"
    )
    try:
        response = requests.get(url, timeout=10).json()
    except (requests.RequestException, ValueError):
        return None
    etas = {}
    if response.get("status") == "OK" and response.get("rows"):
        elements = response["rows"][0]["elements"]
        for i, row in enumerate(rows):
            name = row["hospital_name"]
            if i < len(elements) and elements[i].get("status") == "OK":
                d = elements[i].get("duration_in_traffic") or elements[i].get("duration")
                etas[name] = (d["value"] / 60) if d else 999
            else:
                etas[name] = 999
    else:
        for row in rows:
            etas[row["hospital_name"]] = 999
    return etas


def get_optimal_hospital(nlp_extracted_data, current_lat, current_lon):
    """
    Load dataset from HOSPITAL_DATASET_PATH, apply hard filters, score (lowest = best).
    Returns best hospital dict or None. No hospital list argument — data comes from CSV.
    """
    all_rows = _load_hospitals_from_dataset()
    filtered = _apply_hard_filters(all_rows, nlp_extracted_data)
    if not filtered:
        return None

    etas_from_api = fetch_etas_from_matrix(current_lat, current_lon, filtered)
    use_csv_travel = etas_from_api is None

    scored = []
    for row in filtered:
        if use_csv_travel:
            eta_min = _num(row.get("ambulance_travel_time_min_sim"))
        else:
            eta_min = etas_from_api.get(row["hospital_name"], 999)
        score = _score_hospital(row, eta_min, nlp_extracted_data)
        scored.append((score, row, eta_min))
    scored.sort(key=lambda x: x[0])
    best_score, best_row, best_eta = scored[0]

    required_specialty = _nlp_specialty_to_column(nlp_extracted_data.get("required_specialty"))
    specialist_load = (
        _get_specialist_load(best_row, required_specialty, best_row["hospital_name"])
        if required_specialty
        else None
    )
    specialist_ready = (
        _has_specialist_for(best_row, required_specialty, best_row["hospital_name"])
        if required_specialty
        else True
    )

    return {
        "hospital_id": best_row["hospital_name"],
        "hospital_name": best_row["hospital_name"],
        "routing_score": round(best_score, 2),
        "eta_minutes": round(best_eta, 1),
        "latitude": _num(best_row.get("latitude")),
        "longitude": _num(best_row.get("longitude")),
        "available_ed_beds": _num(best_row.get("available_ed_beds_sim")),
        "available_icu_beds": _num(best_row.get("available_icu_beds_sim")),
        "er_wait_min": _num(best_row.get("er_wait_min_sim")),
        "trauma_level": best_row.get("trauma_level"),
        "stroke_center_level": best_row.get("stroke_center_level"),
        "cardiac_cath_lab": best_row.get("cardiac_cath_lab"),
        "specialist_ready": specialist_ready,
        "specialist_load": round(specialist_load, 2) if specialist_load is not None else None,
    }


def send_patient(hospital_id, nlp_data):
    """
    Record a patient sent to this hospital. Reduces ED/ICU in overlay and increments
    specialist_patients for each required specialty so future routing sees higher specialist load.
    """
    if not hospital_id:
        return
    _sent_patient_overlay.setdefault(
        hospital_id,
        {"ed_beds_delta": 0, "icu_beds_delta": 0, "specialist_patients_delta": {}},
    )
    _sent_patient_overlay[hospital_id]["ed_beds_delta"] -= 1
    acuity = int(nlp_data.get("acuity_level", 3))
    if acuity <= 2:
        _sent_patient_overlay[hospital_id]["icu_beds_delta"] -= 1
    delta = _sent_patient_overlay[hospital_id]["specialist_patients_delta"]
    for specialty in _get_required_specialties_from_nlp(nlp_data):
        delta[specialty] = delta.get(specialty, 0) + 1
