"""source-immich — fetches daily photos from Immich and generates a photo diary.

Ported from immich_diary.py (Mybook/MySpace/immich_diary.py).
Uses the Immich REST API (search/metadata + assets/{id}) to fetch photos
taken on a given date, then formats them into a Markdown diary.
"""

import json
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pios.sdk import SourcePlugin, SourceData

WEEKDAYS_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

TIME_PERIODS = [
    (0, 6,  "🌙 凌晨"),
    (6, 9,  "🌅 早晨"),
    (9, 12, "☀️ 上午"),
    (12, 14, "🍱 中午"),
    (14, 17, "🌤️ 下午"),
    (17, 19, "🌇 傍晚"),
    (19, 24, "🌙 晚上"),
]


def _period(hour: int) -> str:
    for start, end, label in TIME_PERIODS:
        if start <= hour < end:
            return label
    return "📷 其他"


def _api(base_url: str, api_key: str, endpoint: str,
         method: str = "GET", data: Optional[Dict] = None) -> Any:
    url = f"{base_url.rstrip('/')}/api{endpoint}"
    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    body = json.dumps(data).encode() if data else None
    req = Request(url, data=body, headers=headers, method=method)
    with urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def _get_photos_for_date(base_url: str, api_key: str, target_date: str) -> List[Dict]:
    """Fetch all photos taken on target_date (YYYY-MM-DD) with full EXIF detail."""
    next_day = (datetime.strptime(target_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    payload = {
        "takenAfter": f"{target_date}T00:00:00.000Z",
        "takenBefore": f"{next_day}T00:00:00.000Z",
        "type": "IMAGE",
        "size": 1000,
        "order": "asc",
    }
    result = _api(base_url, api_key, "/search/metadata", method="POST", data=payload)
    assets = result.get("assets", {}).get("items", [])
    if not assets:
        assets = result if isinstance(result, list) else []
    return assets


def _location_str(asset: Dict) -> Optional[str]:
    exif = asset.get("exifInfo") or {}
    parts = [p for p in [exif.get("city"), exif.get("state"), exif.get("country")] if p]
    return ", ".join(parts) if parts else None


def _camera_str(asset: Dict) -> Optional[str]:
    exif = asset.get("exifInfo") or {}
    make = exif.get("make", "")
    model = exif.get("model", "")
    camera = f"{make} {model}".strip()
    parts = [camera] if camera else []
    exposure = []
    if exif.get("fNumber"):
        exposure.append(f"f/{exif['fNumber']}")
    if exif.get("exposureTime"):
        exposure.append(f"{exif['exposureTime']}s")
    if exif.get("iso"):
        exposure.append(f"ISO {exif['iso']}")
    if exif.get("focalLength"):
        exposure.append(f"{exif['focalLength']}mm")
    if exposure:
        parts.append(" | ".join(exposure))
    return " · ".join(parts) if parts else None


def _fmt_time(iso_str: str) -> str:
    if not iso_str:
        return "未知"
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return dt.strftime("%H:%M")
    except Exception:
        return iso_str


def _build_diary(target_date: str, assets: List[Dict], base_url: str) -> str:
    dt = datetime.strptime(target_date, "%Y-%m-%d")
    weekday = WEEKDAYS_CN[dt.weekday()]

    # Collect unique locations and people
    locations = []
    seen_locs = set()
    people: List[str] = []
    for a in assets:
        loc = _location_str(a)
        if loc and loc not in seen_locs:
            seen_locs.add(loc)
            locations.append(loc)
        for p in (a.get("people") or []):
            name = p.get("name")
            if name and name not in people:
                people.append(name)

    # YAML frontmatter
    lines = [
        "---",
        f"date: {target_date}",
        "type: photo_daily",
        f"total_photos: {len(assets)}",
    ]
    if locations:
        lines.append("locations:")
        for loc in locations:
            lines.append(f"  - {loc}")
    if people:
        lines.append("people:")
        for p in people:
            lines.append(f"  - {p}")
    lines += ["---", "", f"# 📸 {target_date}{weekday}照片日记"]

    if not assets:
        lines += ["", "今日无照片。"]
        return "\n".join(lines)

    # Group by time period
    groups: Dict[str, List[Dict]] = {}
    for asset in assets:
        time_str = asset.get("localDateTime") or asset.get("fileCreatedAt", "")
        try:
            dt2 = datetime.fromisoformat(time_str.replace("Z", "+00:00"))
            period = _period(dt2.hour)
        except Exception:
            period = "📷 其他"
        groups.setdefault(period, []).append(asset)

    period_order = [label for *_, label in TIME_PERIODS] + ["📷 其他"]
    for period in period_order:
        if period not in groups:
            continue
        lines += ["", f"### {period}", ""]
        for asset in groups[period]:
            asset_id = asset.get("id", "")
            filename = asset.get("originalFileName", "photo.jpg")
            time_label = _fmt_time(asset.get("localDateTime") or asset.get("fileCreatedAt", ""))
            loc = _location_str(asset)
            cam = _camera_str(asset)
            photo_link = f"[🖼️ 查看照片]({base_url}/photos/{asset_id})"
            line = f"{photo_link}"
            meta = []
            if loc:
                meta.append(f"📍{loc}")
            if cam:
                meta.append(f"📷{cam}")
            if meta:
                line += "  " + " · ".join(meta)
            lines.append(f"- {time_label} {line}")

    # Summary sentence (used as daily summary anchor)
    loc_str = f"，地点：{', '.join(locations)}" if locations else ""
    summary = f"共 {len(assets)} 张照片{loc_str}。 ^photo-daily-summary"
    lines += ["", "### 照片日记", summary, ""]

    return "\n".join(lines)


class Plugin(SourcePlugin):
    """Immich photo diary source plugin."""

    def fetch(self) -> List[SourceData]:
        base_url = self.context.get_config("immich_url", "http://localhost:2283")
        api_key = self.context.get_config("immich_api_key", "")
        days_back = int(self.context.get_config("days_back", 1))

        if not api_key:
            self.logger.warning("immich_api_key not configured — skipping")
            return []

        results: List[SourceData] = []
        today = date.today()

        for i in range(1, days_back + 1):
            target = (today - timedelta(days=i)).isoformat()

            # Skip if already processed
            if self.context.database:
                existing = self.context.database.get_documents(
                    source="source-immich", date_from=target, date_to=target
                )
                if existing:
                    self.logger.info(f"Skipping {target} — already in vault")
                    continue

            self.logger.info(f"Fetching photos from Immich for {target}")
            try:
                assets = _get_photos_for_date(base_url, api_key, target)
                self.logger.info(f"Found {len(assets)} photos on {target}")
            except (HTTPError, URLError) as e:
                self.logger.error(f"Immich API error for {target}: {e}")
                continue

            results.append(SourceData(
                source="source-immich",
                data_type="photo-daily",
                content={"date": target, "assets": assets, "base_url": base_url},
                title=f"照片日记 — {target}",
                date=target,
                tags=["immich", "photo", "daily"],
            ))

        return results

    def normalize(self, data: SourceData) -> Dict[str, Any]:
        target_date = data.content["date"]
        assets = data.content["assets"]
        base_url = data.content.get("base_url", "http://localhost:2283")
        diary = _build_diary(target_date, assets, base_url)
        return {"text": diary}
