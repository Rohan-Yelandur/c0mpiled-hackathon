# Project Learnings: 3D Map Component

This document outlines the key learnings, implementation strategies, and optimizations discovered while building the West Campus 3D Map.

## 1. Core Technology Stack
We built a React application that renders a manipulatable 3D map.
-   **React**: The UI framework.
-   **MapLibre GL JS**: The core mapping library used to render vector tiles and 3D layers (an open-source fork of Mapbox GL).
-   **Overpass API**: A read-only API that serves custom selected parts of the OpenStreetMap (OSM) data.
-   **osmtogeojson**: A utility to convert the raw XML/JSON from Overpass into GeoJSON, which MapLibre can understand.
-   **Turf.js**: A geospatial analysis library used for calculating centroids (finding the middle of a building).

## 2. Key Features Implementation

### 3D Buildings
To make buildings look like solid 3D blocks rather than flat shapes:
-   **Data Source**: We fetched `way["building"]` and `relation["building"]` from OSM.
-   **Extrusion**: We used a `fill-extrusion` layer type in MapLibre.
-   **Height Logic**: We calculated height based on available data in this priority:
    1.  **Manual Override**: A hardcoded list for specific landmarks (e.g., "Moontower" = 70m).
    2.  **OSM Height**: The `height` tag from OSM data.
    3.  **Levels**: The `building:levels` tag multiplied by 3.5 meters.
    4.  **Fallback**: A minimum height of 6m to ensure everything is visible.
-   **Solid Look**: We explicitly set `fill-extrusion-opacity` to `1` and removed any accompanying "line" layers that were drawing wireframes on the ground, which created a confusing "see-through" effect.

### Smooth Camera Panning
To create a cinematic fee when selecting a building:
-   **Function**: Used `map.flyTo()`.
-   **Settings**:
    -   `speed: 0.5`: Slower than default for a gliding feel.
    -   `curve: 1`: Creates a smooth arc.
    -   `essential: true`: Ensures the animation completes even if the user interacts slightly.

### Elastic Map Boundaries
Instead of a hard wall that stops dragging:
-   We removed the `maxBounds` setting.
-   We implemented a listener on `moveend` that checks if the center is outside our allowed area.
-   If outside, we use `map.easeTo()` to gently "bounce" the view back to the nearest valid edge.

## 3. Performance Optimizations

### Tree-Shaking Libraries
Initially, we imported the entire Turf.js library (`import * as turf...`), which is very heavy.
-   **Optimization**: We switched to specific imports (e.g., `import centroid from '@turf/centroid'`). This drastically reduced the bundle size.

### Two-Stage Loading
Fetching all data for the entire West Campus area at once took too long to show anything on screen.
-   **Optimization**:
    1.  **Stage 1**: Immediately fetch data *only* for the current viewport (what the user sees).
    2.  **Stage 2**: Once the initial view is ready, fetch the rest of the map data in the background.

### Local Caching
Hitting the external Overpass API on every page reload is slow and wasteful.
-   **Optimization**:
    1.  Generate a unique cache key based on the map bounds.
    2.  Check `localStorage` for this key.
    3.  If found and valid (< 24 hours old), use the cached data instantly.
    4.  If not, fetch from the network and save the result to `localStorage`.

## 4. Challenges & Errors

### The "See-Through" Buildings
-   **Problem**: Buildings looked transparent or like wireframes.
-   **Cause**: We had a `line` layer rendering outlines *under* the 3D extrusion layer. This caused z-fighting (glitching) and visual confusion.
-   **Fix**: Removed the `line` layer entirely.

### Infinite Loop (Stack Overflow)
-   **Problem**: The "Elastic Bounds" logic crashed the browser with `Maximum call stack size exceeded`.
-   **Cause**:
    1.  User drags out of bounds.
    2.  Code triggers `easeTo` to fix it.
    3.  `easeTo` triggers a `moveend` event.
    4.  The `moveend` listener runs again, sees we are still settling (or due to precision issues), and triggers `easeTo` *again*, creating an infinite loop.
-   **Fix**: Implemented **Debouncing**. We wait for 150ms of silence (no movement) before causing a correction. This breaks the synchronous loop.
