import React, { useRef, useEffect, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import osmtogeojson from 'osmtogeojson';
import centroid from '@turf/centroid';


import { TARGET_BUILDINGS, HEIGHT_OVERRIDES, MAP_BOUNDS } from './data';

const MapComponent = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);



  useEffect(() => {
    if (map.current) return; // initialize map only once

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: 'background',
            type: 'background',
            paint: {
              'background-color': '#f0f0f0'
            }
          }
        ]
      },
      center: [-97.742, 30.288],
      zoom: 16,
      minZoom: 14,
      maxZoom: 18,
      pitch: 45,
      bearing: 0, // Face North
      antialias: true,
      attributionControl: false
    });

    // Add Compass & Zoom controls
    map.current.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      'top-right'
    );

    // Elastic Bounds Logic
    // Use a timeout to debounce the check and prevent event loops/stack overflows
    let bounceTimeout = null;

    const checkBounds = () => {
      const center = map.current.getCenter();
      const zoom = map.current.getZoom();

      const w = MAP_BOUNDS[0];
      const s = MAP_BOUNDS[1];
      const e = MAP_BOUNDS[2];
      const n = MAP_BOUNDS[3];

      let newLng = center.lng;
      let newLat = center.lat;
      let needsCorrection = false;

      if (newLng < w) { newLng = w; needsCorrection = true; }
      if (newLng > e) { newLng = e; needsCorrection = true; }
      if (newLat < s) { newLat = s; needsCorrection = true; }
      if (newLat > n) { newLat = n; needsCorrection = true; }

      if (needsCorrection) {
        map.current.easeTo({
          center: [newLng, newLat],
          zoom: zoom,
          duration: 500, // Smooth bounce back
          easing: (t) => t * (2 - t) // Ease out
        });
      }
    };

    // Only listen to moveend. Debounce ensures we don't fight with the map 
    // or trigger loops if easeTo fires moveend immediately.
    map.current.on('moveend', () => {
      if (bounceTimeout) clearTimeout(bounceTimeout);
      bounceTimeout = setTimeout(() => {
        checkBounds();
      }, 150);
    });

    map.current.on('load', async () => {
      // 1. Initial Fast Load (Current Viewport)
      await fetchBuildings(map.current.getBounds());

      // 2. Background Full Load (West Campus + UT)
      fetchBuildings(MAP_BOUNDS);
    });

    map.current.on('click', '3d-buildings', (e) => {
      if (e.features.length > 0) {
        const feature = e.features[0];
        const props = feature.properties;

        const centerPoint = centroid(feature);
        const coords = centerPoint.geometry.coordinates;

        handleBuildingClick(props, coords);

        new maplibregl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(createPopupContent(props))
          .addTo(map.current);
      }
    });

    map.current.on('mouseenter', '3d-buildings', () => {
      map.current.getCanvas().style.cursor = 'pointer';
    });
    map.current.on('mouseleave', '3d-buildings', () => {
      map.current.getCanvas().style.cursor = '';
    });
  }, []);



  const handleBuildingClick = (props, coords) => {
    // Quick FlyTo for interaction feedback
    map.current.flyTo({
      center: coords,
      zoom: 17,
      pitch: 45,
      speed: 0.5,
      curve: 1,
      essential: true
    });
  };

  const handleSearchInput = (e) => {
    const value = e.target.value;
    setSearchTerm(value);

    if (value.length > 0) {
      const filtered = TARGET_BUILDINGS.filter(b =>
        b.name.toLowerCase().includes(value.toLowerCase())
      );
      setSuggestions(filtered);
      setShowSuggestions(true);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  const selectSuggestion = (building) => {
    setSearchTerm(building.name);
    setShowSuggestions(false);

    if (building) {
      map.current.flyTo({
        center: building.coords,
        zoom: 18,
        pitch: 60,
        bearing: -17,
        speed: 0.5,
        curve: 1,
        essential: true
      });
    }
  };

  const createPopupContent = (props) => {
    const address = `${props['addr:housenumber'] || ''} ${props['addr:street'] || ''}`.trim();
    // Use name if exists, otherwise address, otherwise 'Building'
    const title = props.name || address || 'Building';

    let content = `<div style="padding: 5px; color: #333; font-family: sans-serif;">`;
    content += `<h3 style="margin: 0 0 5px;">${title}</h3>`;

    // Only show separate address line if we have a real name AND an address
    if (props.name && address) {
      content += `<p style="margin: 0;">${address}</p>`;
    }

    if (props.height) {
      content += `<p style="margin: 5px 0 0; font-size: 0.9em; color: #666;">Height: ${props.height}m</p>`;
    }
    content += `</div>`;
    return content;
  };

  const fetchBuildings = async (targetBounds) => {
    if (!map.current) return;
    setLoading(true);

    let w, s, e, n;

    if (targetBounds && typeof targetBounds.getSouth === 'function') {
      // It's a LngLatBounds object (from getBounds)
      s = targetBounds.getSouth();
      w = targetBounds.getWest();
      n = targetBounds.getNorth();
      e = targetBounds.getEast();
    } else if (Array.isArray(targetBounds)) {
      // It's our array constant [w, s, e, n]
      w = targetBounds[0];
      s = targetBounds[1];
      e = targetBounds[2];
      n = targetBounds[3];
    } else {
      // Fallback to default MAP_BOUNDS if nothing passed
      w = MAP_BOUNDS[0];
      s = MAP_BOUNDS[1];
      e = MAP_BOUNDS[2];
      n = MAP_BOUNDS[3];
    }

    // Query for buildings AND building parts AND roads
    const query = `
      [out:json][timeout:25];
      (
        way["building"](${s},${w},${n},${e});
        relation["building"](${s},${w},${n},${e});
        way["building:part"](${s},${w},${n},${e});
        relation["building:part"](${s},${w},${n},${e});
        way["highway"~"^(primary|secondary|tertiary|residential)$"](${s},${w},${n},${e});
      );
      (._;>;);
      out;
    `;

    const cacheKey = `osm_data_${w}_${s}_${e}_${n}`;
    const cached = localStorage.getItem(cacheKey);
    let data;

    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        // Valid for 24 hours
        if (Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000) {
          data = parsed.data;
        }
      } catch (e) {
        console.warn("Error parsing cached OSM data", e);
        localStorage.removeItem(cacheKey);
      }
    }

    if (!data) {
      try {
        const response = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          body: query
        });
        data = await response.json();

        // Cache the successful response
        try {
          localStorage.setItem(cacheKey, JSON.stringify({
            timestamp: Date.now(),
            data: data
          }));
        } catch (e) {
          console.warn("Failed to cache OSM data (likely quota exceeded)", e);
        }

      } catch (error) {
        console.error("Error fetching buildings:", error);
        setLoading(false);
        return;
      }
    }

    try {
      const geojson = osmtogeojson(data);

      // --- Buildings Processing ---
      const validBuildings = geojson.features.filter(f =>
        (f.properties.building || f.properties['building:part']) &&
        (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
      );

      validBuildings.forEach(feature => {
        const props = feature.properties;
        const name = props.name?.toLowerCase() || "";

        // Target Identification
        const matchedTarget = TARGET_BUILDINGS.find(t => name.includes(t.name.toLowerCase()));
        props.isTarget = !!matchedTarget;

        // Height Calculation Strategy:
        let h = 0;

        // 1. Override
        const overrideKey = Object.keys(HEIGHT_OVERRIDES).find(key => name.includes(key));
        if (overrideKey) {
          h = HEIGHT_OVERRIDES[overrideKey];
        }

        // 2. OSM Height
        if (!h && props.height) {
          h = parseFloat(props.height);
        }

        // 3. Levels
        if (!h && props['building:levels']) {
          h = parseFloat(props['building:levels']) * 3.5;
        }

        // 4. Default / Min Enforcement
        if (!h || isNaN(h) || h < 6) {
          h = 6;
        }

        props.renderHeight = h;
      });

      const buildingsGeoJSON = {
        type: 'FeatureCollection',
        features: validBuildings
      };

      // --- Roads Processing ---
      const validRoads = geojson.features.filter(f =>
        f.properties.highway && f.geometry.type === 'LineString' && f.properties.name
      );

      const roadsGeoJSON = {
        type: 'FeatureCollection',
        features: validRoads
      };

      // --- Update Sources & Layers ---

      // 1. Buildings
      if (map.current.getSource('buildings-source')) {
        map.current.getSource('buildings-source').setData(buildingsGeoJSON);
      } else {
        map.current.addSource('buildings-source', {
          type: 'geojson',
          data: buildingsGeoJSON
        });

        map.current.addLayer({
          'id': '3d-buildings',
          'type': 'fill-extrusion',
          'source': 'buildings-source',
          'paint': {
            'fill-extrusion-color': [
              'case',
              ['boolean', ['get', 'isTarget'], false],
              '#BF5700', // UT Orange for targets
              '#d9d9d9'  // Light grey for others
            ],
            'fill-extrusion-height': ['get', 'renderHeight'],
            'fill-extrusion-base': 0,
            'fill-extrusion-opacity': 1,
            'fill-extrusion-vertical-gradient': true
          }
        });


      }

      // 2. Road Labels
      if (map.current.getSource('roads-source')) {
        map.current.getSource('roads-source').setData(roadsGeoJSON);
      } else {
        map.current.addSource('roads-source', {
          type: 'geojson',
          data: roadsGeoJSON
        });

        map.current.addLayer({
          'id': 'road-labels',
          'type': 'symbol',
          'source': 'roads-source',
          'layout': {
            'text-field': ['get', 'name'],
            'text-font': ['Open Sans Semibold'], // Default font usually available
            'text-size': 12,
            'symbol-placement': 'line',
            'text-offset': [0, 0.5]
          },
          'paint': {
            'text-color': '#555',
            'text-halo-color': '#fff',
            'text-halo-width': 2
          }
        });
      }

    } catch (error) {
      console.error("Error fetching buildings:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* UI Overlay */}
      <div style={{
        position: 'absolute',
        top: 20,
        left: 20,
        zIndex: 10,
        backgroundColor: 'white',
        padding: '15px',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        maxWidth: '300px'
      }}>
        <h2 style={{ margin: '0 0 10px 0', fontSize: '18px' }}>West Campus Map</h2>

        <div style={{ marginBottom: '10px', position: 'relative' }}>
          <input
            type="text"
            value={searchTerm}
            onChange={handleSearchInput}
            placeholder="Search buildings..."
            style={{
              width: '100%',
              padding: '8px 15px',
              borderRadius: '25px',
              border: '1px solid #ccc',
              outline: 'none',
              fontSize: '14px',
              boxSizing: 'border-box'
            }}
          />
          {showSuggestions && suggestions.length > 0 && (
            <ul style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              backgroundColor: 'white',
              border: '1px solid #eee',
              borderRadius: '8px',
              marginTop: '5px',
              maxHeight: '200px',
              overflowY: 'auto',
              padding: 0,
              margin: '5px 0 0 0',
              listStyle: 'none',
              boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
              zIndex: 20
            }}>
              {suggestions.map((b, i) => (
                <li
                  key={i}
                  onClick={() => selectSuggestion(b)}
                  style={{
                    padding: '10px 15px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    borderBottom: i < suggestions.length - 1 ? '1px solid #f0f0f0' : 'none',
                    transition: 'background-color 0.2s'
                  }}
                  onMouseEnter={(e) => e.target.style.backgroundColor = '#f5f5f5'}
                  onMouseLeave={(e) => e.target.style.backgroundColor = 'white'}
                >
                  {b.name}
                </li>
              ))}
            </ul>
          )}
        </div>


      </div>

      {loading && (
        <div style={{
          position: 'absolute', bottom: 20, right: 20, zIndex: 1,
          backgroundColor: 'rgba(0,0,0,0.7)', color: 'white',
          padding: '8px 12px', borderRadius: '20px', fontSize: '12px'
        }}>
          Updating 3D Data...
        </div>
      )}
      <div ref={mapContainer} className="map-container" style={{ width: '100%', height: '100%' }} />
    </div>
  );
};

export default MapComponent;
