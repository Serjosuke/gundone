export type CardType = "location" | "person" | "faction" | "artifact" | "event";

export type Card = {
  id: number;
  title: string;
  type: CardType;
  excerpt: string;
  content: string;
  cover_color: string;
  cover_image_url: string | null;
  tags: string[];
  relations: number[];
  created_at: string;
  updated_at: string;
};

export type Marker = {
  id: number;
  map_id: number;
  card_id: number;
  x: number;
  y: number;
  label: string | null;
  card_title: string;
  card_type: CardType;
  card_color: string;
};

export type MapPoint = { x: number; y: number };

export type Region = {
  id: number;
  map_id: number;
  card_id: number | null;
  label: string;
  color: string;
  points: MapPoint[];
  card_title?: string | null;
  created_at: string;
  updated_at: string;
};

export type OverlayDisplayType = "illustration" | "card";

export type MapOverlay = {
  id: number;
  map_id: number;
  image_url: string;
  x: number;
  y: number;
  width: number;
  aspect_ratio: number;
  label: string | null;
  card_id: number | null;
  display_type: OverlayDisplayType;
  card_title?: string | null;
  card_type?: CardType | null;
  card_color?: string | null;
  created_at: string;
  updated_at: string;
};

export type MapPayload = {
  id: number;
  title: string;
  subtitle: string;
  image_url: string | null;
  image_aspect_ratio: number | null;
  markers: Marker[];
  regions: Region[];
  overlays: MapOverlay[];
  created_at?: string;
  updated_at?: string;
};

export type MapSummary = {
  id: number;
  title: string;
  subtitle: string;
  image_url: string | null;
  image_aspect_ratio: number | null;
  marker_count: number;
  region_count: number;
  overlay_count: number;
  created_at: string;
  updated_at: string;
};

export type MapPlacement = {
  map_id: number;
  map_title: string;
  kind: "marker" | "region" | "overlay";
  object_id: number;
  label: string | null;
};

export type TimelineEvent = {
  id: number;
  card_id: number;
  sort_year: number;
  date_label: string;
  description: string;
  card_title: string;
  card_type: CardType;
  card_color: string;
  card_image_url: string | null;
  created_at: string;
  updated_at: string;
};

export type TimelineDraft = {
  enabled: boolean;
  sort_year: number;
  date_label: string;
  description: string;
};
