"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { MapPin, Search } from "lucide-react";
import { NOMINATIM_SEARCH_URL } from "@/lib/map/constants";
import { MAP_PALETTES } from "@/lib/map/palette";
import { useTheme } from "@/store/useTheme";

interface AddressSearchProps {
  mapRef: React.MutableRefObject<MapLibreMap | null>;
}

interface NominatimResult {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
}

const DEBOUNCE_MS = 400;

export default function AddressSearch({ mapRef }: AddressSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const markerRef = useRef<{ remove: () => void } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const markerColor = MAP_PALETTES[useTheme((s) => s.theme)].accent;

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setResults([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed, format: "jsonv2", limit: "5" });
      fetch(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Search failed"))))
        .then((json: NominatimResult[]) => {
          setResults(Array.isArray(json) ? json : []);
          setLoading(false);
          setOpen(true);
        })
        .catch((err: unknown) => {
          if ((err as Error).name !== "AbortError") {
            setResults([]);
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    const onClickAway = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, []);

  const selectResult = (result: NominatimResult) => {
    const map = mapRef.current;
    const lngLat: [number, number] = [Number(result.lon), Number(result.lat)];
    setOpen(false);
    setQuery(result.display_name.split(",").slice(0, 2).join(","));
    if (!map) return;
    map.flyTo({ center: lngLat, zoom: 12, duration: 600 });
    void import("maplibre-gl").then((maplibregl) => {
      markerRef.current?.remove();
      markerRef.current = new maplibregl.default.Marker({ color: markerColor })
        .setLngLat(lngLat)
        .addTo(map);
    });
  };

  return (
    <div
      ref={rootRef}
      className="absolute left-3 top-3 z-20 w-80 max-w-[calc(100vw-1.5rem)] transition-[width] duration-150 ease-out focus-within:w-96"
    >
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results[0]) selectResult(results[0]);
            if (event.key === "Escape") setOpen(false);
          }}
          placeholder="Search address or place…"
          aria-label="Search address"
          className="h-8 w-full rounded border border-border bg-surface pl-8 pr-7 text-sm text-text shadow-float transition-colors duration-150 placeholder:text-muted"
        />
      </div>

      {open && results.length > 0 && (
        <ul className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface">
          {results.map((result) => (
            <li key={result.place_id}>
              <button
                type="button"
                onClick={() => selectResult(result)}
                className="flex w-full items-start gap-2 px-2.5 py-2 text-left text-sm text-text transition-colors duration-150 hover:bg-surface-2"
              >
                <MapPin size={13} className="mt-0.5 shrink-0 text-muted" />
                <span className="line-clamp-2">{result.display_name}</span>
              </button>
            </li>
          ))}
          <li className="border-t border-border px-2.5 py-1.5 text-[11px] text-muted">
            OpenStreetMap Nominatim
          </li>
        </ul>
      )}

      {open && !loading && query.trim().length >= 3 && results.length === 0 && (
        <div className="mt-1 rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-muted">
          No places found.
        </div>
      )}
    </div>
  );
}
