"use client";

import { ChangeEvent, PointerEvent, WheelEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { api, setAdminToken, typeMeta } from "../lib/api";
import { Card, CardType, MapOverlay, MapPayload, MapPlacement, MapPoint, MapSummary, Marker, Region, TimelineDraft, TimelineEvent } from "../lib/types";

type CardDraft = Omit<Card, "id" | "created_at" | "updated_at">;
type OverlayDraft = Pick<MapOverlay, "image_url" | "x" | "y" | "width" | "aspect_ratio" | "label" | "card_id" | "display_type">;
type ViewMode = "map" | "library" | "timeline";
type MapTool = "browse" | "select" | "marker" | "region";

type Interaction =
  | { kind: "pan"; startX: number; startY: number; x: number; y: number }
  | { kind: "marker"; item: Marker }
  | { kind: "overlay"; item: MapOverlay }
  | { kind: "resize"; item: MapOverlay; startX: number; width: number }
  | { kind: "vertex"; item: Region; index: number; points: MapPoint[] }
  | null;

const blankCard = (): CardDraft => ({
  title: "Новая карточка",
  type: "location",
  subtype: "",
  excerpt: "Короткое описание для карты и библиотеки.",
  content: "## Новый раздел\nОпишите место, персонажа, событие или тайну вашего мира.",
  cover_color: "#A8C7FF",
  cover_image_url: null,
  tags: [],
  relations: [],
});

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium" }).format(new Date(value));
}

function cardKind(card: Pick<Card, "type" | "subtype">) {
  return card.subtype ? `${typeMeta[card.type].label} · ${card.subtype}` : typeMeta[card.type].label;
}

function normalizeTitle(value: string) {
  return value.trim().toLocaleLowerCase("ru-RU");
}

function wikiTargets(content: string) {
  return Array.from(content.matchAll(/\[\[([^\]]+)\]\]/g))
    .map((match) => match[1].trim().split("|", 1)[0].trim())
    .filter((target) => target && !target.startsWith("#"));
}

function MarkdownView({ content, cards, onOpenCard, onTag }: { content: string; cards: Card[]; onOpenCard: (card: Card) => void; onTag: (tag: string) => void }) {
  const renderInline = (line: string) => {
    const pieces: ReactNode[] = [];
    const token = /\[\[([^\]]+)\]\]|#([\p{L}\p{N}_-]+)/gu;
    let lastIndex = 0;
    let key = 0;
    for (const match of line.matchAll(token)) {
      const index = match.index ?? 0;
      if (index > lastIndex) pieces.push(line.slice(lastIndex, index));
      if (match[1] !== undefined) {
        const raw = match[1].trim();
        const [targetRaw, labelRaw] = raw.split("|", 2);
        const target = targetRaw.trim();
        const label = (labelRaw || target).trim();
        if (target.startsWith("#")) {
          const tag = target.slice(1).trim();
          pieces.push(<button type="button" className="inline-tag-link" key={`tag-${key++}`} onClick={() => onTag(tag)}>#{label.replace(/^#/, "")}</button>);
        } else {
          const card = cards.find((item) => normalizeTitle(item.title) === normalizeTitle(target));
          pieces.push(card
            ? <button type="button" className="wiki-link" key={`wiki-${key++}`} onClick={() => onOpenCard(card)} title={`${cardKind(card)} — ${card.excerpt || "Открыть статью"}`}>{label}</button>
            : <span className="wiki-missing" key={`missing-${key++}`} title={`Статья «${target}» пока не найдена`}>{label}</span>);
        }
      } else if (match[2]) {
        const tag = match[2];
        pieces.push(<button type="button" className="inline-tag-link" key={`short-tag-${key++}`} onClick={() => onTag(tag)}>#{tag}</button>);
      }
      lastIndex = index + match[0].length;
    }
    if (lastIndex < line.length) pieces.push(line.slice(lastIndex));
    return pieces;
  };

  return <div className="markdown">{content.split("\n").map((line, index) => {
    if (line.startsWith("## ")) return <h3 key={index}>{renderInline(line.slice(3))}</h3>;
    if (!line.trim()) return <div className="line-space" key={index} />;
    return <p key={index}>{renderInline(line)}</p>;
  })}</div>;
}

function LoginScreen({ onLogin }: { onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  return <main className="login-screen"><section className="login-card">
    <div className="brand-mark large">A</div><span className="eyebrow">Режим хранителя</span>
    <h1>Управление атласом</h1><p>Карта доступна друзьям только для просмотра. Редактор открывается по паролю.</p>
    <form onSubmit={async (event) => { event.preventDefault(); setSubmitting(true); setError(""); try { await onLogin(password); } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось войти"); } finally { setSubmitting(false); } }}>
      <label>Пароль хранителя<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Введите пароль" /></label>
      {error && <div className="form-error">{error}</div>}
      <button className="primary-button login-button" disabled={submitting}>{submitting ? "Проверяю…" : "Войти в редактор"}</button>
    </form><a href="/">← Открыть публичную карту</a>
  </section></main>;
}

function CardEditor({ initial, cards, timelineItem, onSave, onClose, onDelete, onUpload }: {
  initial: Card | null; cards: Card[]; timelineItem: TimelineEvent | null;
  onSave: (value: CardDraft, timeline: TimelineDraft) => Promise<void>;
  onClose: () => void; onDelete?: () => Promise<void>; onUpload: (file: File) => Promise<string>;
}) {
  const [value, setValue] = useState<CardDraft>(initial ? {
    title: initial.title, type: initial.type, subtype: initial.subtype || "", excerpt: initial.excerpt, content: initial.content,
    cover_color: initial.cover_color, cover_image_url: initial.cover_image_url, tags: initial.tags, relations: initial.relations,
  } : blankCard());
  const [timeline, setTimeline] = useState<TimelineDraft>({ enabled: Boolean(timelineItem), sort_year: timelineItem?.sort_year ?? 0, date_label: timelineItem?.date_label ?? "", description: timelineItem?.description ?? "" });
  const [saving, setSaving] = useState(false); const [uploading, setUploading] = useState(false); const fileRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof CardDraft>(key: K, next: CardDraft[K]) => setValue((old) => ({ ...old, [key]: next }));
  const uploadCover = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; setUploading(true); try { set("cover_image_url", await onUpload(file)); } finally { setUploading(false); event.target.value = ""; } };
  return <aside className="editor-panel"><div className="editor-head"><div><span className="eyebrow">{initial ? "Редактирование" : "Новая статья"}</span><h2>{initial?.title || "Создать карточку"}</h2></div><button className="icon-button" onClick={onClose}>×</button></div>
    <div className="editor-fields">
      <label>Название<input value={value.title} onChange={(event) => set("title", event.target.value)} /></label>
      <label>Тип<select value={value.type} onChange={(event) => set("type", event.target.value as CardType)}>{Object.entries(typeMeta).map(([key, meta]) => <option key={key} value={key}>{meta.icon} {meta.label}</option>)}</select></label>
      <label>Подтип <span>Необязательно: например, «Гость»</span><input list="subtype-suggestions" value={value.subtype} onChange={(event) => set("subtype", event.target.value)} placeholder="Например: Гость" /><datalist id="subtype-suggestions">{Array.from(new Set(cards.filter((card) => card.type === value.type && card.subtype).map((card) => card.subtype))).map((subtype) => <option key={subtype} value={subtype} />)}</datalist></label>
      <label>Короткое описание<textarea rows={3} value={value.excerpt} onChange={(event) => set("excerpt", event.target.value)} /></label>
      <label>Основной текст <span>Заголовок: ## Название · статья: [[Название]] · тег: [[#Тег]]</span><textarea rows={10} value={value.content} onChange={(event) => set("content", event.target.value)} /></label>
      <label>Теги <span>Через запятую</span><input value={value.tags.join(", ")} onChange={(event) => set("tags", event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean))} /></label>
      <label>Акцент статьи<div className="color-row"><input type="color" value={value.cover_color} onChange={(event) => set("cover_color", event.target.value)} /><code>{value.cover_color}</code></div></label>
      <div className="image-editor"><span>Обложка статьи</span>{value.cover_image_url ? <img src={value.cover_image_url} alt="Обложка" /> : <div className="image-placeholder">Изображение не выбрано</div>}<input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={uploadCover} /><div className="image-buttons"><button type="button" className="secondary-button" onClick={() => fileRef.current?.click()}>{uploading ? "Загрузка…" : "Загрузить"}</button>{value.cover_image_url && <button type="button" className="text-button" onClick={() => set("cover_image_url", null)}>Убрать</button>}</div></div>
      <label>Связанные карточки<select multiple value={value.relations.map(String)} onChange={(event) => set("relations", Array.from(event.target.selectedOptions).map((option) => Number(option.value)))}>{cards.filter((card) => card.id !== initial?.id).map((card) => <option value={card.id} key={card.id}>{card.title}</option>)}</select></label>
      <section className="timeline-editor"><div className="switch-row"><div><b>Показать на таймлайне</b><small>Связывает карточку с хронологией мира.</small></div><input type="checkbox" checked={timeline.enabled} onChange={(event) => setTimeline((old) => ({ ...old, enabled: event.target.checked }))} /></div>{timeline.enabled && <div className="timeline-fields"><label>Год для сортировки<input type="number" value={timeline.sort_year} onChange={(event) => setTimeline((old) => ({ ...old, sort_year: Number(event.target.value) }))} /></label><label>Подпись даты<input value={timeline.date_label} placeholder="Например: 132 года до Раскола" onChange={(event) => setTimeline((old) => ({ ...old, date_label: event.target.value }))} /></label><label>Что произошло<textarea rows={3} value={timeline.description} onChange={(event) => setTimeline((old) => ({ ...old, description: event.target.value }))} /></label></div>}</section>
    </div>
    <div className="editor-actions">{onDelete && <button className="danger-button" onClick={async () => { if (confirm("Удалить карточку, метки и событие таймлайна?")) await onDelete(); }}>Удалить</button>}<button className="primary-button" disabled={saving || uploading} onClick={async () => { setSaving(true); try { await onSave(value, timeline); } finally { setSaving(false); } }}>{saving ? "Сохраняю…" : "Сохранить"}</button></div>
  </aside>;
}

function MarkerPicker({ cards, onChoose, onCreate, onClose }: { cards: Card[]; onChoose: (card: Card) => void; onCreate: () => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const results = cards.filter((card) => `${card.title} ${card.excerpt}`.toLowerCase().includes(query.toLowerCase()));
  return <aside className="object-editor marker-picker"><div className="editor-head"><div><span className="eyebrow">Новая метка</span><h2>Привяжите её к статье</h2></div><button className="icon-button" onClick={onClose}>×</button></div><div className="editor-fields compact-fields"><p className="panel-note">Выберите уже существующую запись или создайте новую. Метка не бывает «пустой» — так карта и вики остаются связанными.</p><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск статьи" />{results.map((card) => <button className="picker-card" key={card.id} onClick={() => onChoose(card)}><span style={{ background: card.cover_color }}>{typeMeta[card.type].icon}</span><div><b>{card.title}</b><small>{cardKind(card)}</small></div><i>→</i></button>)}</div><div className="editor-actions"><button className="primary-button" onClick={onCreate}>+ Новая статья</button></div></aside>;
}

function RegionEditor({ region, cards, onClose, onSave, onDelete, onStartVertexEdit }: { region: Region; cards: Card[]; onClose: () => void; onSave: (value: Pick<Region, "label" | "color" | "card_id" | "points">) => Promise<void>; onDelete: () => Promise<void>; onStartVertexEdit: () => void }) {
  const [value, setValue] = useState({ label: region.label, color: region.color, card_id: region.card_id, points: region.points }); const [saving, setSaving] = useState(false);
  return <aside className="object-editor"><div className="editor-head"><div><span className="eyebrow">Регион</span><h2>{region.label}</h2></div><button className="icon-button" onClick={onClose}>×</button></div><div className="editor-fields compact-fields"><label>Название<input value={value.label} onChange={(event) => setValue((old) => ({ ...old, label: event.target.value }))} /></label><label>Цвет<div className="color-row"><input type="color" value={value.color} onChange={(event) => setValue((old) => ({ ...old, color: event.target.value }))} /><code>{value.color}</code></div></label><label>Связанная статья<select value={value.card_id ?? ""} onChange={(event) => setValue((old) => ({ ...old, card_id: event.target.value ? Number(event.target.value) : null }))}><option value="">Не привязана</option>{cards.map((card) => <option key={card.id} value={card.id}>{card.title}</option>)}</select></label><p className="panel-note">В режиме «Редактировать» перетаскивайте белые вершины контура. Всего вершин: {value.points.length}.</p></div><div className="editor-actions object-actions"><button className="danger-button" onClick={async () => { if (confirm(`Удалить регион «${region.label}»?`)) await onDelete(); }}>Удалить</button><button className="secondary-button" onClick={onStartVertexEdit}>Править контур</button><button className="primary-button" disabled={saving} onClick={async () => { setSaving(true); try { await onSave(value); } finally { setSaving(false); } }}>{saving ? "Сохраняю…" : "Сохранить"}</button></div></aside>;
}

function OverlayEditor({ overlay, cards, onClose, onSave, onDelete, onPreview }: { overlay: MapOverlay; cards: Card[]; onClose: () => void; onSave: (value: OverlayDraft) => Promise<void>; onDelete: () => Promise<void>; onPreview: (value: OverlayDraft) => void }) {
  const [value, setValue] = useState<OverlayDraft>({ image_url: overlay.image_url, x: overlay.x, y: overlay.y, width: overlay.width, aspect_ratio: overlay.aspect_ratio || 1.5, label: overlay.label || "", card_id: overlay.card_id, display_type: overlay.display_type }); const [saving, setSaving] = useState(false);
  const update = (next: Partial<OverlayDraft>) => setValue((old) => { const complete = { ...old, ...next }; onPreview(complete); return complete; });
  return <aside className="object-editor"><div className="editor-head"><div><span className="eyebrow">Объект карты</span><h2>{overlay.label || overlay.card_title || "Изображение"}</h2></div><button className="icon-button" onClick={onClose}>×</button></div><div className="editor-fields compact-fields"><img className="object-preview" src={value.image_url} alt="Предпросмотр" /><label>Формат<select value={value.display_type} onChange={(event) => update({ display_type: event.target.value as MapOverlay["display_type"], card_id: event.target.value === "illustration" ? null : value.card_id })}><option value="illustration">Иллюстрация</option><option value="card">Карточка на карте</option></select></label><label>Подпись<input value={value.label || ""} onChange={(event) => update({ label: event.target.value })} placeholder="Например: Портрет Мастера" /></label>{value.display_type === "card" && <label>Открывать статью<select value={value.card_id ?? ""} onChange={(event) => update({ card_id: event.target.value ? Number(event.target.value) : null })}><option value="">Выберите статью</option>{cards.map((card) => <option key={card.id} value={card.id}>{typeMeta[card.type].icon} {card.title}</option>)}</select></label>}<label>Размер<input type="range" min="5" max="45" value={value.width} onChange={(event) => update({ width: Number(event.target.value) })} /><small>{Math.round(value.width)}% ширины карты</small></label><p className="panel-note">В режиме «Редактировать» объект можно передвигать ЛКМ, а нижний правый угол — тянуть для изменения размера.</p></div><div className="editor-actions object-actions"><button className="danger-button" onClick={async () => { if (confirm("Удалить объект с карты?")) await onDelete(); }}>Удалить</button><button className="primary-button" disabled={saving || (value.display_type === "card" && !value.card_id)} onClick={async () => { setSaving(true); try { await onSave({ ...value, label: value.label || null }); } finally { setSaving(false); } }}>{saving ? "Сохраняю…" : "Сохранить"}</button></div></aside>;
}

function MapSurface({
  map, maps, activeMapId, selectedMarker, selectedRegion, selectedOverlay, adminMode, tool, regionDraft,
  onMapSelect, onAddMap, onToolChange, onMarkerPlace, onRegionPoint, onRegionFinish, onRegionCancel,
  onMarkerOpen, onRegionOpen, onOverlayOpen, onOpenCard, onMarkerPreview, onMarkerCommit,
  onOverlayPreview, onOverlayCommit, onOverlayResizePreview, onOverlayResizeCommit,
  onRegionPreview, onRegionCommit, onMapImageUpload, onOverlayUpload, onEditMapDetails,
}: {
  map: MapPayload; maps: MapSummary[]; activeMapId: number; selectedMarker: Marker | null; selectedRegion: Region | null; selectedOverlay: MapOverlay | null;
  adminMode: boolean; tool: MapTool; regionDraft: MapPoint[];
  onMapSelect: (id: number) => void; onAddMap: () => void; onToolChange: (tool: MapTool) => void;
  onMarkerPlace: (x: number, y: number) => void; onRegionPoint: (x: number, y: number) => void; onRegionFinish: () => void; onRegionCancel: () => void;
  onMarkerOpen: (marker: Marker) => void; onRegionOpen: (region: Region) => void; onOverlayOpen: (overlay: MapOverlay) => void; onOpenCard: (id: number) => void;
  onMarkerPreview: (marker: Marker, x: number, y: number) => void; onMarkerCommit: (marker: Marker, x: number, y: number) => void;
  onOverlayPreview: (overlay: MapOverlay, x: number, y: number) => void; onOverlayCommit: (overlay: MapOverlay, x: number, y: number) => void;
  onOverlayResizePreview: (overlay: MapOverlay, width: number) => void; onOverlayResizeCommit: (overlay: MapOverlay, width: number) => void;
  onRegionPreview: (region: Region, points: MapPoint[]) => void; onRegionCommit: (region: Region, points: MapPoint[]) => void;
  onMapImageUpload: (file: File) => Promise<void>; onOverlayUpload: (file: File, displayType: MapOverlay["display_type"]) => Promise<void>; onEditMapDetails: () => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const mapFileRef = useRef<HTMLInputElement>(null);
  const illustrationFileRef = useRef<HTMLInputElement>(null);
  const cardFileRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [detectedAspect, setDetectedAspect] = useState<number | null>(null);
  const interaction = useRef<Interaction>(null);
  const moved = useRef(false);

  const aspect = clamp(map.image_aspect_ratio || detectedAspect || 1.6, 0.25, 4);
  const worldSize = useMemo(() => {
    if (!viewport.width || !viewport.height) return { width: 1, height: 1 };
    const viewportAspect = viewport.width / viewport.height;
    return aspect >= viewportAspect
      ? { width: viewport.width, height: viewport.width / aspect }
      : { width: viewport.height * aspect, height: viewport.height };
  }, [aspect, viewport]);

  useEffect(() => {
    setView({ x: 0, y: 0, scale: 1 });
    setDetectedAspect(null);
  }, [map.id, map.image_url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => {
      const rect = canvas.getBoundingClientRect();
      setViewport({ width: Math.max(0, rect.width), height: Math.max(0, rect.height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const pointFrom = (event: { clientX: number; clientY: number }, clampToBounds = true) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const left = rect.left + rect.width / 2 + view.x - (worldSize.width * view.scale) / 2;
    const top = rect.top + rect.height / 2 + view.y - (worldSize.height * view.scale) / 2;
    const rawX = ((event.clientX - left) / Math.max(1, worldSize.width * view.scale)) * 100;
    const rawY = ((event.clientY - top) / Math.max(1, worldSize.height * view.scale)) * 100;
    return {
      x: clampToBounds ? clamp(rawX, 0, 100) : rawX,
      y: clampToBounds ? clamp(rawY, 0, 100) : rawY,
      inside: rawX >= 0 && rawX <= 100 && rawY >= 0 && rawY <= 100,
    };
  };

  const zoomTo = (nextScale: number, clientX?: number, clientY?: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    setView((old) => {
      const scale = clamp(nextScale, 0.6, 4);
      if (!rect || clientX === undefined || clientY === undefined) return { ...old, scale };
      const cursorX = clientX - rect.left;
      const cursorY = clientY - rect.top;
      const oldCenterX = rect.width / 2 + old.x;
      const oldCenterY = rect.height / 2 + old.y;
      const worldOffsetX = (cursorX - oldCenterX) / old.scale;
      const worldOffsetY = (cursorY - oldCenterY) / old.scale;
      return {
        scale,
        x: cursorX - rect.width / 2 - worldOffsetX * scale,
        y: cursorY - rect.height / 2 - worldOffsetY * scale,
      };
    });
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const multiplier = Math.exp(-event.deltaY * 0.00135);
    setView((old) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return old;
      const scale = clamp(old.scale * multiplier, 0.6, 4);
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const oldCenterX = rect.width / 2 + old.x;
      const oldCenterY = rect.height / 2 + old.y;
      const worldOffsetX = (cursorX - oldCenterX) / old.scale;
      const worldOffsetY = (cursorY - oldCenterY) / old.scale;
      return {
        scale,
        x: cursorX - rect.width / 2 - worldOffsetX * scale,
        y: cursorY - rect.height / 2 - worldOffsetY * scale,
      };
    });
  };

  const start = (event: PointerEvent<Element>, item: Interaction) => {
    canvasRef.current?.setPointerCapture(event.pointerId);
    interaction.current = item;
    moved.current = false;
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const action = interaction.current;
    if (!action) return;
    if (action.kind === "pan") {
      const dx = event.clientX - action.startX;
      const dy = event.clientY - action.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true;
      setView((old) => ({ ...old, x: action.x + dx, y: action.y + dy }));
      return;
    }
    if (action.kind === "marker") {
      const p = pointFrom(event); moved.current = true; onMarkerPreview(action.item, p.x, p.y); return;
    }
    if (action.kind === "overlay") {
      const p = pointFrom(event); moved.current = true; onOverlayPreview(action.item, p.x, p.y); return;
    }
    if (action.kind === "resize") {
      const width = clamp(action.width + ((event.clientX - action.startX) / Math.max(1, worldSize.width * view.scale)) * 100, 5, 45);
      moved.current = true; onOverlayResizePreview(action.item, width); return;
    }
    if (action.kind === "vertex") {
      const p = pointFrom(event);
      const points = action.points.map((item, index) => index === action.index ? { x: p.x, y: p.y } : item);
      moved.current = true; onRegionPreview(action.item, points);
    }
  };

  const end = (event: PointerEvent<HTMLDivElement>) => {
    const action = interaction.current;
    if (!action) return;
    if (action.kind === "marker") {
      const p = pointFrom(event); onMarkerCommit(action.item, p.x, p.y);
    } else if (action.kind === "overlay") {
      const p = pointFrom(event); onOverlayCommit(action.item, p.x, p.y);
    } else if (action.kind === "resize") {
      const width = clamp(action.width + ((event.clientX - action.startX) / Math.max(1, worldSize.width * view.scale)) * 100, 5, 45);
      onOverlayResizeCommit(action.item, width);
    } else if (action.kind === "vertex") {
      const p = pointFrom(event);
      const points = action.points.map((item, index) => index === action.index ? { x: p.x, y: p.y } : item);
      onRegionCommit(action.item, points);
    }
    interaction.current = null;
    if (canvasRef.current?.hasPointerCapture(event.pointerId)) canvasRef.current.releasePointerCapture(event.pointerId);
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>, target: "map" | "illustration" | "card") => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (target === "map") await onMapImageUpload(file);
      else await onOverlayUpload(file, target === "card" ? "card" : "illustration");
    } finally {
      event.target.value = "";
    }
  };

  const draft = regionDraft.map((point) => `${point.x},${point.y}`).join(" ");
  const hint = tool === "browse"
    ? "Обзор: колесо — масштаб, ЛКМ по свободному полю — перемещение, по объекту — открыть."
    : tool === "select"
      ? "Редактирование: тяните метки, изображения и белые вершины ЛКМ. Размер объекта — за зелёную ручку."
      : tool === "marker"
        ? "Нажмите в пределах изображения карты, затем выберите статью для новой метки."
        : "Ставьте вершины в пределах изображения. Когда готовы — сохраните контур.";
  const styleForOverlay = (overlay: MapOverlay): CSSProperties => ({
    left: `${overlay.x}%`, top: `${overlay.y}%`, width: `${overlay.width}%`, "--overlay-aspect": String(overlay.aspect_ratio || 1.5),
  } as CSSProperties);

  return <section className="map-stage">
    <div className="map-toolbar">
      <div>
        <span className="eyebrow">Интерактивная карта</span>
        <h1>{map.title}</h1>
        <p>{map.subtitle || "Добавьте короткое описание карты в настройках."}</p>
      </div>
      <div className="map-toolbar-actions">
        <label className="map-switcher">
          <span>Карта</span>
          <select value={activeMapId} onChange={(event) => onMapSelect(Number(event.target.value))}>
            {maps.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}
          </select>
        </label>
        {adminMode && <button className="map-add-button" onClick={onAddMap}>+ Карта</button>}
        <div className="map-controls">
          <button className="round-control" title="Приблизить" onClick={() => zoomTo(view.scale + .15)}>+</button>
          <button className="round-control" title="Отдалить" onClick={() => zoomTo(view.scale - .15)}>−</button>
          <button className="round-control reset" title="Сбросить вид" onClick={() => setView({ x: 0, y: 0, scale: 1 })}>↺</button>
          <span className="zoom-readout">{Math.round(view.scale * 100)}%</span>
        </div>
      </div>
    </div>

    {adminMode && <div className="map-editor-tools">
      <div className="tool-group">
        <button className={tool === "browse" ? "active" : ""} onClick={() => onToolChange("browse")}>✋ Обзор</button>
        <button className={tool === "select" ? "active" : ""} onClick={() => onToolChange("select")}>↖ Редактировать</button>
        <button className={tool === "marker" ? "active" : ""} onClick={() => onToolChange("marker")}>⌖ Метка</button>
        <button className={tool === "region" ? "active" : ""} onClick={() => onToolChange("region")}>⬡ Регион</button>
      </div>
      <div className="tool-group utility-tools">
        <input ref={mapFileRef} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => upload(event, "map")} />
        <input ref={illustrationFileRef} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => upload(event, "illustration")} />
        <input ref={cardFileRef} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => upload(event, "card")} />
        <button onClick={onEditMapDetails}>✎ Настройки</button>
        <button onClick={() => mapFileRef.current?.click()}>↑ Фон</button>
        <button onClick={() => illustrationFileRef.current?.click()}>+ Изображение</button>
        <button className="strong-upload" onClick={() => cardFileRef.current?.click()}>+ Карточка</button>
      </div>
    </div>}

    <div
      ref={canvasRef}
      className={`map-canvas is-tool-${tool}`}
      onWheel={onWheel}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className={`map-world ${map.image_url ? "has-image" : ""}`}
        style={{
          width: `${worldSize.width}px`, height: `${worldSize.height}px`,
          left: `calc(50% + ${view.x}px)`, top: `calc(50% + ${view.y}px)`,
          transform: `translate(-50%, -50%) scale(${view.scale})`,
        }}
        onPointerDown={(event) => {
          if (tool === "browse" && event.target === event.currentTarget) {
            start(event, { kind: "pan", startX: event.clientX, startY: event.clientY, x: view.x, y: view.y });
          }
        }}
        onClick={(event) => {
          if (moved.current) { moved.current = false; return; }
          if (event.target !== event.currentTarget) return;
          const p = pointFrom(event, false);
          if (!p.inside) return;
          if (tool === "marker") onMarkerPlace(p.x, p.y);
          if (tool === "region") onRegionPoint(p.x, p.y);
        }}
      >
        {map.image_url ? <img className="map-background-image" src={map.image_url} alt={`Фон карты «${map.title}»`} draggable={false} onLoad={(event) => {
          const image = event.currentTarget;
          if (image.naturalWidth > 0 && image.naturalHeight > 0) setDetectedAspect(image.naturalWidth / image.naturalHeight);
        }} /> : <>
          <div className="map-glow one" /><div className="map-glow two" />
          <div className="map-label label-a">СОЛЁНОЕ МОРЕ</div><div className="map-label label-b">ТИХИЕ ПОЛЯ</div><div className="map-label label-c">ПЕПЕЛЬНЫЕ ЗЕМЛИ</div>
        </>}

        <svg className="regions-layer" viewBox="0 0 100 100" preserveAspectRatio="none">
          {map.regions.map((region) => <polygon
            key={region.id}
            className={selectedRegion?.id === region.id ? "is-selected" : ""}
            points={region.points.map((point) => `${point.x},${point.y}`).join(" ")}
            fill={region.color} stroke={region.color}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); onRegionOpen(region); }}
          />)}
          {regionDraft.length > 1 && <polyline className="region-draft" points={draft} />}
          {regionDraft.map((point, index) => <circle key={`${point.x}-${point.y}-${index}`} className="region-dot" cx={point.x} cy={point.y} r=".7" />)}
          {adminMode && tool === "select" && selectedRegion?.points.map((point, index) => <circle
            key={`vertex-${index}`} className="region-vertex" cx={point.x} cy={point.y} r="1.15"
            onPointerDown={(event) => {
              event.preventDefault(); event.stopPropagation();
              start(event, { kind: "vertex", item: selectedRegion, index, points: selectedRegion.points });
            }}
          />)}
        </svg>

        {map.overlays.map((overlay) => <button
          key={overlay.id}
          className={`map-overlay ${overlay.display_type === "card" ? "map-card-overlay" : ""} ${selectedOverlay?.id === overlay.id ? "is-selected" : ""}`}
          style={styleForOverlay(overlay)}
          title={overlay.label || overlay.card_title || "Изображение"}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (adminMode && tool === "select") { event.preventDefault(); start(event, { kind: "overlay", item: overlay }); }
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (moved.current) { moved.current = false; return; }
            if (adminMode) onOverlayOpen(overlay);
            else if (overlay.card_id) onOpenCard(overlay.card_id);
          }}
        >
          <span className="overlay-image"><img draggable={false} src={overlay.image_url} alt={overlay.label || overlay.card_title || "Изображение на карте"} /></span>
          {overlay.display_type === "card" && <span className="overlay-card-caption"><small>Статья</small><b>{overlay.label || overlay.card_title || "Выберите статью"}</b></span>}
          {adminMode && tool === "select" && selectedOverlay?.id === overlay.id && <span
            className="resize-handle" title="Тяните, чтобы изменить размер"
            onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); start(event, { kind: "resize", item: overlay, startX: event.clientX, width: overlay.width }); }}
          />}
        </button>)}

        {map.markers.map((marker) => <button
          key={marker.id} aria-label={marker.label || marker.card_title}
          className={`marker ${selectedMarker?.id === marker.id ? "is-selected" : ""}`}
          style={{ left: `${marker.x}%`, top: `${marker.y}%`, "--marker-color": marker.card_color } as CSSProperties}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (adminMode && tool === "select") { event.preventDefault(); start(event, { kind: "marker", item: marker }); }
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (moved.current) { moved.current = false; return; }
            onMarkerOpen(marker);
          }}
        >
          <span className="marker-pulse" /><span className="marker-core"><i>{typeMeta[marker.card_type].icon}</i></span>
          <span className="marker-name">{marker.label || marker.card_title}</span>
        </button>)}
      </div>
      <div className="map-ratio-note">{map.image_url ? "Оригинальные пропорции карты" : "Черновой фон — загрузите карту в редакторе"}</div>
      {adminMode && <div className={`map-edit-hint ${tool === "region" ? "region-hint" : ""}`}>
        <span>{hint}</span>
        {tool === "region" && <>
          <button disabled={regionDraft.length < 3} onClick={onRegionFinish}>Сохранить</button>
          {regionDraft.length > 0 && <button className="hint-cancel" onClick={onRegionCancel}>Отменить</button>}
        </>}
      </div>}
    </div>
  </section>;
}

function LibraryView({ cards, onSelect, onTag, title, description }: { cards: Card[]; onSelect: (card: Card) => void; onTag: (tag: string) => void; title?: string; description?: string }) {
  return <section className="catalog-view"><div className="content-heading"><span className="eyebrow">Библиотека мира</span><h1>{title || "Все статьи"}</h1><p>{description || "Места, персонажи, фракции, артефакты и исторические события."}</p></div><div className="library-grid">{cards.map((card) => <article className="library-card" key={card.id}><button className="library-card-main" onClick={() => onSelect(card)}><div className="library-cover" style={{ background: card.cover_image_url ? `linear-gradient(rgba(20,17,25,.14),rgba(20,17,25,.48)),url("${card.cover_image_url}") center/cover` : `linear-gradient(145deg,${card.cover_color},#211a2a)` }}><span>{typeMeta[card.type].icon}</span></div><div><small>{cardKind(card)}</small><h2>{card.title}</h2><p>{card.excerpt}</p></div></button><div className="card-tags">{card.tags.slice(0, 4).map((tag) => <button type="button" key={tag} onClick={() => onTag(tag)}>#{tag}</button>)}</div></article>)}</div>{!cards.length && <div className="empty-state">Ничего не найдено. Попробуйте изменить поиск, тип или подтип.</div>}</section>;
}
function TimelineView({ events, onSelect }: { events: TimelineEvent[]; onSelect: (id: number) => void }) { return <section className="timeline-view"><div className="content-heading"><span className="eyebrow">История мира</span><h1>Таймлайн</h1><p>События и статьи, расположенные по хронологии.</p></div>{events.length ? <div className="timeline-list">{events.map((event) => <button className="timeline-card" key={event.id} onClick={() => onSelect(event.card_id)}><time className="timeline-year">{event.date_label}</time><span className="timeline-pin" style={{ borderColor: event.card_color }} /><div className="timeline-entry"><span>{event.card_subtype ? `${typeMeta[event.card_type].label} · ${event.card_subtype}` : typeMeta[event.card_type].label}</span><h2>{event.card_title}</h2><p>{event.description}</p></div></button>)}</div> : <div className="empty-state">Пока нет записей. В редакторе включите «Показать на таймлайне» для любой карточки.</div>}</section>; }

export function AtlasApp({ adminMode = false }: { adminMode?: boolean }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [maps, setMaps] = useState<MapSummary[]>([]);
  const [activeMapId, setActiveMapId] = useState<number | null>(null);
  const [map, setMap] = useState<MapPayload | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [placements, setPlacements] = useState<MapPlacement[]>([]);

  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [selectedMarkerId, setSelectedMarkerId] = useState<number | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<number | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<number | null>(null);
  const [editingCard, setEditingCard] = useState<Card | "new" | null>(null);
  const [pendingPoint, setPendingPoint] = useState<MapPoint | null>(null);
  const [markerPicker, setMarkerPicker] = useState(false);
  const [tool, setTool] = useState<MapTool>("browse");
  const [regionDraft, setRegionDraft] = useState<MapPoint[]>([]);
  const [view, setView] = useState<ViewMode>("map");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CardType | "all">("all");
  const [subtypeFilter, setSubtypeFilter] = useState("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [authState, setAuthState] = useState<"checking" | "guest" | "ready">(adminMode ? "checking" : "ready");

  const selectedCard = cards.find((card) => card.id === selectedCardId) || null;
  const selectedMarker = map?.markers.find((marker) => marker.id === selectedMarkerId) || null;
  const selectedRegion = map?.regions.find((region) => region.id === selectedRegionId) || null;
  const selectedOverlay = map?.overlays.find((overlay) => overlay.id === selectedOverlayId) || null;
  const availableSubtypes = useMemo(() => Array.from(new Set(
    cards
      .filter((card) => (filter === "all" || card.type === filter) && card.subtype.trim())
      .map((card) => card.subtype.trim())
  )).sort((a, b) => a.localeCompare(b, "ru")), [cards, filter]);

  const visibleCards = useMemo(() => cards.filter((card) => {
    const rawQuery = query.trim();
    const normalizedQuery = rawQuery.toLocaleLowerCase("ru-RU");
    const isTagQuery = rawQuery.startsWith("#");
    const tagQuery = normalizedQuery.slice(1).trim();
    const searchable = `${card.title} ${card.subtype} ${card.excerpt} ${card.tags.join(" ")}`.toLocaleLowerCase("ru-RU");
    const queryMatches = isTagQuery
      ? card.tags.some((tag) => tag.toLocaleLowerCase("ru-RU") === tagQuery)
      : searchable.includes(normalizedQuery);
    return (filter === "all" || card.type === filter)
      && (subtypeFilter === "all" || normalizeTitle(card.subtype) === normalizeTitle(subtypeFilter))
      && queryMatches;
  }), [cards, filter, subtypeFilter, query]);

  const selectedBacklinks = useMemo(() => {
    if (!selectedCard) return [] as Card[];
    const title = normalizeTitle(selectedCard.title);
    return cards.filter((card) => card.id !== selectedCard.id && (
      card.relations.includes(selectedCard.id)
      || wikiTargets(card.content).some((target) => normalizeTitle(target) === title)
    ));
  }, [cards, selectedCard]);

  const focusTag = (tag: string) => {
    setQuery(`#${tag}`);
    setFilter("all");
    setSubtypeFilter("all");
    setView("library");
  };

  const clearMapSelection = () => {
    setSelectedMarkerId(null);
    setSelectedRegionId(null);
    setSelectedOverlayId(null);
    setRegionDraft([]);
    setTool("browse");
  };

  const reload = async (requestedMapId?: number) => {
    const [nextCards, nextMaps, nextTimeline] = await Promise.all([api.cards(), api.maps(), api.timeline()]);
    const wantedId = requestedMapId ?? activeMapId ?? nextMaps[0]?.id;
    if (!wantedId) throw new Error("В атласе нет доступных карт");
    const nextMap = await api.map(wantedId);
    setCards(nextCards);
    setMaps(nextMaps);
    setTimeline(nextTimeline);
    setMap(nextMap);
    setActiveMapId(wantedId);
    if (typeof window !== "undefined") window.localStorage.setItem("atlas-forge-active-map", String(wantedId));
    return nextMap;
  };

  const chooseMap = async (mapId: number, focus?: MapPlacement) => {
    try {
      const nextMap = await api.map(mapId);
      setMap(nextMap);
      setActiveMapId(mapId);
      if (typeof window !== "undefined") window.localStorage.setItem("atlas-forge-active-map", String(mapId));
      setSelectedMarkerId(focus?.kind === "marker" ? focus.object_id : null);
      setSelectedRegionId(focus?.kind === "region" ? focus.object_id : null);
      setSelectedOverlayId(focus?.kind === "overlay" ? focus.object_id : null);
      setRegionDraft([]);
      setTool("browse");
      setView("map");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось открыть карту.");
    }
  };

  useEffect(() => {
    if (!adminMode) return;
    const token = window.localStorage.getItem("atlas-forge-admin-token");
    if (!token) { setAuthState("guest"); return; }
    setAdminToken(token);
    api.me().then(() => setAuthState("ready")).catch(() => {
      window.localStorage.removeItem("atlas-forge-admin-token");
      setAdminToken(null);
      setAuthState("guest");
    });
  }, [adminMode]);

  useEffect(() => {
    if (authState !== "ready") return;
    const load = async () => {
      try {
        const initialMaps = await api.maps();
        const stored = typeof window !== "undefined" ? Number(window.localStorage.getItem("atlas-forge-active-map")) : NaN;
        const requested = initialMaps.some((item) => item.id === stored) ? stored : initialMaps[0]?.id;
        await reload(requested);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Не удалось подключиться к API.");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [authState]);

  useEffect(() => {
    if (!selectedCardId) { setPlacements([]); return; }
    api.placements(selectedCardId).then(setPlacements).catch(() => setPlacements([]));
  }, [selectedCardId]);

  const login = async (password: string) => {
    const result = await api.login(password);
    window.localStorage.setItem("atlas-forge-admin-token", result.access_token);
    setAdminToken(result.access_token);
    setAuthState("ready");
  };

  const logout = () => {
    window.localStorage.removeItem("atlas-forge-admin-token");
    setAdminToken(null);
    setAuthState("guest");
  };

  const openCard = (card: Card, preserveMapObject = false) => {
    setSelectedCardId(card.id);
    if (!preserveMapObject) {
      setSelectedMarkerId(null);
      setSelectedRegionId(null);
      setSelectedOverlayId(null);
    }
  };

  const focusPlacement = async (placement: MapPlacement) => {
    setSelectedCardId(selectedCardId);
    await chooseMap(placement.map_id, placement);
  };

  async function upload(file: File) {
    try { return (await api.upload(file)).url; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось загрузить изображение."); throw cause; }
  }

  async function fileAspect(file: File) {
    return new Promise<number>((resolve) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { const ratio = clamp(image.naturalWidth / Math.max(1, image.naturalHeight), .3, 3.5); URL.revokeObjectURL(url); resolve(ratio); };
      image.onerror = () => { URL.revokeObjectURL(url); resolve(1.5); };
      image.src = url;
    });
  }

  async function saveCard(value: CardDraft, timelineDraft: TimelineDraft) {
    try {
      const saved = editingCard === "new" ? await api.createCard(value) : await api.updateCard(editingCard!.id, value);
      if (timelineDraft.enabled) {
        await api.saveTimeline(saved.id, { card_id: saved.id, sort_year: timelineDraft.sort_year, date_label: timelineDraft.date_label || String(timelineDraft.sort_year), description: timelineDraft.description || saved.excerpt });
      } else if (timeline.some((item) => item.card_id === saved.id)) {
        await api.deleteTimeline(saved.id);
      }
      if (pendingPoint && activeMapId) await api.createMarker(activeMapId, { card_id: saved.id, ...pendingPoint, label: saved.title });
      await reload(activeMapId ?? undefined);
      setSelectedCardId(saved.id);
      setEditingCard(null);
      setPendingPoint(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить карточку."); }
  }

  async function removeCard() {
    if (!editingCard || editingCard === "new") return;
    try {
      await api.deleteCard(editingCard.id);
      await reload(activeMapId ?? undefined);
      setSelectedCardId(null); setSelectedMarkerId(null); setEditingCard(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось удалить статью."); }
  }

  function previewMarker(marker: Marker, x: number, y: number) {
    setMap((old) => old ? { ...old, markers: old.markers.map((item) => item.id === marker.id ? { ...item, x, y } : item) } : old);
  }
  async function commitMarker(marker: Marker, x: number, y: number) {
    if (!activeMapId) return;
    try { await api.updateMarker(activeMapId, marker.id, { card_id: marker.card_id, x, y, label: marker.label }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Позиция метки не сохранилась."); await reload(activeMapId); }
  }
  function previewOverlay(overlay: MapOverlay, x: number, y: number) {
    setMap((old) => old ? { ...old, overlays: old.overlays.map((item) => item.id === overlay.id ? { ...item, x, y } : item) } : old);
  }
  function previewOverlayDetails(id: number, details: Partial<OverlayDraft>) {
    setMap((old) => old ? { ...old, overlays: old.overlays.map((item) => item.id === id ? { ...item, ...details } : item) } : old);
  }
  async function commitOverlay(overlay: MapOverlay, x: number, y: number) {
    if (!activeMapId) return;
    try { await api.updateOverlay(activeMapId, overlay.id, { image_url: overlay.image_url, x, y, width: overlay.width, aspect_ratio: overlay.aspect_ratio || 1.5, label: overlay.label, card_id: overlay.card_id, display_type: overlay.display_type }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Позиция объекта не сохранилась."); await reload(activeMapId); }
  }
  function previewResize(overlay: MapOverlay, width: number) { previewOverlayDetails(overlay.id, { width }); }
  async function commitResize(overlay: MapOverlay, width: number) {
    if (!activeMapId) return;
    try { await api.updateOverlay(activeMapId, overlay.id, { image_url: overlay.image_url, x: overlay.x, y: overlay.y, width, aspect_ratio: overlay.aspect_ratio || 1.5, label: overlay.label, card_id: overlay.card_id, display_type: overlay.display_type }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Размер объекта не сохранился."); await reload(activeMapId); }
  }
  function previewRegion(region: Region, points: MapPoint[]) {
    setMap((old) => old ? { ...old, regions: old.regions.map((item) => item.id === region.id ? { ...item, points } : item) } : old);
  }
  async function commitRegionPoints(region: Region, points: MapPoint[]) {
    if (!activeMapId) return;
    try { await api.updateRegion(activeMapId, region.id, { label: region.label, color: region.color, card_id: region.card_id, points }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Контур не сохранился."); await reload(activeMapId); }
  }

  async function uploadMapImage(file: File) {
    if (!map || !activeMapId) return;
    try {
      const [image_url, image_aspect_ratio] = await Promise.all([upload(file), fileAspect(file)]);
      await api.updateMap(activeMapId, { title: map.title, subtitle: map.subtitle, image_url, image_aspect_ratio });
      await reload(activeMapId);
    } catch { /* message is set by upload */ }
  }
  async function editMapDetails() {
    if (!map || !activeMapId) return;
    const title = window.prompt("Название карты", map.title);
    if (!title) return;
    const subtitle = window.prompt("Подзаголовок карты", map.subtitle);
    if (subtitle === null) return;
    try { await api.updateMap(activeMapId, { title, subtitle, image_url: map.image_url, image_aspect_ratio: map.image_aspect_ratio ?? null }); await reload(activeMapId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось обновить настройки карты."); }
  }
  async function addMap() {
    const title = window.prompt("Название новой карты", "Новая карта");
    if (!title?.trim()) return;
    const subtitle = window.prompt("Короткое описание", "") ?? "";
    try {
      const saved = await api.createMap({ title: title.trim(), subtitle, image_url: null, image_aspect_ratio: null });
      clearMapSelection();
      await reload(saved.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось создать карту."); }
  }
  async function deleteCurrentMap() {
    if (!activeMapId || !map) return;
    if (maps.length <= 1) { setError("Нельзя удалить последнюю карту мира."); return; }
    if (!window.confirm(`Удалить карту «${map.title}»? Метки, регионы и изображения этой карты удалятся, статьи останутся в библиотеке.`)) return;
    try {
      await api.deleteMap(activeMapId);
      const fallback = maps.find((item) => item.id !== activeMapId);
      clearMapSelection();
      await reload(fallback?.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось удалить карту."); }
  }
  async function uploadOverlay(file: File, display_type: MapOverlay["display_type"]) {
    if (!activeMapId) return;
    try {
      const [image_url, aspect_ratio] = await Promise.all([upload(file), fileAspect(file)]);
      const saved = await api.createOverlay(activeMapId, { image_url, aspect_ratio, x: 50, y: 50, width: display_type === "card" ? 18 : 16, label: file.name.replace(/\.[^.]+$/, ""), card_id: null, display_type });
      await reload(activeMapId);
      setSelectedOverlayId(saved.id); setSelectedRegionId(null); setTool("select");
    } catch { /* message is set above */ }
  }
  async function createMarker(card: Card) {
    if (!pendingPoint || !activeMapId) return;
    try {
      await api.createMarker(activeMapId, { card_id: card.id, ...pendingPoint, label: card.title });
      await reload(activeMapId);
      setSelectedCardId(card.id); setMarkerPicker(false); setPendingPoint(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось создать метку."); }
  }
  async function finishRegion() {
    if (regionDraft.length < 3 || !activeMapId) return;
    const label = window.prompt("Название региона", "Новый регион");
    if (!label) return;
    try {
      const saved = await api.createRegion(activeMapId, { label, points: regionDraft, color: "#C7F36C", card_id: null });
      await reload(activeMapId); setSelectedRegionId(saved.id); setRegionDraft([]); setTool("select");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить регион."); }
  }
  async function saveRegion(value: Pick<Region, "label" | "color" | "card_id" | "points">) {
    if (!selectedRegion || !activeMapId) return;
    try { await api.updateRegion(activeMapId, selectedRegion.id, value); await reload(activeMapId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить регион."); }
  }
  async function deleteRegion(id: number) {
    if (!activeMapId) return;
    try { await api.deleteRegion(activeMapId, id); await reload(activeMapId); setSelectedRegionId(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось удалить регион."); }
  }
  async function saveOverlay(value: OverlayDraft) {
    if (!selectedOverlay || !activeMapId) return;
    try { await api.updateOverlay(activeMapId, selectedOverlay.id, value); await reload(activeMapId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить объект."); }
  }
  async function deleteOverlay(id: number) {
    if (!activeMapId) return;
    try { await api.deleteOverlay(activeMapId, id); await reload(activeMapId); setSelectedOverlayId(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось удалить объект."); }
  }
  async function deleteSelectedMarker() {
    if (!selectedMarker || !activeMapId) return;
    try { await api.deleteMarker(activeMapId, selectedMarker.id); await reload(activeMapId); setSelectedMarkerId(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось удалить метку."); }
  }

  const changeTool = (next: MapTool) => { setTool(next); if (next !== "region") setRegionDraft([]); };

  if (adminMode && authState === "checking") return <main className="loading-screen"><div className="orb" /><p>Проверяем доступ хранителя…</p></main>;
  if (adminMode && authState === "guest") return <LoginScreen onLogin={login} />;
  if (loading) return <main className="loading-screen"><div className="orb" /><p>Собираем атлас…</p></main>;

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href={adminMode ? "/admin" : "/"}><span className="brand-mark">A</span><span><b>Timur Gandon</b><small>{adminMode ? "keeper console" : "world encyclopedia"}</small></span></a>
      <div className="topbar-actions">
        {adminMode ? <><a className="ghost-link" href="/" target="_blank">Публичный сайт ↗</a><button className="ghost-button" onClick={logout}>Выйти</button><button className="primary-button" onClick={() => setEditingCard("new")}>+ Статья</button></> : <a className="ghost-link" href="/admin">Войти хранителю</a>}
      </div>
    </header>

    <aside className="left-sidebar">
      <nav className="main-nav">
        <button className={view === "map" ? "active" : ""} onClick={() => setView("map")}>⌖ Карта</button>
        <button className={view === "library" ? "active" : ""} onClick={() => setView("library")}>▤ Библиотека <span>{cards.length}</span></button>
        <button className={view === "timeline" ? "active" : ""} onClick={() => setView("timeline")}>⌁ Таймлайн <span>{timeline.length}</span></button>
      </nav>
      <div className="sidebar-intro"><span className="eyebrow">Сделано Сержом за шаурму и энергос</span><p>{adminMode ? "Редактор карт и связанной wiki." : "Живой атлас мест, людей, событий и тайн."}</p></div>
      <div className="search-box"><span>⌕</span><input placeholder="Искать в энциклопедии" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>⌘K</kbd></div>
      <div className="filter-row"><button className={filter === "all" ? "active" : ""} onClick={() => { setFilter("all"); setSubtypeFilter("all"); }}>Все <span>{cards.length}</span></button>{Object.entries(typeMeta).map(([key, meta]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => { setFilter(key as CardType); setSubtypeFilter("all"); }}>{meta.icon} <span>{meta.label}</span></button>)}</div>
      {availableSubtypes.length > 0 && <div className="subtype-row"><button className={subtypeFilter === "all" ? "active" : ""} onClick={() => setSubtypeFilter("all")}>Все подтипы</button>{availableSubtypes.map((subtype) => <button key={subtype} className={subtypeFilter === subtype ? "active" : ""} onClick={() => setSubtypeFilter(subtype)}>{subtype}</button>)}</div>}

      {view === "map" && <section className="map-list-panel">
        <div className="side-section-title">Карты <span>{maps.length}</span></div>
        <div className="map-list">
          {maps.map((item) => <button className={`map-list-item ${item.id === activeMapId ? "selected" : ""}`} key={item.id} onClick={() => void chooseMap(item.id)}>
            <span className="map-thumb" style={{ backgroundImage: item.image_url ? `url("${item.image_url}")` : undefined }} />
            <span><b>{item.title}</b><small>{item.marker_count} меток · {item.region_count} регионов</small></span>
          </button>)}
        </div>
        {adminMode && <button className="create-map-button" onClick={() => void addMap()}>+ Добавить карту</button>}
      </section>}

      <div className="card-list">{visibleCards.slice(0, view === "library" ? cards.length : 10).map((card) => <button key={card.id} onClick={() => openCard(card)} className={`list-card ${selectedCardId === card.id ? "selected" : ""}`}><span className="list-icon" style={{ background: card.cover_color }}>{typeMeta[card.type].icon}</span><span><b>{card.title}</b><small>{cardKind(card)}</small></span><i>→</i></button>)}{!visibleCards.length && <p className="empty">Ничего не найдено</p>}</div>

      {adminMode && map && view === "map" && <section className="map-assets">
        <div className="side-section-title">Регионы <span>{map.regions.length}</span></div>
        {map.regions.map((region) => <div className="asset-row" key={region.id}><button className="asset-open" onClick={() => { setSelectedRegionId(region.id); setSelectedOverlayId(null); }}><span style={{ background: region.color }} /><b>{region.label}</b></button><button title="Удалить регион" onClick={() => { if (confirm(`Удалить регион «${region.label}»?`)) void deleteRegion(region.id); }}>×</button></div>)}
        <div className="side-section-title top-space">Объекты <span>{map.overlays.length}</span></div>
        {map.overlays.map((overlay) => <div className="asset-row" key={overlay.id}><button className="asset-open" onClick={() => { setSelectedOverlayId(overlay.id); setSelectedRegionId(null); }}><img src={overlay.image_url} alt="" /><b>{overlay.label || overlay.card_title || "Изображение"}</b></button><button title="Удалить объект" onClick={() => { if (confirm("Удалить объект с карты?")) void deleteOverlay(overlay.id); }}>×</button></div>)}
        <div className="map-danger-zone"><button className="text-button danger-text" disabled={maps.length <= 1} onClick={() => void deleteCurrentMap()}>Удалить эту карту</button></div>
      </section>}
      <footer><span>{adminMode ? "Доступ: хранитель" : "Только просмотр"}</span><span>•</span><span>v0.7</span></footer>
    </aside>

    <div className="content-area">
      {error && <div className="toast">{error}<button onClick={() => setError("")}>×</button></div>}
      {view === "map" && map && activeMapId && <MapSurface
        map={map} maps={maps} activeMapId={activeMapId} selectedMarker={selectedMarker} selectedRegion={selectedRegion} selectedOverlay={selectedOverlay}
        adminMode={adminMode} tool={tool} regionDraft={regionDraft}
        onMapSelect={(id) => void chooseMap(id)} onAddMap={() => void addMap()} onToolChange={changeTool}
        onMarkerPlace={(x, y) => { setPendingPoint({ x, y }); setMarkerPicker(true); }}
        onRegionPoint={(x, y) => setRegionDraft((old) => [...old, { x, y }])}
        onRegionFinish={() => void finishRegion()} onRegionCancel={() => setRegionDraft([])}
        onMarkerOpen={(marker) => { setSelectedMarkerId(marker.id); setSelectedCardId(marker.card_id); setSelectedRegionId(null); setSelectedOverlayId(null); }}
        onRegionOpen={(region) => { if (adminMode) { setSelectedRegionId(region.id); setSelectedOverlayId(null); setSelectedMarkerId(null); } else if (region.card_id) { const card = cards.find((item) => item.id === region.card_id); if (card) openCard(card); } }}
        onOverlayOpen={(overlay) => { if (adminMode) { setSelectedOverlayId(overlay.id); setSelectedRegionId(null); setSelectedMarkerId(null); } else if (overlay.card_id) { const card = cards.find((item) => item.id === overlay.card_id); if (card) openCard(card); } }}
        onOpenCard={(id) => { const card = cards.find((item) => item.id === id); if (card) openCard(card); }}
        onMarkerPreview={previewMarker} onMarkerCommit={commitMarker} onOverlayPreview={previewOverlay} onOverlayCommit={commitOverlay}
        onOverlayResizePreview={previewResize} onOverlayResizeCommit={commitResize} onRegionPreview={previewRegion} onRegionCommit={commitRegionPoints}
        onMapImageUpload={uploadMapImage} onOverlayUpload={uploadOverlay} onEditMapDetails={() => void editMapDetails()}
      />}
      {view === "library" && <LibraryView cards={visibleCards} onSelect={openCard} onTag={focusTag} title={query.trim().startsWith("#") ? `Тег #${query.trim().slice(1)}` : undefined} description={query.trim().startsWith("#") ? "Все статьи, отмеченные этим тегом." : undefined} />}
      {view === "timeline" && <TimelineView events={timeline} onSelect={(id) => { const card = cards.find((item) => item.id === id); if (card) openCard(card); }} />}
    </div>

    <aside className={`article-panel ${selectedCard ? "is-open" : ""}`}>
      {selectedCard ? <>
        <div className="article-cover" style={{ background: selectedCard.cover_image_url ? `linear-gradient(180deg, rgba(16,14,20,.08), rgba(20,18,27,.95)), url("${selectedCard.cover_image_url}") center/cover` : `radial-gradient(circle at 25% 15%, rgba(255,255,255,.55), transparent 30%), linear-gradient(145deg, ${selectedCard.cover_color}, #191720 72%)` }}><span>{typeMeta[selectedCard.type].icon}</span><button className="icon-button" onClick={() => { setSelectedCardId(null); setSelectedMarkerId(null); }}>×</button></div>
        <div className="article-scroll"><div className="article-body">
          <div className="article-meta"><span>{cardKind(selectedCard)}</span><time>обновлено {formatDate(selectedCard.updated_at)}</time></div>
          <h2>{selectedCard.title}</h2><p className="lead">{selectedCard.excerpt}</p><div className="tags">{selectedCard.tags.map((tag) => <button type="button" key={tag} onClick={() => focusTag(tag)}>#{tag}</button>)}</div>
          <MarkdownView content={selectedCard.content} cards={cards} onOpenCard={openCard} onTag={focusTag} />
          {placements.length > 0 && <section className="relations map-links"><h3>На картах</h3>{placements.map((placement) => <button key={`${placement.kind}-${placement.object_id}`} onClick={() => void focusPlacement(placement)}><span className="map-link-icon">{placement.kind === "marker" ? "⌖" : placement.kind === "region" ? "⬡" : "▧"}</span><span><b>{placement.map_title}</b><small>{placement.label || (placement.kind === "marker" ? "Метка" : placement.kind === "region" ? "Регион" : "Карточка")}</small></span><i>↗</i></button>)}</section>}
          {selectedBacklinks.length > 0 && <section className="relations backlinks"><h3>Упоминается в</h3>{selectedBacklinks.map((item) => <button key={item.id} onClick={() => openCard(item)} title={item.excerpt}><span style={{ background: item.cover_color }}>{typeMeta[item.type].icon}</span><span className="relation-copy"><b>{item.title}</b><small>{cardKind(item)}</small></span><i>→</i></button>)}</section>}
          {selectedCard.relations.length > 0 && <section className="relations"><h3>Связанные записи</h3>{selectedCard.relations.map((id) => { const item = cards.find((card) => card.id === id); return item ? <button key={id} onClick={() => openCard(item)}><span style={{ background: item.cover_color }}>{typeMeta[item.type].icon}</span><span className="relation-copy"><b>{item.title}</b><small>{cardKind(item)}</small></span><i>→</i></button> : null; })}</section>}
        </div></div>
        {adminMode && <div className="article-actions"><button className="ghost-button" onClick={() => setEditingCard(selectedCard)}>Изменить статью</button>{selectedMarker && <button className="text-button danger-text" onClick={() => { if (confirm("Удалить эту метку с карты?")) void deleteSelectedMarker(); }}>Удалить метку</button>}</div>}
      </> : <div className="article-empty"><div className="compass">✦</div><h2>Выберите точку мира</h2><p>Нажмите на метку, карточку на карте, статью из библиотеки или событие таймлайна.</p></div>}
    </aside>

    {editingCard && <CardEditor key={editingCard === "new" ? "new" : editingCard.id} initial={editingCard === "new" ? null : editingCard} cards={cards} timelineItem={editingCard === "new" ? null : timeline.find((item) => item.card_id === editingCard.id) || null} onSave={saveCard} onClose={() => { setEditingCard(null); setPendingPoint(null); }} onDelete={editingCard !== "new" ? removeCard : undefined} onUpload={upload} />}
    {adminMode && markerPicker && <MarkerPicker cards={cards} onChoose={(card) => void createMarker(card)} onCreate={() => { setMarkerPicker(false); setEditingCard("new"); }} onClose={() => { setMarkerPicker(false); setPendingPoint(null); }} />}
    {adminMode && selectedRegion && <RegionEditor key={selectedRegion.id} region={selectedRegion} cards={cards} onClose={() => setSelectedRegionId(null)} onSave={saveRegion} onDelete={() => deleteRegion(selectedRegion.id)} onStartVertexEdit={() => setTool("select")} />}
    {adminMode && selectedOverlay && <OverlayEditor key={selectedOverlay.id} overlay={selectedOverlay} cards={cards} onClose={() => setSelectedOverlayId(null)} onSave={saveOverlay} onDelete={() => deleteOverlay(selectedOverlay.id)} onPreview={(value) => previewOverlayDetails(selectedOverlay.id, value)} />}
  </main>;
}
