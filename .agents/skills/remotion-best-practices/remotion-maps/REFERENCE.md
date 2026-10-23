---
name: remotion-maps
description: Remotion Map animation knowledge
version: 4.0.521
---

# Remotion Maps

Choose exactly one technique from the intended shot, then load that technique's `TECHNIQUE.md` and any references it explicitly requires.
Every technique directory is self-contained and may be removed without breaking the others.

## [Static map](techniques/static-map/TECHNIQUE.md)

- Requires you export a map image at the final aspect ratio and render it with `CanvasImage`
- For a shot where neither the camera nor the geographic data animates; any labels or markers on top stay fixed

## [Mapbox](techniques/mapbox/TECHNIQUE.md)

- Requires a Mapbox key
- Nicer styles by default
- Map can display a round globe when zoomed out
- Includes nice 3D buildings such as the Eiffel tower

## [MapLibre](techniques/maplibre/TECHNIQUE.md)

- The library itself needs no API key and has no licence fee; the map style and tile source you load with it may require a key or carry usage terms
- Does not include 3D building

## [MapTiler](techniques/maptiler/TECHNIQUE.md)

- Uses MapTiler
- Annotations can be drawn on top of geographic features: borders, rivers, labels

## [CesiumJS](techniques/cesium/TECHNIQUE.md)

- Flythroughs through terrain and mountains
- "Flight simulator" perspective
