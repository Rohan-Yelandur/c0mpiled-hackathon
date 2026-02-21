import React, { useState, useRef, useCallback } from "react";
import { getOptimalHospital } from "../algo";
import "./TriageChat.css";

const DEFAULT_SYSTEM_PROMPT = `You are an expert Emergency Medical Services (EMS) AI assistant. 
Your job is to listen to transcripts from first responders and extract vital triage data into a strict JSON format.

You must analyze the patient's condition and output a JSON object with EXACTLY these three keys:

1. "acuity_level" (integer): Based on the Emergency Severity Index (ESI).
   - 1: Resuscitation (Life-saving intervention required immediately. e.g., cardiac arrest, severe trauma, unconscious).
   - 2: Emergent (High risk of deterioration. e.g., chest pain, stroke symptoms, severe bleeding).
   - 3: Urgent (Stable, but requires multiple resources. e.g., abdominal pain, mild respiratory distress).
   - 4: Less Urgent (Stable, requires one resource. e.g., simple laceration, minor trauma).
   - 5: Non-Urgent (Minor issues. e.g., cold symptoms, minor rash).
   * Default to 3 if uncertain.

2. "required_specialty" (string): The PRIMARY specialist required for the most life-threatening condition. 
   * YOU MUST CHOOSE FROM THIS EXACT LIST: ["Cardiology", "Neurology", "Trauma", "General"]
   * Do not invent new specialties. If it does not fit Cardiology, Neurology, or Trauma, output "General".

3. "required_specialties" (list of strings): An array of ALL specialties the patient might need. 
   * YOU MUST CHOOSE FROM THIS EXACT LIST: ["Cardiology", "Neurology", "Trauma", "General"]
   * For example, a patient in a severe car crash with a head injury and internal bleeding might need ["Trauma", "Neurology"].

OUTPUT FORMAT:
Return ONLY valid JSON. Do not include markdown formatting like \`\`\`json or any conversational text.


Example 1:
Input: "We have a 45-year-old male, severe chest pain radiating to the left arm, diaphoretic. ETA 10 minutes."
Output: {"acuity_level": 2, "required_specialty": "Cardiology", "required_specialties": ["Cardiology"]}

Example 2:
Input: "22-year-old female involved in a high-speed MVC. Unresponsive, obvious severe head trauma and open femur fracture."
Output: {"acuity_level": 1, "required_specialty": "Trauma", "required_specialties": ["Trauma", "Neurology"]}

Example 3:
Input: "10-year-old boy, fell off his bike, looks like a simple wrist fracture. Vitals stable."
Output: {"acuity_level": 4, "required_specialty": "General", "required_specialties": ["General"]}
`;

function parseJsonFromGemini(text) {
  if (!text || typeof text !== "string") return null;
  let s = text.trim();
  const jsonMatch = s.match(/\{[\s\S]*\}/);
  if (jsonMatch) s = jsonMatch[0];
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Prefer Gemini 2+ for better JSON extraction. Options: gemini-2.0-flash, gemini-2.5-flash, gemini-3-flash-preview, gemini-1.5-flash (fallback).
const GEMINI_MODEL = "gemini-2.5-flash";

async function callGemini(apiKey, systemPrompt, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `Gemini API error: ${res.status}`);
  }
  const data = await res.json();
  const textPart = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textPart) throw new Error("No text in Gemini response");
  return textPart;
}

export default function TriageChat() {
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [apiKey, setApiKey] = useState("");
  const [transcript, setTranscript] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [nlpData, setNlpData] = useState(null);
  const [hospitalResult, setHospitalResult] = useState(null);
  const recognitionRef = useRef(null);
  const lastFinalIndexRef = useRef(-1);
  const committedRef = useRef("");
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;

  const startRecording = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("Speech recognition not supported in this browser. Type the transcript instead.");
      return;
    }
    setError("");
    lastFinalIndexRef.current = -1;
    committedRef.current = transcriptRef.current;
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let committed = committedRef.current;
      let interim = "";
      for (let i = lastFinalIndexRef.current + 1; i < e.results.length; i++) {
        const t = (e.results[i][0].transcript || "").trim();
        if (e.results[i].isFinal) {
          if (t) committed += (committed ? " " : "") + t;
          lastFinalIndexRef.current = i;
        } else {
          if (t) interim += (interim ? " " : "") + t;
        }
      }
      committedRef.current = committed;
      setTranscript(interim ? committed + " " + interim : committed);
    };
    rec.onerror = (e) => setError(e.error || "Speech recognition error");
    rec.start();
    recognitionRef.current = rec;
    setRecording(true);
  }, []);

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setRecording(false);
  }, []);

  const handleSubmit = async () => {
    setError("");
    setNlpData(null);
    setHospitalResult(null);
    const trimmed = transcript.trim();
    if (!trimmed) {
      setError("Enter or record a patient transcript first.");
      return;
    }
    const key = apiKey || (typeof process !== "undefined" && process.env?.GEMINI_API_KEY);
    if (!key) {
      setError("Enter your Gemini API key above (or set GEMINI_API_KEY in .env).");
      return;
    }
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);
    if (Number.isNaN(latNum) || Number.isNaN(lonNum)) {
      setError("Enter valid latitude and longitude.");
      return;
    }

    setLoading(true);
    try {
      const raw = await callGemini(key, systemPrompt, trimmed);
      const parsed = parseJsonFromGemini(raw);
      if (!parsed || typeof parsed.acuity_level === "undefined") {
        setError("Gemini did not return valid triage JSON. Try again or check the system prompt.");
        setLoading(false);
        return;
      }
      setNlpData(parsed);

      const result = await getOptimalHospital(parsed, latNum, lonNum);
      if (!result) {
        setError("No suitable hospital found for this patient and location.");
      } else {
        setHospitalResult(result);
      }
    } catch (e) {
      setError(e.message || "Request failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="TriageChat">
      <h2 className="TriageChat-title">EMS Triage → Optimal Hospital</h2>

      <div className="TriageChat-section">
        <label className="TriageChat-label">System prompt (NLP instructions)</label>
        <textarea
          className="TriageChat-textarea TriageChat-systemPrompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="Paste or edit the system prompt for Gemini..."
          rows={14}
        />
      </div>

      <div className="TriageChat-section">
        <label className="TriageChat-label">Gemini API key</label>
        <input
          type="password"
          className="TriageChat-input"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Paste your Gemini API key (or set GEMINI_API_KEY in .env)"
        />
      </div>

      <div className="TriageChat-section">
        <label className="TriageChat-label">Patient transcript (speak or type)</label>
        <div className="TriageChat-transcriptRow">
          <button
            type="button"
            className={`TriageChat-recordBtn ${recording ? "is-recording" : ""}`}
            onClick={recording ? stopRecording : startRecording}
          >
            {recording ? "Stop recording" : "Click to speak"}
          </button>
          <span className="TriageChat-hint">Then press Enter below to submit.</span>
        </div>
        <textarea
          className="TriageChat-textarea"
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="Record with the button above or type the first-responder notes here. Press Enter to submit."
          rows={4}
        />
      </div>

      <div className="TriageChat-section TriageChat-coords">
        <label className="TriageChat-label">Scene location (will use plugin variable later)</label>
        <div className="TriageChat-coordInputs">
          <input
            type="text"
            className="TriageChat-input TriageChat-coord"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="Latitude"
          />
          <input
            type="text"
            className="TriageChat-input TriageChat-coord"
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            placeholder="Longitude"
          />
        </div>
      </div>

      <div className="TriageChat-actions">
        <button type="button" className="TriageChat-submitBtn" onClick={handleSubmit} disabled={loading}>
          {loading ? "Getting triage & hospital…" : "Get optimal hospital"}
        </button>
      </div>

      {error && <div className="TriageChat-error">{error}</div>}
      {nlpData && (
        <div className="TriageChat-nlp">
          <strong>Extracted triage:</strong> acuity {nlpData.acuity_level}, specialty {nlpData.required_specialty}
          {nlpData.required_specialties?.length > 1 ? `, all: ${nlpData.required_specialties.join(", ")}` : ""}
        </div>
      )}
      {hospitalResult && (
        <div className="TriageChat-result">
          <strong>Recommended hospital</strong>
          <div className="TriageChat-resultName">{hospitalResult.hospital_name}</div>
          <div className="TriageChat-resultMeta">
            ETA {hospitalResult.eta_minutes} min · Score {hospitalResult.routing_score} · ED beds {hospitalResult.available_ed_beds} · ICU {hospitalResult.available_icu_beds}
            {hospitalResult.specialist_ready != null && (
              <span> · Specialist ready: {hospitalResult.specialist_ready ? "Yes" : "No"}</span>
            )}
            {hospitalResult.specialist_load != null && <span> · Load {hospitalResult.specialist_load}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
