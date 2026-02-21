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
        self.location = location
        self.is_trauma_center = is_trauma_center
        
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