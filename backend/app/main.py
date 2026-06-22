from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import shutil
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

DATA_DIR = Path(os.getenv("DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
DB_PATH = Path(os.getenv("DATABASE_PATH", DATA_DIR / "atlas.db"))
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", DATA_DIR / "uploads"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "change-me")
AUTH_SECRET = os.getenv("AUTH_SECRET", "replace-this-with-a-long-random-secret")
TOKEN_TTL_SECONDS = int(os.getenv("TOKEN_TTL_SECONDS", str(60 * 60 * 24 * 7)))
CORS_ORIGINS = [item.strip() for item in os.getenv("CORS_ORIGINS", "*").split(",") if item.strip()]
ALLOWED_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

app = FastAPI(title="Timur Gandon API", version="0.6.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

CardType = Literal["location", "person", "faction", "artifact", "event"]


class CardInput(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    type: CardType
    excerpt: str = Field(default="", max_length=500)
    content: str = Field(default="")
    cover_color: str = Field(default="#A8C7FF", pattern=r"^#[0-9A-Fa-f]{6}$")
    cover_image_url: str | None = Field(default=None, max_length=1000)
    tags: list[str] = Field(default_factory=list)
    relations: list[int] = Field(default_factory=list)


class MarkerInput(BaseModel):
    card_id: int
    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)
    label: str | None = Field(default=None, max_length=100)


class MapInput(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    subtitle: str = Field(default="", max_length=280)
    image_url: str | None = Field(default=None, max_length=1000)
    image_aspect_ratio: float | None = Field(default=None, ge=0.25, le=4.0)


class Point(BaseModel):
    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)


class RegionInput(BaseModel):
    label: str = Field(min_length=2, max_length=100)
    points: list[Point] = Field(min_length=3, max_length=100)
    color: str = Field(default="#C7F36C", pattern=r"^#[0-9A-Fa-f]{6}$")
    card_id: int | None = None


class OverlayInput(BaseModel):
    image_url: str = Field(min_length=1, max_length=1000)
    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)
    width: float = Field(default=16, ge=3, le=80)
    aspect_ratio: float = Field(default=1.5, ge=0.3, le=3.5)
    label: str | None = Field(default=None, max_length=100)
    card_id: int | None = None
    display_type: Literal["illustration", "card"] = "illustration"


class TimelineInput(BaseModel):
    card_id: int
    sort_year: int = Field(ge=-100000, le=100000)
    date_label: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)


class LoginInput(BaseModel):
    password: str = Field(min_length=1, max_length=500)


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def row_to_card(row: sqlite3.Row) -> dict:
    card = dict(row)
    card["tags"] = json.loads(card.pop("tags_json") or "[]")
    card["relations"] = json.loads(card.pop("relations_json") or "[]")
    return card


def signed_token() -> tuple[str, int]:
    expires_at = int(time.time()) + TOKEN_TTL_SECONDS
    payload = json.dumps({"role": "admin", "exp": expires_at}, separators=(",", ":")).encode()
    encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    signature = hmac.new(AUTH_SECRET.encode(), encoded.encode(), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}", expires_at


def parse_token(token: str) -> dict:
    try:
        encoded, signature = token.split(".", 1)
        expected = hmac.new(AUTH_SECRET.encode(), encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("bad signature")
        padded = encoded + "=" * (-len(encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        if payload.get("role") != "admin" or int(payload.get("exp", 0)) < int(time.time()):
            raise ValueError("expired")
        return payload
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Требуется доступ хранителя") from exc


def require_admin(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Требуется доступ хранителя")
    return parse_token(authorization.split(" ", 1)[1])


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS cards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                type TEXT NOT NULL,
                excerpt TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '',
                cover_color TEXT NOT NULL DEFAULT '#A8C7FF',
                cover_image_url TEXT,
                tags_json TEXT NOT NULL DEFAULT '[]',
                relations_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS maps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                subtitle TEXT NOT NULL DEFAULT '',
                image_url TEXT,
                image_aspect_ratio REAL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS markers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                map_id INTEGER NOT NULL,
                card_id INTEGER NOT NULL,
                x REAL NOT NULL,
                y REAL NOT NULL,
                label TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(map_id) REFERENCES maps(id),
                FOREIGN KEY(card_id) REFERENCES cards(id)
            );
            CREATE TABLE IF NOT EXISTS regions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                map_id INTEGER NOT NULL,
                card_id INTEGER,
                label TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#C7F36C',
                points_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(map_id) REFERENCES maps(id),
                FOREIGN KEY(card_id) REFERENCES cards(id)
            );
            CREATE TABLE IF NOT EXISTS map_overlays (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                map_id INTEGER NOT NULL,
                image_url TEXT NOT NULL,
                x REAL NOT NULL,
                y REAL NOT NULL,
                width REAL NOT NULL DEFAULT 16,
                aspect_ratio REAL NOT NULL DEFAULT 1.5,
                label TEXT,
                card_id INTEGER,
                display_type TEXT NOT NULL DEFAULT 'illustration',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(map_id) REFERENCES maps(id),
                FOREIGN KEY(card_id) REFERENCES cards(id)
            );
            CREATE TABLE IF NOT EXISTS timeline_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id INTEGER NOT NULL UNIQUE,
                sort_year INTEGER NOT NULL,
                date_label TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(card_id) REFERENCES cards(id)
            );
            """
        )
        ensure_column(conn, "cards", "cover_image_url", "TEXT")
        ensure_column(conn, "maps", "image_aspect_ratio", "REAL")
        ensure_column(conn, "map_overlays", "card_id", "INTEGER")
        ensure_column(conn, "map_overlays", "display_type", "TEXT NOT NULL DEFAULT 'illustration'")
        ensure_column(conn, "map_overlays", "aspect_ratio", "REAL NOT NULL DEFAULT 1.5")
        existing = conn.execute("SELECT COUNT(*) AS count FROM cards").fetchone()["count"]
        if existing == 0:
            seed_cards = [
                ("Астэрская обсерватория", "location", "Старая башня на краю Солёного моря. Ночью её линзы ловят свет исчезнувших звёзд.", "## История\nОбсерватория была построена до Раскола, когда моря ещё не существовало.\n\n## Сегодня\nВнутри живут хранители карт и наблюдатели приливов. Никто не знает, почему маяк продолжает работать.", "#9FB9FF", ["Север", "Башня", "Тайна"], [2, 3]),
                ("Мира Вальд", "person", "Картограф, которая вернулась из Пепельных земель с картой, которой не должно существовать.", "## Портрет\nМира собирает маршруты исчезнувших экспедиций. Она уверена, что каждая карта — это договор с местом.\n\n## Связи\nПоследний раз её видели у Обсерватории вместе с представителем Конклава.", "#F6C178", ["Картограф", "Исследователь"], [1, 3]),
                ("Конклав тумана", "faction", "Закрытый союз дипломатов и архивистов, охраняющий запретные маршруты между островами.", "## Цель\nКонклав контролирует доступ к старым путям и стирает сведения о тех, кто нарушает договоры.\n\n## Символ\nТри кольца, пересечённые тонкой линией горизонта.", "#C69CFF", ["Фракция", "Архив", "Политика"], [1, 2]),
                ("Сердце прилива", "artifact", "Кристалл, который меняет направление воды в радиусе одного дня пути.", "## Свойства\nАртефакт реагирует на клятвы, произнесённые над водой. Его нельзя взять силой: он становится тяжёлым, как якорь.\n\n## Последнее известное место\nРуины на южном берегу Солёного моря.", "#72D8C5", ["Артефакт", "Море"], [1, 3]),
                ("Ночь без прилива", "event", "Однажды море остановилось на девять часов, открыв древние улицы под водой.", "## Событие\nЖители прибрежных городов спустились к старым воротам, но вернулись не все. С тех пор Ночь без прилива отмечают молчанием.", "#F58BB2", ["История", "Катастрофа"], [1, 4]),
            ]
            for card in seed_cards:
                conn.execute(
                    """INSERT INTO cards(title,type,excerpt,content,cover_color,tags_json,relations_json,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?)""",
                    (*card[:5], json.dumps(card[5], ensure_ascii=False), json.dumps(card[6]), now(), now()),
                )
        if conn.execute("SELECT COUNT(*) AS count FROM maps").fetchone()["count"] == 0:
            conn.execute("INSERT INTO maps(title,subtitle,image_url,created_at,updated_at) VALUES(?,?,?,?,?)", ("Пределы Эйры", "Карты западного побережья и внутренних земель", None, now(), now()))
        if conn.execute("SELECT COUNT(*) AS count FROM markers").fetchone()["count"] == 0:
            # Do not assume card ids start at 1: an existing SQLite file can keep
            # AUTOINCREMENT counters after all demo cards were deleted.
            map_row = conn.execute("SELECT id FROM maps ORDER BY id LIMIT 1").fetchone()
            card_rows = conn.execute("SELECT id FROM cards ORDER BY id LIMIT 5").fetchall()
            marker_positions = [(57, 32, "Обсерватория"), (34, 46, "Мира"), (47, 58, "Конклав"), (71, 66, "Сердце прилива"), (21, 67, "Ночь без прилива")]
            if map_row and len(card_rows) == len(marker_positions):
                for card_row, (x, y, label) in zip(card_rows, marker_positions):
                    conn.execute("INSERT INTO markers(map_id,card_id,x,y,label,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (map_row["id"], card_row["id"], x, y, label, now(), now()))
        if conn.execute("SELECT COUNT(*) AS count FROM timeline_events").fetchone()["count"] == 0:
            event_id = conn.execute("SELECT id FROM cards WHERE type = 'event' ORDER BY id LIMIT 1").fetchone()
            if event_id:
                conn.execute("INSERT INTO timeline_events(card_id,sort_year,date_label,description,created_at,updated_at) VALUES(?,?,?,?,?,?)", (event_id["id"], -132, "132 года до Раскола", "Море остановилось на девять часов, открыв древние улицы под водой.", now(), now()))


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/health")
def health():
    return {"ok": True, "service": "atlas-forge-api", "version": "0.6.0"}


@app.post("/api/auth/login")
def login(payload: LoginInput):
    if not hmac.compare_digest(payload.password.encode(), ADMIN_PASSWORD.encode()):
        raise HTTPException(status_code=401, detail="Неверный пароль хранителя")
    token, expires_at = signed_token()
    return {"access_token": token, "token_type": "bearer", "role": "admin", "expires_at": expires_at}


@app.get("/api/auth/me")
def auth_me(_: dict = Depends(require_admin)):
    return {"role": "admin"}


@app.get("/api/cards")
def list_cards(q: str | None = None, type: CardType | None = None):
    query = "SELECT * FROM cards"
    clauses: list[str] = []
    values: list[str] = []
    if q:
        clauses.append("(title LIKE ? OR excerpt LIKE ? OR tags_json LIKE ?)")
        search = f"%{q}%"
        values.extend([search, search, search])
    if type:
        clauses.append("type = ?")
        values.append(type)
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY updated_at DESC"
    with db() as conn:
        rows = conn.execute(query, values).fetchall()
    return [row_to_card(row) for row in rows]


@app.get("/api/cards/{card_id}")
def get_card(card_id: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Карточка не найдена")
    return row_to_card(row)


@app.get("/api/cards/{card_id}/placements")
def list_card_placements(card_id: int):
    """Return every visual reference to an article across all maps."""
    with db() as conn:
        if not conn.execute("SELECT id FROM cards WHERE id = ?", (card_id,)).fetchone():
            raise HTTPException(404, "Карточка не найдена")
        rows = conn.execute(
            """
            SELECT maps.id AS map_id, maps.title AS map_title, 'marker' AS kind,
                   markers.id AS object_id, COALESCE(markers.label, maps.title) AS label
            FROM markers JOIN maps ON maps.id = markers.map_id
            WHERE markers.card_id = ?
            UNION ALL
            SELECT maps.id AS map_id, maps.title AS map_title, 'region' AS kind,
                   regions.id AS object_id, regions.label AS label
            FROM regions JOIN maps ON maps.id = regions.map_id
            WHERE regions.card_id = ?
            UNION ALL
            SELECT maps.id AS map_id, maps.title AS map_title, 'overlay' AS kind,
                   map_overlays.id AS object_id,
                   COALESCE(map_overlays.label, maps.title) AS label
            FROM map_overlays JOIN maps ON maps.id = map_overlays.map_id
            WHERE map_overlays.card_id = ?
            ORDER BY map_title, kind, object_id
            """,
            (card_id, card_id, card_id),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/cards", status_code=201)
def create_card(payload: CardInput, _: dict = Depends(require_admin)):
    stamp = now()
    with db() as conn:
        cursor = conn.execute(
            """INSERT INTO cards(title,type,excerpt,content,cover_color,cover_image_url,tags_json,relations_json,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (payload.title, payload.type, payload.excerpt, payload.content, payload.cover_color, payload.cover_image_url, json.dumps(payload.tags, ensure_ascii=False), json.dumps(payload.relations), stamp, stamp),
        )
        row = conn.execute("SELECT * FROM cards WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return row_to_card(row)


@app.patch("/api/cards/{card_id}")
def update_card(card_id: int, payload: CardInput, _: dict = Depends(require_admin)):
    with db() as conn:
        if not conn.execute("SELECT id FROM cards WHERE id = ?", (card_id,)).fetchone():
            raise HTTPException(404, "Карточка не найдена")
        conn.execute(
            """UPDATE cards SET title=?, type=?, excerpt=?, content=?, cover_color=?, cover_image_url=?, tags_json=?, relations_json=?, updated_at=? WHERE id=?""",
            (payload.title, payload.type, payload.excerpt, payload.content, payload.cover_color, payload.cover_image_url, json.dumps(payload.tags, ensure_ascii=False), json.dumps(payload.relations), now(), card_id),
        )
        row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    return row_to_card(row)


@app.delete("/api/cards/{card_id}", status_code=204)
def delete_card(card_id: int, _: dict = Depends(require_admin)):
    with db() as conn:
        if not conn.execute("SELECT id FROM cards WHERE id = ?", (card_id,)).fetchone():
            raise HTTPException(404, "Карточка не найдена")
        conn.execute("DELETE FROM markers WHERE card_id = ?", (card_id,))
        conn.execute("DELETE FROM timeline_events WHERE card_id = ?", (card_id,))
        conn.execute("UPDATE regions SET card_id = NULL WHERE card_id = ?", (card_id,))
        conn.execute("UPDATE map_overlays SET card_id = NULL WHERE card_id = ?", (card_id,))
        conn.execute("DELETE FROM cards WHERE id = ?", (card_id,))


@app.get("/api/maps")
def list_maps():
    with db() as conn:
        rows = conn.execute(
            """
            SELECT maps.*,
                (SELECT COUNT(*) FROM markers WHERE markers.map_id = maps.id) AS marker_count,
                (SELECT COUNT(*) FROM regions WHERE regions.map_id = maps.id) AS region_count,
                (SELECT COUNT(*) FROM map_overlays WHERE map_overlays.map_id = maps.id) AS overlay_count
            FROM maps
            ORDER BY maps.updated_at DESC, maps.id DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/maps", status_code=201)
def create_map(payload: MapInput, _: dict = Depends(require_admin)):
    stamp = now()
    with db() as conn:
        cursor = conn.execute(
            "INSERT INTO maps(title,subtitle,image_url,image_aspect_ratio,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            (payload.title, payload.subtitle, payload.image_url, payload.image_aspect_ratio, stamp, stamp),
        )
        row = conn.execute("SELECT * FROM maps WHERE id = ?", (cursor.lastrowid,)).fetchone()
    result = dict(row)
    result.update({"markers": [], "regions": [], "overlays": []})
    return result


@app.get("/api/maps/{map_id}")
def get_map(map_id: int):
    with db() as conn:
        map_row = conn.execute("SELECT * FROM maps WHERE id = ?", (map_id,)).fetchone()
        if not map_row:
            raise HTTPException(404, "Карта не найдена")
        marker_rows = conn.execute(
            """SELECT markers.*, cards.title AS card_title, cards.type AS card_type, cards.cover_color AS card_color
            FROM markers JOIN cards ON cards.id = markers.card_id WHERE markers.map_id = ? ORDER BY markers.id""",
            (map_id,),
        ).fetchall()
        region_rows = conn.execute(
            """SELECT regions.*, cards.title AS card_title FROM regions
            LEFT JOIN cards ON cards.id = regions.card_id WHERE regions.map_id = ? ORDER BY regions.id""",
            (map_id,),
        ).fetchall()
        overlay_rows = conn.execute(
            """SELECT map_overlays.*, cards.title AS card_title, cards.type AS card_type,
            cards.cover_color AS card_color FROM map_overlays
            LEFT JOIN cards ON cards.id = map_overlays.card_id
            WHERE map_overlays.map_id = ? ORDER BY map_overlays.id""",
            (map_id,),
        ).fetchall()
    result = dict(map_row)
    result["markers"] = [dict(row) for row in marker_rows]
    result["regions"] = [{**dict(row), "points": json.loads(row["points_json"])} for row in region_rows]
    result["overlays"] = [dict(row) for row in overlay_rows]
    return result


@app.patch("/api/maps/{map_id}")
def update_map(map_id: int, payload: MapInput, _: dict = Depends(require_admin)):
    with db() as conn:
        if not conn.execute("SELECT id FROM maps WHERE id = ?", (map_id,)).fetchone():
            raise HTTPException(404, "Карта не найдена")
        conn.execute(
            "UPDATE maps SET title=?, subtitle=?, image_url=?, image_aspect_ratio=?, updated_at=? WHERE id=?",
            (payload.title, payload.subtitle, payload.image_url, payload.image_aspect_ratio, now(), map_id),
        )
        row = conn.execute("SELECT * FROM maps WHERE id = ?", (map_id,)).fetchone()
    return dict(row)


@app.delete("/api/maps/{map_id}", status_code=204)
def delete_map(map_id: int, _: dict = Depends(require_admin)):
    with db() as conn:
        exists = conn.execute("SELECT id FROM maps WHERE id = ?", (map_id,)).fetchone()
        if not exists:
            raise HTTPException(404, "Карта не найдена")
        map_count = conn.execute("SELECT COUNT(*) AS count FROM maps").fetchone()["count"]
        if map_count <= 1:
            raise HTTPException(400, "Нельзя удалить последнюю карту мира")
        # Articles are global. Delete only map-local objects.
        conn.execute("DELETE FROM markers WHERE map_id = ?", (map_id,))
        conn.execute("DELETE FROM regions WHERE map_id = ?", (map_id,))
        conn.execute("DELETE FROM map_overlays WHERE map_id = ?", (map_id,))
        conn.execute("DELETE FROM maps WHERE id = ?", (map_id,))


@app.post("/api/maps/{map_id}/markers", status_code=201)
def create_marker(map_id: int, payload: MarkerInput, _: dict = Depends(require_admin)):
    stamp = now()
    with db() as conn:
        if not conn.execute("SELECT id FROM maps WHERE id = ?", (map_id,)).fetchone():
            raise HTTPException(404, "Карта не найдена")
        if not conn.execute("SELECT id FROM cards WHERE id = ?", (payload.card_id,)).fetchone():
            raise HTTPException(404, "Карточка не найдена")
        cursor = conn.execute("INSERT INTO markers(map_id,card_id,x,y,label,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (map_id, payload.card_id, payload.x, payload.y, payload.label, stamp, stamp))
        row = conn.execute("""SELECT markers.*, cards.title AS card_title, cards.type AS card_type, cards.cover_color AS card_color FROM markers JOIN cards ON cards.id = markers.card_id WHERE markers.id = ?""", (cursor.lastrowid,)).fetchone()
    return dict(row)


@app.patch("/api/maps/{map_id}/markers/{marker_id}")
def update_marker(map_id: int, marker_id: int, payload: MarkerInput, _: dict = Depends(require_admin)):
    with db() as conn:
        if not conn.execute("SELECT id FROM markers WHERE id = ? AND map_id = ?", (marker_id, map_id)).fetchone():
            raise HTTPException(404, "Метка не найдена")
        conn.execute("UPDATE markers SET card_id=?, x=?, y=?, label=?, updated_at=? WHERE id=?", (payload.card_id, payload.x, payload.y, payload.label, now(), marker_id))
        row = conn.execute("""SELECT markers.*, cards.title AS card_title, cards.type AS card_type, cards.cover_color AS card_color FROM markers JOIN cards ON cards.id = markers.card_id WHERE markers.id = ?""", (marker_id,)).fetchone()
    return dict(row)


@app.delete("/api/maps/{map_id}/markers/{marker_id}", status_code=204)
def delete_marker(map_id: int, marker_id: int, _: dict = Depends(require_admin)):
    with db() as conn:
        deleted = conn.execute("DELETE FROM markers WHERE id = ? AND map_id = ?", (marker_id, map_id)).rowcount
        if not deleted:
            raise HTTPException(404, "Метка не найдена")


@app.post("/api/maps/{map_id}/regions", status_code=201)
def create_region(map_id: int, payload: RegionInput, _: dict = Depends(require_admin)):
    stamp = now()
    with db() as conn:
        if not conn.execute("SELECT id FROM maps WHERE id = ?", (map_id,)).fetchone():
            raise HTTPException(404, "Карта не найдена")
        cursor = conn.execute("""INSERT INTO regions(map_id,card_id,label,color,points_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)""", (map_id, payload.card_id, payload.label, payload.color, json.dumps([point.model_dump() for point in payload.points]), stamp, stamp))
        row = conn.execute("SELECT * FROM regions WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return {**dict(row), "points": json.loads(row["points_json"])}


@app.patch("/api/maps/{map_id}/regions/{region_id}")
def update_region(map_id: int, region_id: int, payload: RegionInput, _: dict = Depends(require_admin)):
    with db() as conn:
        if not conn.execute("SELECT id FROM regions WHERE id = ? AND map_id = ?", (region_id, map_id)).fetchone():
            raise HTTPException(404, "Регион не найден")
        conn.execute("UPDATE regions SET card_id=?, label=?, color=?, points_json=?, updated_at=? WHERE id=?", (payload.card_id, payload.label, payload.color, json.dumps([point.model_dump() for point in payload.points]), now(), region_id))
        row = conn.execute("SELECT * FROM regions WHERE id = ?", (region_id,)).fetchone()
    return {**dict(row), "points": json.loads(row["points_json"])}


@app.delete("/api/maps/{map_id}/regions/{region_id}", status_code=204)
def delete_region(map_id: int, region_id: int, _: dict = Depends(require_admin)):
    with db() as conn:
        deleted = conn.execute("DELETE FROM regions WHERE id = ? AND map_id = ?", (region_id, map_id)).rowcount
        if not deleted:
            raise HTTPException(404, "Регион не найден")


@app.post("/api/maps/{map_id}/overlays", status_code=201)
def create_overlay(map_id: int, payload: OverlayInput, _: dict = Depends(require_admin)):
    stamp = now()
    with db() as conn:
        if not conn.execute("SELECT id FROM maps WHERE id = ?", (map_id,)).fetchone():
            raise HTTPException(404, "Карта не найдена")
        if payload.card_id is not None and not conn.execute("SELECT id FROM cards WHERE id = ?", (payload.card_id,)).fetchone():
            raise HTTPException(404, "Карточка не найдена")
        cursor = conn.execute(
            """INSERT INTO map_overlays(map_id,image_url,x,y,width,aspect_ratio,label,card_id,display_type,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (map_id, payload.image_url, payload.x, payload.y, payload.width, payload.aspect_ratio, payload.label, payload.card_id, payload.display_type, stamp, stamp),
        )
        row = conn.execute(
            """SELECT map_overlays.*, cards.title AS card_title, cards.type AS card_type,
            cards.cover_color AS card_color FROM map_overlays
            LEFT JOIN cards ON cards.id = map_overlays.card_id WHERE map_overlays.id = ?""",
            (cursor.lastrowid,),
        ).fetchone()
    return dict(row)


@app.patch("/api/maps/{map_id}/overlays/{overlay_id}")
def update_overlay(map_id: int, overlay_id: int, payload: OverlayInput, _: dict = Depends(require_admin)):
    with db() as conn:
        if not conn.execute("SELECT id FROM map_overlays WHERE id = ? AND map_id = ?", (overlay_id, map_id)).fetchone():
            raise HTTPException(404, "Иллюстрация не найдена")
        if payload.card_id is not None and not conn.execute("SELECT id FROM cards WHERE id = ?", (payload.card_id,)).fetchone():
            raise HTTPException(404, "Карточка не найдена")
        conn.execute(
            """UPDATE map_overlays SET image_url=?, x=?, y=?, width=?, aspect_ratio=?, label=?, card_id=?, display_type=?, updated_at=? WHERE id=?""",
            (payload.image_url, payload.x, payload.y, payload.width, payload.aspect_ratio, payload.label, payload.card_id, payload.display_type, now(), overlay_id),
        )
        row = conn.execute(
            """SELECT map_overlays.*, cards.title AS card_title, cards.type AS card_type,
            cards.cover_color AS card_color FROM map_overlays
            LEFT JOIN cards ON cards.id = map_overlays.card_id WHERE map_overlays.id = ?""",
            (overlay_id,),
        ).fetchone()
    return dict(row)


@app.delete("/api/maps/{map_id}/overlays/{overlay_id}", status_code=204)
def delete_overlay(map_id: int, overlay_id: int, _: dict = Depends(require_admin)):
    with db() as conn:
        deleted = conn.execute("DELETE FROM map_overlays WHERE id = ? AND map_id = ?", (overlay_id, map_id)).rowcount
        if not deleted:
            raise HTTPException(404, "Иллюстрация не найдена")


@app.get("/api/timeline")
def get_timeline():
    with db() as conn:
        rows = conn.execute(
            """SELECT timeline_events.*, cards.title AS card_title, cards.type AS card_type,
            cards.cover_color AS card_color, cards.cover_image_url AS card_image_url
            FROM timeline_events JOIN cards ON cards.id = timeline_events.card_id
            ORDER BY sort_year, timeline_events.id"""
        ).fetchall()
    return [dict(row) for row in rows]


@app.put("/api/timeline/{card_id}")
def upsert_timeline(card_id: int, payload: TimelineInput, _: dict = Depends(require_admin)):
    if card_id != payload.card_id:
        raise HTTPException(400, "Идентификатор карточки не совпадает")
    stamp = now()
    with db() as conn:
        if not conn.execute("SELECT id FROM cards WHERE id = ?", (card_id,)).fetchone():
            raise HTTPException(404, "Карточка не найдена")
        conn.execute(
            """INSERT INTO timeline_events(card_id,sort_year,date_label,description,created_at,updated_at)
            VALUES(?,?,?,?,?,?)
            ON CONFLICT(card_id) DO UPDATE SET sort_year=excluded.sort_year, date_label=excluded.date_label,
            description=excluded.description, updated_at=excluded.updated_at""",
            (card_id, payload.sort_year, payload.date_label, payload.description, stamp, stamp),
        )
        row = conn.execute("SELECT * FROM timeline_events WHERE card_id = ?", (card_id,)).fetchone()
    return dict(row)


@app.delete("/api/timeline/{card_id}", status_code=204)
def delete_timeline(card_id: int, _: dict = Depends(require_admin)):
    with db() as conn:
        conn.execute("DELETE FROM timeline_events WHERE card_id = ?", (card_id,))


@app.post("/api/uploads", status_code=201)
async def upload_image(request: Request, file: UploadFile = File(...), _: dict = Depends(require_admin)):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(400, "Поддерживаются PNG, JPG, WEBP и GIF")
    filename = f"{uuid.uuid4().hex}{suffix}"
    destination = UPLOAD_DIR / filename
    with destination.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    base = str(request.base_url).rstrip("/")
    return {"url": f"{base}/uploads/{filename}", "filename": filename}
