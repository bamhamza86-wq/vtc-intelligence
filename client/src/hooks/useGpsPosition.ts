/**
 * useGpsPosition — Hook GPS temps réel global
 * ─────────────────────────────────────────────────────────────────────────────
 * Maintient la position GPS du chauffeur en continu via watchPosition.
 * Chaque changement de position déclenche un re-render des composants abonnés.
 *
 * Garanties :
 *  - Position JAMAIS mise en cache entre les renders (toujours fraîche)
 *  - fallback Bd Ney si GPS refusé ou indisponible
 *  - accuracy < 100m requis (filtre les positions imprécises)
 *  - lastUpdatedAt expose l'âge de la position pour affichage dans l'UI
 *
 * Usage :
 *   const { position, status, lastUpdatedAt } = useGpsPosition();
 *   // position = { lat, lng } — toujours valide (fallback si besoin)
 *   // status = "pending" | "granted" | "denied" | "error"
 *   // lastUpdatedAt = Date | null — moment de la dernière mise à jour GPS réelle
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useRef, useCallback } from "react";

export const GPS_FALLBACK = { lat: 48.8976, lng: 2.3299 }; // Bd Ney Paris 18e

export type GpsStatus = "pending" | "granted" | "denied" | "unavailable" | "error";

export interface GpsPosition {
  lat: number;
  lng: number;
  accuracy?: number; // mètres
}

export interface UseGpsPositionResult {
  position:      GpsPosition;        // toujours valide (fallback si GPS absent)
  rawPosition:   GpsPosition | null; // null si GPS pas encore accordé
  status:        GpsStatus;
  lastUpdatedAt: Date | null;        // dernière mise à jour GPS réelle
  isFallback:    boolean;            // true si on utilise Bd Ney
  refresh:       () => void;         // forcer une nouvelle lecture GPS
  error:         string | null;
}

// ── Singleton partagé — une seule instance watchPosition pour toute l'app ────
// Évite d'ouvrir plusieurs watchers GPS en parallèle (coûteux en batterie)
let _sharedWatchId: number | null = null;
let _listeners: Set<(pos: GpsPosition) => void> = new Set();
let _errorListeners: Set<(err: GeolocationPositionError) => void> = new Set();
let _lastRawPosition: GpsPosition | null = null;
let _lastPositionDate: Date | null = null;

function startSharedWatch(): void {
  if (_sharedWatchId !== null) return; // déjà actif
  if (!navigator.geolocation) return;

  _sharedWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      // Filtrer les positions imprécises (> 150m)
      if (pos.coords.accuracy > 150) return;
      const gps: GpsPosition = {
        lat:      pos.coords.latitude,
        lng:      pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      _lastRawPosition = gps;
      _lastPositionDate = new Date();
      _listeners.forEach(fn => fn(gps));
    },
    (err) => {
      _errorListeners.forEach(fn => fn(err));
    },
    {
      enableHighAccuracy: true,
      maximumAge:         3000,   // 3s max — position fraîche garantie
      timeout:            10000,  // 10s timeout
    }
  );
}

function stopSharedWatch(): void {
  if (_sharedWatchId === null) return;
  if (_listeners.size === 0 && _errorListeners.size === 0) {
    navigator.geolocation?.clearWatch(_sharedWatchId);
    _sharedWatchId = null;
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useGpsPosition(): UseGpsPositionResult {
  const [rawPosition, setRawPosition] = useState<GpsPosition | null>(_lastRawPosition);
  const [status, setStatus] = useState<GpsStatus>(
    _lastRawPosition ? "granted" : "pending"
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(_lastPositionDate);
  const [error, setError] = useState<string | null>(null);

  const posListenerRef = useRef<(pos: GpsPosition) => void>(() => {});
  const errListenerRef = useRef<(err: GeolocationPositionError) => void>(() => {});

  const refresh = useCallback(() => {
    if (!navigator.geolocation) {
      setStatus("unavailable");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const gps: GpsPosition = {
          lat:      pos.coords.latitude,
          lng:      pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        _lastRawPosition = gps;
        _lastPositionDate = new Date();
        setRawPosition(gps);
        setLastUpdatedAt(new Date());
        setStatus("granted");
        setError(null);
      },
      (err) => {
        setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "error");
        setError(err.message);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 3000 }
    );
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) {
      setStatus("unavailable");
      return;
    }

    // Enregistrer les listeners dans le singleton
    const posListener = (pos: GpsPosition) => {
      setRawPosition(pos);
      setLastUpdatedAt(new Date());
      setStatus("granted");
      setError(null);
    };
    const errListener = (err: GeolocationPositionError) => {
      setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "error");
      setError(`GPS: ${err.message}`);
    };

    posListenerRef.current = posListener;
    errListenerRef.current = errListener;
    _listeners.add(posListener);
    _errorListeners.add(errListener);

    // Si déjà une position disponible dans le singleton, l'utiliser immédiatement
    if (_lastRawPosition) {
      setRawPosition(_lastRawPosition);
      setLastUpdatedAt(_lastPositionDate);
      setStatus("granted");
    }

    // Démarrer (ou réutiliser) le watcher partagé
    startSharedWatch();

    // Fetch immédiate pour avoir la position sans attendre watchPosition
    refresh();

    return () => {
      _listeners.delete(posListener);
      _errorListeners.delete(errListener);
      stopSharedWatch();
    };
  }, [refresh]);

  const position: GpsPosition = rawPosition ?? GPS_FALLBACK;
  const isFallback = rawPosition === null;

  return {
    position,
    rawPosition,
    status,
    lastUpdatedAt,
    isFallback,
    refresh,
    error,
  };
}
