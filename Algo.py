import os
import requests

# Live hospital state: only specialties that exist are stored.
# specialists: count of doctors per type. specialist_patients: current patient count per type.
# Load = specialist_patients[type] / specialists[type] (computed when needed).
live_hospital_state = {
    "Hosp_General": {
        "bed_capacity": 0.85,
        "specialists": {"Cardiology": 2, "Trauma": 1},  # no Neurology
        "specialist_patients": {"Cardiology": 3, "Trauma": 0},
    },
    "Hosp_TraumaOne": {
        "bed_capacity": 0.98,
        "specialists": {"Cardiology": 1, "Neurology": 1, "Trauma": 2},
        "specialist_patients": {"Cardiology": 0, "Neurology": 1, "Trauma": 5},
    },
}

class Patient:
    def __init__(self, nlp_data, location):
        self._nlp_data = nlp_data
        self.acuity = nlp_data.get("acuity_level", 3)
        self.specialty_needed = nlp_data.get("required_specialty", "General")
        self.location = location

    def get_required_specialties(self):
        """All specialty types this patient needs (for send_patient: increment load for each)."""
        specs = self._nlp_data.get("required_specialties")
        return list(specs) if specs else [self.specialty_needed]

class Hospital:
    def __init__(self, id, location, is_trauma_center):
        self.id = id
        self.location = location  # (lat, lon) tuple
        self.is_trauma_center = is_trauma_center

    @property
    def lat(self):
        return self.location[0]

    @property
    def lon(self):
        return self.location[1]

    def get_live_capacity(self):
        # Queries the mock live state
        return live_hospital_state[self.id]["bed_capacity"]
        
    def is_specialist_available(self, required_specialty):
        if required_specialty == "General":
            return True
        return required_specialty in live_hospital_state[self.id].get("specialists", {})

    def get_specialist_load(self, required_specialty):
        """
        Load = patients / specialists for that type. None if specialty not present.
        """
        if required_specialty == "General":
            return 0
        state = live_hospital_state[self.id]
        specialists = state.get("specialists", {})
        if required_specialty not in specialists or specialists[required_specialty] <= 0:
            return None
        num_doctors = specialists[required_specialty]
        num_patients = state.get("specialist_patients", {}).get(required_specialty, 0)
        return num_patients / num_doctors


def send_patient(hospital_id, patient):
    """
    Record that a patient was sent to this hospital. Increments specialist_patients
    for each specialty type the patient requires (only for types this hospital has).
    Call this after routing so load reflects the new patient for future routing.
    """
    if hospital_id not in live_hospital_state:
        return
    state = live_hospital_state[hospital_id]
    state.setdefault("specialist_patients", {})
    for specialty in patient.get_required_specialties():
        if specialty == "General":
            continue
        if specialty in state.get("specialists", {}):
            state["specialist_patients"][specialty] = state["specialist_patients"].get(specialty, 0) + 1


def score_hospital(patient, hospital, eta):
    # Base checks
    if patient.acuity == 1 and eta > 30: 
        return -9999
        
    urgency_multiplier = 6 - patient.acuity 
    weight_distance = urgency_multiplier ** 3 
    weight_capacity = (patient.acuity ** 2) * 10 
    
    score_distance = 100 / (eta + 1) 
    # Notice we invert capacity so lower % full = higher score
    score_capacity = (1.0 - hospital.get_live_capacity()) * 100 
    
    # --- Real-Time Specialist Check (analog: doctor stress / load) ---
    score_specialty = 0
    load = hospital.get_specialist_load(patient.specialty_needed)

    if load is None:
        # Specialty not on call: heavy penalty for critical patients
        if patient.acuity <= 2:
            score_specialty = -5000
    else:
        # On call: analog bonus that decays with current patient load
        # score = 5000 / (1 + load) → 0 patients → 5000, 1 → 2500, 2 → 1667, 5 → 833, etc.
        score_specialty = 5000.0 / (1.0 + load)

    total_score = (weight_distance * score_distance) + \
                  (weight_capacity * score_capacity) + \
                  score_specialty
                  
    return total_score


def fetch_etas_from_matrix(origin_lat, origin_lon, hospitals):
    """
    Makes a SINGLE call to the Google Maps Distance Matrix API
    for 1 origin and N destinations to prevent UI freezing.
    Requires GMAPS_API_KEY in the environment.
    """
    api_key = os.getenv("GMAPS_API_KEY")
    if not api_key:
        # No API key: return fallback ETAs (e.g. 999) so scoring still runs
        return {h.id: 999 for h in hospitals}

    origin = f"{origin_lat},{origin_lon}"
    destinations = "|".join([f"{h.lat},{h.lon}" for h in hospitals])

    url = (
        "https://maps.googleapis.com/maps/api/distancematrix/json"
        f"?origins={origin}&destinations={destinations}&departure_time=now&key={api_key}"
    )

    try:
        response = requests.get(url, timeout=10).json()
    except (requests.RequestException, ValueError):
        return {h.id: 999 for h in hospitals}

    etas = {}
    if response.get("status") == "OK" and response.get("rows"):
        elements = response["rows"][0]["elements"]
        for i, hospital in enumerate(hospitals):
            if i >= len(elements):
                etas[hospital.id] = 999
                continue
            elem = elements[i]
            if elem.get("status") == "OK":
                # Prefer duration_in_traffic; fallback to duration (e.g. when traffic unavailable)
                duration = elem.get("duration_in_traffic") or elem.get("duration")
                etas[hospital.id] = (duration["value"] / 60) if duration else 999
            else:
                etas[hospital.id] = 999
    else:
        etas = {h.id: 999 for h in hospitals}

    return etas


def get_optimal_hospital(nlp_extracted_data, current_lat, current_lon, hospital_dataset):
    """
    UI-facing function: given a patient (from NLP data), current location, and
    hospital list, returns the optimal hospital using live ETAs and capacity/specialist scoring.
    """
    if not hospital_dataset:
        return None

    patient = Patient(nlp_extracted_data, (current_lat, current_lon))
    etas = fetch_etas_from_matrix(current_lat, current_lon, hospital_dataset)

    scored_hospitals = []
    for hospital in hospital_dataset:
        eta = etas.get(hospital.id, 999)
        score = score_hospital(patient, hospital, eta)
        scored_hospitals.append((score, hospital, eta))

    scored_hospitals.sort(key=lambda x: x[0], reverse=True)
    best_score, best_hospital, best_eta = scored_hospitals[0]

    load = best_hospital.get_specialist_load(patient.specialty_needed)
    return {
        "hospital_id": best_hospital.id,
        "routing_score": round(best_score, 2),
        "eta_minutes": round(best_eta, 1),
        "live_capacity": best_hospital.get_live_capacity(),
        "specialist_ready": best_hospital.is_specialist_available(patient.specialty_needed),
        "specialist_load": load if load is not None else None,  # patients per specialist (analog stress)
    }