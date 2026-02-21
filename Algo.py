import os
import requests

# Mock API representing the live, real-time state of hospital on-call rosters
# Your hackathon UI can toggle these values to demonstrate dynamic routing
live_hospital_state = {
    "Hosp_General": {
        "bed_capacity": 0.85, # 85% full
        "on_call_specialists": {"Cardiology": True, "Neurology": False, "Trauma": False}
    },
    "Hosp_TraumaOne": {
        "bed_capacity": 0.98, # 98% full (crowded)
        "on_call_specialists": {"Cardiology": True, "Neurology": True, "Trauma": True}
    }
}

class Patient:
    def __init__(self, nlp_data, location):
        self.acuity = nlp_data.get('acuity_level', 3)
        self.specialty_needed = nlp_data.get('required_specialty', 'General')
        self.location = location

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
        # Queries the mock live state for specific doctor availability
        if required_specialty == 'General':
            return True
        return live_hospital_state[self.id]["on_call_specialists"].get(required_specialty, False)

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
    
    # --- The Real-Time Specialist Check ---
    score_specialty = 0
    specialist_ready = hospital.is_specialist_available(patient.specialty_needed)
    
    if specialist_ready:
        score_specialty = 5000 # The most critical factor: the doctor is there and ready
    elif patient.acuity <= 2:
        # If the patient is critical and the specialist IS NOT there, 
        # heavily penalize the hospital so they aren't routed there.
        score_specialty = -5000 
        
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

    return {
        "hospital_id": best_hospital.id,
        "routing_score": round(best_score, 2),
        "eta_minutes": round(best_eta, 1),
        "live_capacity": best_hospital.get_live_capacity(),
        "specialist_ready": best_hospital.is_specialist_available(patient.specialty_needed),
    }