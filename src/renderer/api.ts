import type { HaulApi } from '../shared/types';

declare global {
  interface Window {
    haul: HaulApi;
  }
}

export const api: HaulApi = window.haul;
