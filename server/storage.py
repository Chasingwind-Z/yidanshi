"""存储层：文件模式（现状，默认）与数据库模式（云托管）双实现，公开函数签名不变。

- 文件模式（未设 YIDANSHI_DB_URL / MYSQL_ADDRESS）：菜谱 = data/recipes/*.md
  （frontmatter + 分节正文），吃饭记录 = data/meals.json，杂项文档 = data/*.json。
  所有数据都是 AI 助手 / 人可直接编辑的纯文本，改文件即改数据——行为与历史版本逐字节一致。
- 数据库模式（设了 YIDANSHI_DB_URL，或云托管 MySQL 插件注入 MYSQL_ADDRESS 等）：
  SQLAlchemy Core 三张表 recipes/meals/kvdocs；sqlalchemy 懒加载，文件模式绝不 import。
  落库前经 _dump_md→_parse_md 规范化一轮，保证与文件模式读写口径完全一致。

杂项文档统一走 read_doc(name)/write_doc(name, obj)：
name ∈ orders/shopping/pantry/config/ingredients/<食材名>，文件模式下路径与缩进
和历史版本完全相同（orders.json 等 indent=1、config.json indent=2）。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import threading
import unicodedata
from datetime import date, datetime
from pathlib import Path
from urllib.parse import quote_plus

import yaml

try:  # 中文名转拼音 slug（可读、稳定）；没装也能跑，退确定性短哈希
    from pypinyin import lazy_pinyin
except ImportError:  # pragma: no cover
    lazy_pinyin = None

ROOT = Path(__file__).resolve().parent.parent
# YIDANSHI_DATA_DIR：测试/容器可重定向数据目录；未设时与历史版本完全一致
DATA = Path(os.environ.get("YIDANSHI_DATA_DIR", "").strip() or (ROOT / "data"))
RECIPES_DIR = DATA / "recipes"
MEALS_FILE = DATA / "meals.json"
PHOTOS = DATA / "photos"
ING_ICON_DIR = PHOTOS / "illust" / "ingredients"  # 食材图标全局共享库（按食材名，全食单复用）

DEFAULT_CATEGORIES = ["饭粥", "面点", "羹汤", "小炒", "甜点"]  # 随园食单章法，支持自定义追加

_lock = threading.Lock()

# 合法菜谱 id/文件名：**只允许小写**字母数字下划线连字符。
# 允许大写会在 macOS/APFS（大小写不敏感）上开一个静默劫持口子：PUT /api/recipes/R38402
# 命中的是 r38402.md，文件名不变但 frontmatter id 被改成大写，菜谱↔食历的关联随之断开，
# 「做过几次/评分」悄悄归零；DELETE 同理能删掉真实菜谱（第3轮 agent 实测）。
# slugify 产出本就是小写，历史 id 也都是小写，收紧无兼容代价。
_ID_RE = re.compile(r"[a-z0-9_-]+")


def valid_id(rid: str) -> bool:
    return bool(rid) and bool(_ID_RE.fullmatch(str(rid)))


MAX_GRAMS = 100_000  # 100kg，家常菜克重上界；再大的一律当填错


def coerce_grams(v) -> int | None:
    """克重规范化：数字或数字字符串都收（"50"/"55g" → 50/55），非法一律 None。

    要挡住的坑（第3轮 agent 实测）：bool 被当数字（True→1）、NaN/Inf 让响应序列化崩 500、
    "1_0" 被 Python 读成 10、1e308 落库一个 309 位整数、"55g" 带单位被静默丢弃。
    """
    if isinstance(v, bool):  # bool 是 int 的子类，必须先挡
        return None
    if isinstance(v, str):
        s = v.strip().rstrip("gG克 ").strip()  # 容忍用户带单位写「55g」
        if "_" in s:  # Python 会把 "1_0" 读成 10，用户绝无此意
            return None
        v = s
    try:
        g = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(g) or g <= 0 or g > MAX_GRAMS:
        return None
    return round(g)


def _atomic_write(path: Path, text: str) -> None:
    """先写同目录临时文件再 os.replace 原子替换：write_text 是先截断后写，
    中途崩溃/断电会把整份数据留成半截（食历尤其致命，几个月记录一次归零）。"""
    tmp = path.with_name(f".{path.name}.tmp{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


# ---------- 菜谱 md 编解码（两个实现共用同一套口径） ----------

_SECTION_RE = re.compile(r"^##\s*(食材|步骤|贴士)\s*$", re.M)


def _parse_md(text: str) -> dict:
    """frontmatter + ## 食材 / ## 步骤 / ## 贴士 三节。"""
    meta: dict = {}
    body = text
    if text.startswith("---"):
        _, fm, body = text.split("---", 2)
        meta = yaml.safe_load(fm) or {}

    sections: dict[str, str] = {}
    parts = _SECTION_RE.split(body)
    for i in range(1, len(parts) - 1, 2):
        sections[parts[i]] = parts[i + 1].strip()

    ingredients = []
    for line in sections.get("食材", "").splitlines():
        line = line.strip().lstrip("-").strip()
        if not line:
            continue
        parts = [s.strip() for s in line.split("|")]
        grams = None
        if len(parts) >= 3:  # 第三段为克重：如 "55g"
            m = re.match(r"^([\d.]+)\s*[g克]?$", parts[2])
            if m:
                grams = round(float(m.group(1)))
        ingredients.append({"name": parts[0], "amount": parts[1] if len(parts) > 1 else "", "grams": grams})

    steps = []
    for line in sections.get("步骤", "").splitlines():
        line = line.strip()
        m = re.match(r"^\d+[.、]\s*(.+)$", line)
        if m:
            steps.append(m.group(1).strip())
        elif line and steps:  # 多行步骤续行
            steps[-1] += line

    tips = [ln.strip().lstrip("-").strip() for ln in sections.get("贴士", "").splitlines() if ln.strip()]

    kcal, servings, minutes = meta.get("kcal"), meta.get("servings"), meta.get("minutes")
    return {
        "id": meta.get("id", ""),
        "name": meta.get("name", ""),
        "category": meta.get("category", DEFAULT_CATEGORIES[0]),
        "cover": meta.get("cover") or "",
        "source": meta.get("source") or "",
        "created": str(meta.get("created") or ""),
        "kcal": int(kcal) if isinstance(kcal, (int, float)) else None,
        "minutes": int(minutes) if isinstance(minutes, (int, float)) else None,
        "difficulty": meta.get("difficulty") if meta.get("difficulty") in ("简单", "中等", "硬菜") else None,
        "servings": int(servings) if isinstance(servings, (int, float)) and servings >= 1 else 1,
        "ingredients": ingredients,
        "steps": steps,
        "tips": tips,
    }


def _dump_md(r: dict) -> str:
    meta = {k: r[k] for k in ("id", "name", "category") if r.get(k) is not None}
    for k in ("cover", "source", "created", "kcal", "minutes", "difficulty"):
        if r.get(k):
            meta[k] = r[k]
    if r.get("servings") and int(r["servings"]) > 1:
        meta["servings"] = int(r["servings"])
    fm = yaml.safe_dump(meta, allow_unicode=True, sort_keys=False).strip()
    lines = [f"---\n{fm}\n---", "", "## 食材", ""]
    for i in r.get("ingredients", []):
        g = coerce_grams(i.get("grams"))  # 数字/数字字符串收，负/零/非法克重不落库
        line = f"- {i['name']}"
        if i.get("amount") or g:
            line += f" | {i.get('amount', '')}"
        if g:
            line += f" | {g}g"
        lines.append(line)
    lines += ["", "## 步骤", ""]
    lines += [f"{n}. {s}" for n, s in enumerate(r.get("steps", []), 1)]
    if r.get("tips"):
        lines += ["", "## 贴士", ""] + [f"- {t}" for t in r["tips"]]
    return "\n".join(lines) + "\n"


def _cos_base() -> str | None:
    """COS 四要素齐→ https://bucket.cos.region.myqcloud.com，否则 None。
    直接读环境变量、不 import photostore（那会循环 import）。"""
    b, rg = os.environ.get("COS_BUCKET", "").strip(), os.environ.get("COS_REGION", "").strip()
    if b and rg and os.environ.get("COS_SECRET_ID", "").strip() and os.environ.get("COS_SECRET_KEY", "").strip():
        return f"https://{b}.cos.{rg}.myqcloud.com"
    return None


def _attach_illust(r: dict, rid: str) -> dict:
    """插画目录约定：食材图标在全局共享库 illust/ingredients/<食材名>.png（旧的按菜谱
    ing-<n>.png 兼容），步骤图按菜谱 illust/<rid>/step-<n>.png。
    - 本地：按文件探测（现状不变），没有的返回空串、前端自然不显示。
    - 云端（配了 COS）：无法廉价探测对象存在性，一律构造 COS URL，交给前端对 404 的插画
      做 onError 回退（食材回退 emoji、步骤图隐藏）。共享食材图标因此能跨菜谱复用。"""
    cos = _cos_base()
    if cos:
        r["illust"] = {
            "ingredients": [f"{cos}/photos/illust/ingredients/{i['name']}.png" for i in r["ingredients"]],
            "steps": [f"{cos}/photos/illust/{rid}/step-{n}.png"
                      for n in range(1, len(r["steps"]) + 1)],
        }
        return r

    illust = PHOTOS / "illust" / rid

    def ing_url(n: int) -> str:
        shared = ING_ICON_DIR / f"{r['ingredients'][n - 1]['name']}.png"
        if shared.exists():
            return f"/photos/illust/ingredients/{shared.name}"
        legacy = illust / f"ing-{n}.png"
        return f"/photos/illust/{rid}/{legacy.name}" if legacy.exists() else ""

    r["illust"] = {
        "ingredients": [ing_url(n) for n in range(1, len(r["ingredients"]) + 1)],
        "steps": [f"/photos/illust/{rid}/{f.name}" if (f := illust / f"step-{n}.png").exists() else ""
                  for n in range(1, len(r["steps"]) + 1)],
    }
    return r


def slugify(name: str) -> str:
    """菜名 → 稳定可读 slug：中文优先转拼音，非中文原样保留；重名加序号。

    旧实现直接 encode("ascii","ignore") 会把汉字整段丢掉，全中文名一律落到
    hash 兜底（且内置 hash() 跨进程不稳定），导致大量菜名 slug 撞车。
    """
    name = (name or "").strip()
    # lazy_pinyin 逐字转拼音、非中文段原样保留；没装库则用原名（英文/数字名照常可用）
    src = " ".join(lazy_pinyin(name)) if (lazy_pinyin and name) else name
    slug = re.sub(r"[^a-z0-9]+", "-",
                  unicodedata.normalize("NFKD", src).encode("ascii", "ignore").decode().lower()).strip("-")
    slug = slug[:60].strip("-")  # 控制文件名长度
    if not slug:  # 纯符号/emoji 等无可转写字符：确定性短哈希（不用内置 hash，跨进程不稳）
        slug = "r" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    base, n = slug, 2
    while _store.recipe_exists(slug):
        slug, n = f"{base}-{n}", n + 1
    return slug


# ---------- 杂项文档（read_doc / write_doc）----------

_DOC_FILES = {  # name → (文件名, json indent)；缩进与历史直写代码逐字节一致
    "orders": ("orders.json", 1),
    "shopping": ("shopping.json", 1),
    "pantry": ("pantry.json", 1),
    "config": ("config.json", 2),
}


def _doc_file(name: str) -> tuple[Path, int]:
    if name in _DOC_FILES:
        fn, indent = _DOC_FILES[name]
        return DATA / fn, indent
    if name.startswith("ingredients/"):
        n = name.split("/", 1)[1]
        if not n or "/" in n or n.startswith("."):
            raise ValueError(f"非法食材文档名：{name}")
        return DATA / "ingredients" / f"{n}.json", 1
    raise ValueError(f"未知文档名：{name}")


# ---------- 文件实现（现状代码原样搬入） ----------

class _FileStore:
    def init_dirs(self) -> None:
        for p in (RECIPES_DIR, PHOTOS / "raw", PHOTOS / "cut", PHOTOS / "cards", PHOTOS / "illust"):
            p.mkdir(parents=True, exist_ok=True)
        if not MEALS_FILE.exists():
            MEALS_FILE.write_text("[]\n", encoding="utf-8")

    # ----- 菜谱 -----

    def recipe_exists(self, rid: str) -> bool:
        return (RECIPES_DIR / f"{rid}.md").exists()

    def list_recipes(self) -> list[dict]:
        out = []
        for p in sorted(RECIPES_DIR.glob("*.md")):
            r = _parse_md(p.read_text(encoding="utf-8"))
            r["id"] = r["id"] or p.stem
            out.append(r)
        return out

    def get_recipe(self, rid: str) -> dict | None:
        if not valid_id(rid):  # 挡住大小写变体/畸形 id（见 _ID_RE 注释）
            return None
        p = RECIPES_DIR / f"{rid}.md"
        if not p.exists():
            return None
        r = _parse_md(p.read_text(encoding="utf-8"))
        r["id"] = rid
        return _attach_illust(r, rid)

    def save_recipe(self, r: dict) -> dict:
        with _lock:
            if not r.get("id"):
                r["id"] = slugify(r["name"])
            elif not valid_id(r["id"]):
                # 显式 id 只能是合法小写 slug；含 / .. . 或大写一律拒
                raise ValueError(f"非法菜谱 id：{r['id']}")
            if not r.get("created"):
                r["created"] = date.today().isoformat()
            _atomic_write(RECIPES_DIR / f"{r['id']}.md", _dump_md(r))
        return r

    def delete_recipe(self, rid: str) -> bool:
        if not valid_id(rid):  # 大小写变体不得删掉真实菜谱
            return False
        p = RECIPES_DIR / f"{rid}.md"
        if not p.exists():
            return False
        p.unlink()
        return True

    def seed_recipe(self, src: Path) -> bool:
        """示例菜谱入库（幂等）：文件模式=原样拷贝文件（字节不动）。"""
        dst = RECIPES_DIR / src.name
        if dst.exists():
            return False
        dst.write_bytes(src.read_bytes())
        return True

    # ----- 吃饭记录 -----

    def list_meals(self) -> list[dict]:
        return json.loads(MEALS_FILE.read_text(encoding="utf-8"))

    def _write_meals(self, meals: list[dict]) -> None:
        _atomic_write(MEALS_FILE, json.dumps(meals, ensure_ascii=False, indent=1) + "\n")

    def add_meal(self, meal: dict) -> dict:
        with _lock:
            meals = self.list_meals()
            # 唯一 id：秒级时间戳 + 短随机后缀，杜绝同秒双击/重试碰撞（碰撞会导致删除连坐）
            used = {m.get("id") for m in meals}
            base = f"m{datetime.now().strftime('%Y%m%d%H%M%S')}"
            mid = base
            while mid in used:
                mid = f"{base}-{secrets.token_hex(2)}"
            meal["id"] = mid
            # 快照菜名：菜谱日后被删/改名，食历记录依然可读
            r = self.get_recipe(meal.get("recipe_id", ""))
            if r is not None:
                meal.setdefault("recipe_name", r["name"])
            meals.append(meal)
            self._write_meals(meals)
        return meal

    def update_meal(self, mid: str, patch: dict) -> dict | None:
        with _lock:
            meals = self.list_meals()
            for m in meals:
                if m["id"] == mid:
                    m.update({k: patch[k] for k in ("date", "rating", "note") if k in patch})
                    self._write_meals(meals)
                    return m
        return None

    def delete_meal(self, mid: str) -> bool:
        with _lock:
            meals = self.list_meals()
            # 只删第一条匹配：历史数据可能存在同 id（老版本秒级 id 碰撞），避免一次连坐删多条
            for i, m in enumerate(meals):
                if m["id"] == mid:
                    del meals[i]
                    self._write_meals(meals)
                    return True
        return False

    # ----- 杂项文档 -----

    def read_doc(self, name: str):
        p, _ = _doc_file(name)
        if not p.exists():
            return None
        return json.loads(p.read_text(encoding="utf-8"))

    def write_doc(self, name: str, obj) -> None:
        p, indent = _doc_file(name)
        p.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(p, json.dumps(obj, ensure_ascii=False, indent=indent) + "\n")

    def list_doc_names(self, prefix: str) -> list[str]:
        if prefix == "ingredients/":
            d = DATA / "ingredients"
            return sorted(p.stem for p in d.glob("*.json")) if d.exists() else []
        return sorted(n for n in _DOC_FILES if (DATA / _DOC_FILES[n][0]).exists())


# ---------- 数据库实现（SQLAlchemy Core，懒加载） ----------

class _DbStore:
    """三张表：recipes（结构化列 + ingredients/steps/tips JSON 文本）、meals、
    kvdocs(name PK, body JSON 文本)。落库前过一轮 _dump_md→_parse_md 规范化，
    保证 grams/difficulty/servings 等口径与文件模式逐项一致。"""

    def __init__(self, url: str):
        self.url = url
        self._engine = None
        self._init_lock = threading.Lock()

    # ----- 引擎与建表 -----

    def _ensure(self):
        if self._engine is not None:
            return
        with self._init_lock:
            if self._engine is not None:
                return
            import sqlalchemy as sa
            self.sa = sa
            if self.url.startswith("mysql"):
                self._ensure_mysql_database(sa)
            engine = sa.create_engine(self.url, pool_pre_ping=True, future=True)
            md = sa.MetaData()
            body_t = sa.Text()
            if self.url.startswith("mysql"):
                from sqlalchemy.dialects.mysql import LONGTEXT
                body_t = sa.Text().with_variant(LONGTEXT(), "mysql")
            self.t_recipes = sa.Table(
                "recipes", md,
                sa.Column("id", sa.String(120), primary_key=True),
                sa.Column("name", sa.Text()),
                sa.Column("category", sa.String(50)),
                sa.Column("cover", sa.Text()),
                sa.Column("source", sa.Text()),
                sa.Column("created", sa.String(10)),
                sa.Column("kcal", sa.Integer()),
                sa.Column("minutes", sa.Integer()),
                sa.Column("difficulty", sa.String(10)),
                sa.Column("servings", sa.Integer()),
                sa.Column("ingredients", sa.Text()),
                sa.Column("steps", sa.Text()),
                sa.Column("tips", sa.Text()),
            )
            self.t_meals = sa.Table(
                "meals", md,
                sa.Column("id", sa.String(40), primary_key=True),
                sa.Column("recipe_id", sa.String(120)),
                sa.Column("date", sa.String(10)),
                sa.Column("rating", sa.Integer()),
                sa.Column("note", sa.Text()),
                sa.Column("photo_card", sa.Text()),
                sa.Column("kcal", sa.Integer()),
                sa.Column("recipe_name", sa.Text()),
                # seq：插入顺序（文件模式的数组 append 顺序）；同秒多条按 id 排会乱序
                sa.Column("seq", sa.Integer(), index=True),
            )
            self.t_kvdocs = sa.Table(
                "kvdocs", md,
                sa.Column("name", sa.String(191), primary_key=True),  # utf8mb4 索引长度上限内
                sa.Column("body", body_t),
            )
            md.create_all(engine)
            self._engine = engine

    def _ensure_mysql_database(self, sa) -> None:
        """MySQL：库不存在先建（云托管 MySQL 插件只给实例不建库）。无建库权限但库已在时静默跳过。"""
        try:
            u = sa.engine.make_url(self.url)
            dbname = u.database or "yidanshi"
            server = sa.create_engine(u.set(database=""))
            with server.connect() as c:
                c.execute(sa.text(
                    f"CREATE DATABASE IF NOT EXISTS `{dbname}` "
                    "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"))
                c.commit()
            server.dispose()
        except Exception:  # 库已存在但无 CREATE 权限等：交给正式连接去报真实错误
            pass

    def init_dirs(self) -> None:
        # 照片本地兜底路径与静态挂载仍需要目录存在（COS 未配时云上也写本地）
        for p in (PHOTOS / "raw", PHOTOS / "cut", PHOTOS / "cards", PHOTOS / "illust"):
            p.mkdir(parents=True, exist_ok=True)

    # ----- 行↔字典 -----

    @staticmethod
    def _row_to_recipe(row) -> dict:
        return {
            "id": row.id,
            "name": row.name or "",
            "category": row.category or DEFAULT_CATEGORIES[0],
            "cover": row.cover or "",
            "source": row.source or "",
            "created": row.created or "",
            "kcal": row.kcal,
            "minutes": row.minutes,
            "difficulty": row.difficulty if row.difficulty in ("简单", "中等", "硬菜") else None,
            "servings": row.servings if isinstance(row.servings, int) and row.servings >= 1 else 1,
            "ingredients": json.loads(row.ingredients or "[]"),
            "steps": json.loads(row.steps or "[]"),
            "tips": json.loads(row.tips or "[]"),
        }

    @staticmethod
    def _row_to_meal(row) -> dict:
        d = {"recipe_id": row.recipe_id, "date": row.date, "rating": row.rating,
             "note": row.note, "photo_card": row.photo_card, "kcal": row.kcal, "id": row.id}
        if row.recipe_name is not None:
            d["recipe_name"] = row.recipe_name
        return d

    # ----- 菜谱 -----

    def recipe_exists(self, rid: str) -> bool:
        self._ensure()
        sa = self.sa
        with self._engine.connect() as c:
            return c.execute(sa.select(self.t_recipes.c.id)
                             .where(self.t_recipes.c.id == rid)).first() is not None

    def list_recipes(self) -> list[dict]:
        self._ensure()
        sa = self.sa
        with self._engine.connect() as c:
            rows = c.execute(sa.select(self.t_recipes)).all()
        # 与文件模式同序：文件模式按文件名 "<id>.md" 排（.md 参与比较，"-" < "."），
        # 在 Python 里排避免各数据库 collation 差异
        return [self._row_to_recipe(r) for r in sorted(rows, key=lambda r: f"{r.id}.md")]

    def get_recipe(self, rid: str) -> dict | None:
        if not valid_id(rid):
            return None
        self._ensure()
        sa = self.sa
        with self._engine.connect() as c:
            row = c.execute(sa.select(self.t_recipes).where(self.t_recipes.c.id == rid)).first()
        if row is None:
            return None
        return _attach_illust(self._row_to_recipe(row), rid)

    def save_recipe(self, r: dict) -> dict:
        with _lock:
            if not r.get("id"):
                r["id"] = slugify(r["name"])
            elif not valid_id(r["id"]):
                raise ValueError(f"非法菜谱 id：{r['id']}")
            if not r.get("created"):
                r["created"] = date.today().isoformat()
            # 与文件模式同口径：dump→parse 走一遍规范化（grams 收敛、difficulty 白名单等）
            canon = _parse_md(_dump_md(r))
            canon["id"] = r["id"]
            self._upsert_recipe(canon)
        return r

    def _upsert_recipe(self, canon: dict) -> None:
        self._ensure()
        sa = self.sa
        vals = {
            "name": canon["name"], "category": canon["category"], "cover": canon["cover"],
            "source": canon["source"], "created": canon["created"], "kcal": canon["kcal"],
            "minutes": canon["minutes"], "difficulty": canon["difficulty"],
            "servings": canon["servings"],
            "ingredients": json.dumps(canon["ingredients"], ensure_ascii=False),
            "steps": json.dumps(canon["steps"], ensure_ascii=False),
            "tips": json.dumps(canon["tips"], ensure_ascii=False),
        }
        with self._engine.begin() as c:
            n = c.execute(sa.update(self.t_recipes)
                          .where(self.t_recipes.c.id == canon["id"]).values(**vals)).rowcount
            if not n:
                c.execute(sa.insert(self.t_recipes).values(id=canon["id"], **vals))

    def delete_recipe(self, rid: str) -> bool:
        if not valid_id(rid):
            return False
        self._ensure()
        sa = self.sa
        with self._engine.begin() as c:
            n = c.execute(sa.delete(self.t_recipes).where(self.t_recipes.c.id == rid)).rowcount
        return bool(n)

    def seed_recipe(self, src: Path) -> bool:
        """示例菜谱入库（幂等）：DB 模式=解析 md 后插入（已存在则跳过）。"""
        canon = _parse_md(src.read_text(encoding="utf-8"))
        canon["id"] = canon["id"] or src.stem
        if not valid_id(canon["id"]) or self.recipe_exists(canon["id"]):
            return False
        self._upsert_recipe(canon)
        return True

    # ----- 吃饭记录 -----

    def list_meals(self) -> list[dict]:
        self._ensure()
        sa = self.sa
        with self._engine.connect() as c:
            rows = c.execute(sa.select(self.t_meals).order_by(self.t_meals.c.seq)).all()
        return [self._row_to_meal(r) for r in rows]

    def add_meal(self, meal: dict) -> dict:
        self._ensure()
        sa = self.sa
        with _lock:
            with self._engine.begin() as c:
                used = {row.id for row in c.execute(sa.select(self.t_meals.c.id)).all()}
                base = f"m{datetime.now().strftime('%Y%m%d%H%M%S')}"
                mid = base
                while mid in used:
                    mid = f"{base}-{secrets.token_hex(2)}"
                meal["id"] = mid
                seq = c.execute(sa.select(sa.func.max(self.t_meals.c.seq))).scalar() or 0
                r = self.get_recipe(meal.get("recipe_id", ""))
                if r is not None:
                    meal.setdefault("recipe_name", r["name"])
                c.execute(sa.insert(self.t_meals).values(
                    id=mid, recipe_id=meal.get("recipe_id"), date=meal.get("date"),
                    rating=meal.get("rating"), note=meal.get("note"),
                    photo_card=meal.get("photo_card"), kcal=meal.get("kcal"),
                    recipe_name=meal.get("recipe_name"), seq=seq + 1))
        return meal

    def update_meal(self, mid: str, patch: dict) -> dict | None:
        self._ensure()
        sa = self.sa
        vals = {k: patch[k] for k in ("date", "rating", "note") if k in patch}
        with _lock:
            with self._engine.begin() as c:
                row = c.execute(sa.select(self.t_meals).where(self.t_meals.c.id == mid)).first()
                if row is None:
                    return None
                if vals:
                    c.execute(sa.update(self.t_meals).where(self.t_meals.c.id == mid).values(**vals))
                    row = c.execute(sa.select(self.t_meals).where(self.t_meals.c.id == mid)).first()
        return self._row_to_meal(row)

    def delete_meal(self, mid: str) -> bool:
        self._ensure()
        sa = self.sa
        with _lock:
            with self._engine.begin() as c:
                n = c.execute(sa.delete(self.t_meals).where(self.t_meals.c.id == mid)).rowcount
        return bool(n)

    # ----- 杂项文档 -----

    def read_doc(self, name: str):
        _doc_file(name)  # 校验文档名合法（与文件模式同一套白名单）
        self._ensure()
        sa = self.sa
        with self._engine.connect() as c:
            row = c.execute(sa.select(self.t_kvdocs.c.body)
                            .where(self.t_kvdocs.c.name == name)).first()
        return json.loads(row.body) if row is not None else None

    def write_doc(self, name: str, obj) -> None:
        _doc_file(name)
        self._ensure()
        sa = self.sa
        body = json.dumps(obj, ensure_ascii=False)
        with self._engine.begin() as c:
            n = c.execute(sa.update(self.t_kvdocs)
                          .where(self.t_kvdocs.c.name == name).values(body=body)).rowcount
            if not n:
                c.execute(sa.insert(self.t_kvdocs).values(name=name, body=body))

    def list_doc_names(self, prefix: str) -> list[str]:
        self._ensure()
        sa = self.sa
        with self._engine.connect() as c:
            rows = c.execute(sa.select(self.t_kvdocs.c.name)
                             .where(self.t_kvdocs.c.name.like(prefix.replace("%", r"\%") + "%"))).all()
        return sorted(r.name[len(prefix):] for r in rows)


# ---------- 实现选择（模块加载时按环境变量定一次） ----------

def _db_url() -> str:
    url = os.environ.get("YIDANSHI_DB_URL", "").strip()
    if url:
        return url
    addr = os.environ.get("MYSQL_ADDRESS", "").strip()  # 云托管 MySQL 插件注入的标准变量
    if addr:
        user = quote_plus(os.environ.get("MYSQL_USERNAME", "root"))
        pw = quote_plus(os.environ.get("MYSQL_PASSWORD", ""))
        return f"mysql+pymysql://{user}:{pw}@{addr}/yidanshi?charset=utf8mb4"
    return ""


_store = _DbStore(_db_url()) if _db_url() else _FileStore()


# ---------- 公开接口（签名与历史版本一致） ----------

def init_dirs() -> None:
    _store.init_dirs()


def list_recipes() -> list[dict]:
    return _store.list_recipes()


def get_recipe(rid: str) -> dict | None:
    return _store.get_recipe(rid)


def save_recipe(r: dict) -> dict:
    return _store.save_recipe(r)


def delete_recipe(rid: str) -> bool:
    return _store.delete_recipe(rid)


def seed_recipe(src: Path) -> bool:
    return _store.seed_recipe(src)


def set_cover(rid: str, cover: str) -> None:
    r = get_recipe(rid)
    if r is not None:
        r["cover"] = cover
        save_recipe(r)


def list_meals() -> list[dict]:
    return _store.list_meals()


def add_meal(meal: dict) -> dict:
    return _store.add_meal(meal)


def update_meal(mid: str, patch: dict) -> dict | None:
    return _store.update_meal(mid, patch)


def delete_meal(mid: str) -> bool:
    return _store.delete_meal(mid)


def read_doc(name: str):
    """读杂项文档（orders/shopping/pantry/config/ingredients/<名>）；不存在返回 None。
    文件模式 = 原来的 data/*.json（路径与格式不变），DB 模式 = kvdocs 表。"""
    return _store.read_doc(name)


def write_doc(name: str, obj) -> None:
    _store.write_doc(name, obj)


def list_doc_names(prefix: str) -> list[str]:
    return _store.list_doc_names(prefix)


def recipe_stats() -> dict[str, dict]:
    """recipe_id → {times, rating}"""
    stats: dict[str, dict] = {}
    for m in list_meals():
        s = stats.setdefault(m.get("recipe_id", ""), {"times": 0, "ratings": []})
        s["times"] += 1
        # 只收 1-5 整数：脏数据里的字符串评分会让下面求和抛 TypeError，连累整个菜谱列表 500
        if isinstance(m.get("rating"), int) and not isinstance(m["rating"], bool) and 1 <= m["rating"] <= 5:
            s["ratings"].append(m["rating"])
    return {
        rid: {"times": s["times"],
              "rating": round(sum(s["ratings"]) / len(s["ratings"]), 1) if s["ratings"] else None}
        for rid, s in stats.items()
    }
