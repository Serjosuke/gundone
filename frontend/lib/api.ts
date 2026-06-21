import { Card, CardType, MapOverlay, MapPayload, Marker, Region, TimelineEvent } from "./types";

const BASE = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");
let adminToken: string | null = null;

type CardDraft = Omit<Card, "id" | "created_at" | "updated_at">;
type RegionDraft = Omit<Region, "id" | "map_id" | "created_at" | "updated_at" | "card_title">;
type OverlayDraft = Pick<MapOverlay, "image_url" | "x" | "y" | "width" | "aspect_ratio" | "label" | "card_id" | "display_type">;

export function setAdminToken(token: string | null) {
  adminToken = token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (adminToken) headers.set("Authorization", `Bearer ${adminToken}`);
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    let detail = "Не удалось выполнить запрос";
    try {
      const body = await response.json();
      detail = body.detail || detail;
    } catch {
      detail = await response.text() || detail;
    }
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  login: (password: string) => request<{ access_token: string; expires_at: number; role: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  me: () => request<{ role: string }>("/api/auth/me"),
  cards: (q?: string, type?: CardType) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    return request<Card[]>(`/api/cards${params.size ? `?${params}` : ""}`, { cache: "no-store" });
  },
  createCard: (body: CardDraft) => request<Card>("/api/cards", { method: "POST", body: JSON.stringify(body) }),
  updateCard: (id: number, body: CardDraft) => request<Card>(`/api/cards/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCard: (id: number) => request<void>(`/api/cards/${id}`, { method: "DELETE" }),
  map: () => request<MapPayload>("/api/maps/1", { cache: "no-store" }),
  updateMap: (body: Pick<MapPayload, "title" | "subtitle" | "image_url">) => request<MapPayload>("/api/maps/1", { method: "PATCH", body: JSON.stringify(body) }),
  createMarker: (body: { card_id: number; x: number; y: number; label?: string | null }) => request<Marker>("/api/maps/1/markers", { method: "POST", body: JSON.stringify(body) }),
  updateMarker: (id: number, body: { card_id: number; x: number; y: number; label?: string | null }) => request<Marker>(`/api/maps/1/markers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteMarker: (id: number) => request<void>(`/api/maps/1/markers/${id}`, { method: "DELETE" }),
  createRegion: (body: RegionDraft) => request<Region>("/api/maps/1/regions", { method: "POST", body: JSON.stringify(body) }),
  updateRegion: (id: number, body: RegionDraft) => request<Region>(`/api/maps/1/regions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteRegion: (id: number) => request<void>(`/api/maps/1/regions/${id}`, { method: "DELETE" }),
  createOverlay: (body: OverlayDraft) => request<MapOverlay>("/api/maps/1/overlays", { method: "POST", body: JSON.stringify(body) }),
  updateOverlay: (id: number, body: OverlayDraft) => request<MapOverlay>(`/api/maps/1/overlays/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteOverlay: (id: number) => request<void>(`/api/maps/1/overlays/${id}`, { method: "DELETE" }),
  timeline: () => request<TimelineEvent[]>("/api/timeline", { cache: "no-store" }),
  saveTimeline: (cardId: number, body: { card_id: number; sort_year: number; date_label: string; description: string }) => request(`/api/timeline/${cardId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteTimeline: (cardId: number) => request<void>(`/api/timeline/${cardId}`, { method: "DELETE" }),
  upload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ url: string; filename: string }>("/api/uploads", { method: "POST", body: form });
  },
};

export const typeMeta: Record<CardType, { label: string; icon: string }> = {
  location: { label: "Локация", icon: "⌖" },
  person: { label: "Персонаж", icon: "◒" },
  faction: { label: "Фракция", icon: "◇" },
  artifact: { label: "Артефакт", icon: "✦" },
  event: { label: "Событие", icon: "◌" },
};
