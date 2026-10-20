"use client";

import { useEffect, useState } from "react";
import type { District, Ilr, Tehsil } from "@/lib/data";
import { dataAdapter } from "@/lib/data";

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const IDLE = { data: null, loading: false, error: null } as const;

export function useDistricts(): AsyncState<District[]> {
  const [state, setState] = useState<AsyncState<District[]>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let mounted = true;
    setState({ data: null, loading: true, error: null });
    dataAdapter
      .getDistricts()
      .then((data) => mounted && setState({ data, loading: false, error: null }))
      .catch((err: unknown) =>
        mounted &&
        setState({ data: null, loading: false, error: err instanceof Error ? err.message : "Failed to load districts" }),
      );
    return () => {
      mounted = false;
    };
  }, []);

  return state;
}

export function useTehsils(districtId: string | null): AsyncState<Tehsil[]> {
  const [state, setState] = useState<AsyncState<Tehsil[]>>({ ...IDLE, loading: false });

  useEffect(() => {
    if (!districtId) {
      setState(IDLE);
      return;
    }
    let mounted = true;
    setState({ data: null, loading: true, error: null });
    dataAdapter
      .getTehsils(districtId)
      .then((data) => mounted && setState({ data, loading: false, error: null }))
      .catch((err: unknown) =>
        mounted &&
        setState({ data: null, loading: false, error: err instanceof Error ? err.message : "Failed to load tehsils" }),
      );
    return () => {
      mounted = false;
    };
  }, [districtId]);

  return state;
}

export function useIlrs(tehsilId: string | null): AsyncState<Ilr[]> {
  const [state, setState] = useState<AsyncState<Ilr[]>>({ ...IDLE, loading: false });

  useEffect(() => {
    if (!tehsilId) {
      setState(IDLE);
      return;
    }
    let mounted = true;
    setState({ data: null, loading: true, error: null });
    dataAdapter
      .getIlrs(tehsilId)
      .then((data) => mounted && setState({ data, loading: false, error: null }))
      .catch((err: unknown) =>
        mounted &&
        setState({ data: null, loading: false, error: err instanceof Error ? err.message : "Failed to load ILRs" }),
      );
    return () => {
      mounted = false;
    };
  }, [tehsilId]);

  return state;
}
