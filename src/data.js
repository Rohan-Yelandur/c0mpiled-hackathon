export const TARGET_BUILDINGS = [
  { name: "Dell Seton Medical Center", coords: [-97.7345, 30.2766], type: "hospital" },
  { name: "Seton Medical Center", coords: [-97.7464, 30.3052], type: "hospital" },
  { name: "DKR Memorial Stadium", coords: [-97.7325, 30.2836], type: "stadium" },
];

export const HEIGHT_OVERRIDES = {
  "dell seton medical center": 60,
  "seton medical center": 50,
  "darrell k royal": 25,
  "dkr": 25,
  "texas memorial stadium": 25,
};

export const MAP_BOUNDS = [
  -97.756, // West (Lamar/Shoal Creek)
  30.270,  // South (just below Dell Seton)
  -97.720, // East (I-35)
  30.312   // North (above 38th St / Ascension Seton)
];