import { useEffect, useRef, useState } from "react";
// maplibre-gl v6 ships named exports only; there is no default export to import.
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type MapLayerMouseEvent,
} from "maplibre-gl";
// maplibre-gl v6 loads its worker as a sibling file of its own module URL. Any bundler
// that inlines the library breaks that assumption and the map renders blank with
// "Worker failed to load" in the console — so hand it the bundled worker's real URL.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";

setWorkerUrl(workerUrl);

import { api, tileRequestHeaders, tileUrl, type Filters, type Scale } from "../lib/api";
import { stepExpression, ZERO_DARK, ZERO_LIGHT } from "../lib/choropleth";
import { formatNumber } from "../lib/format";
import { Legend } from "./Legend";

export type Level = "country" | "province" | "municipality";

interface Props {
  level: Level;
  filters: Filters;
  scale?: Scale;
  isDark: boolean;
  onDrillDown: (level: Level, name: string, province: string | null) => void;
}

const SOURCE_ID = "boundaries";
const FILL_LAYER = "boundary-fill";
const LINE_LAYER = "boundary-line";

const PHILIPPINES: [number, number, number, number] = [116.9, 4.6, 126.6, 21.1];
// Country level is a world choropleth — 32 countries send students here — so it opens on
// the world rather than on the Philippines, which would put every other country off-screen.
const WORLD: [number, number, number, number] = [-170, -56, 190, 72];

const HOME_BOUNDS: Record<Level, [number, number, number, number]> = {
  country: WORLD,
  province: PHILIPPINES,
  municipality: PHILIPPINES,
};

/**
 * The map is fed by vector tiles, not GeoJSON. The source boundaries are 680 MB of
 * unsimplified polygons; as tiles the browser receives single-digit kilobytes per view,
 * and the metric travels inside the tile so recolouring needs no second request.
 */
export function MapPanel({ level, filters, scale, isDark, onDrillDown }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new MapLibreMap({
      container: container.current,
      // No external basemap: the dashboard's subject is the boundaries themselves, and
      // a self-contained style keeps the deployment free of third-party tile hosts.
      style: {
        version: 8,
        sources: {},
        layers: [
          { id: "background", type: "background", paint: { "background-color": isDark ? "#0d0d0d" : "#f9f9f7" } },
        ],
      },
      bounds: HOME_BOUNDS[level],
      fitBoundsOptions: { padding: 24 },
      attributionControl: false,
      // Tiles come from the Supabase `tile` function, which needs the project key and
      // must be asked for raw bytes. Every other request passes through untouched.
      transformRequest: (url) => {
        const headers = tileRequestHeaders(url);
        return headers ? { url, headers } : undefined;
      },
    });
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    instance.addControl(
      new AttributionControl({
        compact: true,
        customAttribution: "Boundaries: UC AI Unit · Counts: UC Registrar extract",
      }),
      "bottom-right",
    );
    instance.on("load", () => setReady(true));
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      setReady(false);
    };
  }, [isDark]);

  // Source and layers are rebuilt when the level or the filters change, because both
  // are baked into the tile URL.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready || !scale) return;

    if (instance.getLayer(FILL_LAYER)) instance.removeLayer(FILL_LAYER);
    if (instance.getLayer(LINE_LAYER)) instance.removeLayer(LINE_LAYER);
    if (instance.getSource(SOURCE_ID)) instance.removeSource(SOURCE_ID);

    instance.addSource(SOURCE_ID, {
      type: "vector",
      tiles: [tileUrl(level, filters)],
      minzoom: 0,
      maxzoom: 14,
    });
    instance.addLayer({
      id: FILL_LAYER,
      type: "fill",
      source: SOURCE_ID,
      "source-layer": level,
      paint: {
        "fill-color": stepExpression(
          scale.breaks,
          isDark ? ZERO_DARK : ZERO_LIGHT,
          isDark,
        ) as never,
        "fill-opacity": 0.92,
      },
    });
    instance.addLayer({
      id: LINE_LAYER,
      type: "line",
      source: SOURCE_ID,
      "source-layer": level,
      paint: {
        "line-color": isDark ? "#0d0d0d" : "#fcfcfb",
        "line-width": level === "municipality" ? 0.5 : 0.8,
      },
    });

    // The pointer handlers are registered HERE, immediately after the layer they target,
    // and torn down with it. Registering them in an effect of their own looked tidier and
    // was silently broken: that effect ran while this one was still waiting for the
    // scale, so the listeners bound to a layer that did not exist yet and no hover
    // readout ever appeared. Layer-scoped listeners have to outlive nothing.
    // offset + pointer-events:none (see index.css) are load-bearing, not cosmetic. A
    // popup anchored under the cursor takes the pointer, the map fires mouseleave, the
    // popup is removed, the pointer lands back on the canvas — and the readout flickers
    // in and out forever. It looked like the hover was simply not working.
    const popup = new Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 14,
      className: "uc-popup",
    });

    const onMove = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      instance.getCanvas().style.cursor = level === "country" ? "default" : "pointer";
      const props = feature.properties as Record<string, number | string>;
      const place = props.province ? `${props.name}, ${props.province}` : props.name;
      popup
        .setLngLat(event.lngLat)
        .setHTML(
          `<strong>${place}</strong>` +
            `<span class="uc-popup-figure">${formatNumber(Number(props.headcount))}` +
            `<span class="uc-popup-unit"> students</span></span>` +
            `<span class="uc-popup-sub">${formatNumber(Number(props.records))} enrollment records</span>`,
        )
        .addTo(instance);
    };

    const onLeave = () => {
      instance.getCanvas().style.cursor = "";
      popup.remove();
    };

    const onClick = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const props = feature.properties as Record<string, string>;
      onDrillDown(level, props.name, props.province ?? null);
    };

    const subscriptions = [
      instance.on("mousemove", FILL_LAYER, onMove),
      instance.on("mouseleave", FILL_LAYER, onLeave),
      instance.on("click", FILL_LAYER, onClick),
    ];

    return () => {
      for (const subscription of subscriptions) subscription.unsubscribe();
      popup.remove();
    };
  }, [level, filters, scale, ready, isDark, onDrillDown]);

  // Fly to the province being drilled into, and back out when it is cleared. Without
  // this the drill-down filters correctly but leaves the viewport at national zoom, so
  // the municipalities the reader just asked for are a few pixels across.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    let cancelled = false;

    if (!filters.province) {
      instance.fitBounds(HOME_BOUNDS[level], { padding: 24, duration: 600 });
      return;
    }

    api
      .bbox("province", filters.province)
      .then((box) => {
        if (cancelled) return;
        instance.fitBounds([box.minx, box.miny, box.maxx, box.maxy], {
          padding: 40,
          duration: 600,
        });
      })
      .catch(() => {
        /* an unknown province leaves the viewport where it is rather than jumping */
      });

    return () => {
      cancelled = true;
    };
  }, [filters.province, level, ready]);

  return (
    <div className="relative h-[560px] overflow-hidden rounded-xl border border-[var(--color-hairline)]">
      <div ref={container} className="uc-map h-full w-full" data-testid="map-container" />
      {scale ? <Legend scale={scale} dark={isDark} /> : null}
    </div>
  );
}
