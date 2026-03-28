"""source-apple-health — reads Health Auto Export CSV and produces daily digest.

Migrated from the Claude Desktop daily-health-digest scheduled task.

Data source: Health Auto Export app (iPhone) → iCloud/Downloads CSV.
CSV has one row per day with Chinese column headers.
"""

import csv
import glob
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Any

from pios.sdk import SourcePlugin, SourceData

WEEKDAYS_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# Mapping from CSV column header to short key
COL_MAP = {
    "步数 (步)": "steps",
    "步行 + 跑步距离 (km)": "distance_km",
    "活动能量 (kJ)": "active_energy_kj",
    "Apple锻炼时间 (分钟)": "exercise_min",
    "Apple 站立小时 (小时)": "stand_hours",
    "心率 [平均值] (bpm)": "hr_avg",
    "心率 [最小值] (bpm)": "hr_min",
    "心率 [最大] (bpm)": "hr_max",
    "静息心率 (bpm)": "resting_hr",
    "心率变异性 (ms)": "hrv",
    "步行心率均值 (bpm)": "walking_hr",
    "血氧饱和度 (%)": "blood_oxygen",
    "步行速度 (公里/小时)": "walking_speed",
    "步幅长度 (cm)": "stride_cm",
    "步行双支撑百分比 (%)": "double_support_pct",
    "日照时长 (分钟)": "sun_min",
    "环境音频暴露 (dBASPL)": "ambient_db",
    "耳机音频暴露 (dBASPL)": "headphone_db",
    "睡眠分析 [睡眠时长] (小时)": "sleep_hours",
    "睡眠分析 [深度] (小时)": "sleep_deep_h",
    "睡眠分析 [快速动眼期] (小时)": "sleep_rem_h",
    "睡眠分析 [核心] (小时)": "sleep_core_h",
}


def _f(val: Any, decimals: int = 1) -> Optional[float]:
    """Parse a float from a CSV cell, return None if empty."""
    if val is None or str(val).strip() == "":
        return None
    try:
        return round(float(str(val).strip()), decimals)
    except ValueError:
        return None


def _kcal(kj: Optional[float]) -> Optional[float]:
    """Convert kJ to kcal."""
    return round(kj / 4.184, 0) if kj else None


def _load_csv(export_dir: str) -> Dict[str, Dict[str, Any]]:
    """Load all HealthAutoExport CSV files in export_dir, return {date_str: metrics}."""
    export_dir = str(Path(export_dir).expanduser())
    pattern = os.path.join(export_dir, "**", "HealthAutoExport-*.csv")
    files = glob.glob(pattern, recursive=True)
    # Also check directly without glob recursion
    if not files:
        files = glob.glob(os.path.join(export_dir, "HealthAutoExport*.csv"))
    if not files:
        # Walk through subdirectories that match the export zip pattern
        for item in Path(export_dir).iterdir():
            if item.is_dir() and "HealthAutoExport" in item.name:
                for f in item.glob("HealthAutoExport*.csv"):
                    files.append(str(f))

    rows: Dict[str, Dict[str, Any]] = {}
    for fpath in files:
        try:
            with open(fpath, "r", encoding="utf-8-sig") as fh:
                reader = csv.DictReader(fh)
                for row in reader:
                    dt_str = row.get("日期/时间", "").strip()
                    if not dt_str:
                        continue
                    try:
                        day = dt_str[:10]  # YYYY-MM-DD
                        metrics = {}
                        for col_header, key in COL_MAP.items():
                            metrics[key] = _f(row.get(col_header))
                        rows[day] = metrics
                    except Exception:
                        continue
        except Exception as e:
            pass  # Skip unreadable files
    return rows


def _anomalies(m: Dict, steps_min: int, bo_min: float, hr_max: int) -> List[str]:
    alerts = []
    steps = m.get("steps")
    if steps is not None and steps < steps_min:
        alerts.append(f"步数过低（{int(steps):,} 步）")
    exercise = m.get("exercise_min")
    if exercise is None or exercise == 0:
        alerts.append("无锻炼时间记录")
    bo = m.get("blood_oxygen")
    if bo is not None and bo < bo_min:
        alerts.append(f"血氧偏低（{bo}%）")
    rhr = m.get("resting_hr")
    if rhr is not None and rhr > hr_max:
        alerts.append(f"静息心率偏高（{int(rhr)} bpm）")
    sun = m.get("sun_min")
    if sun is None or sun == 0:
        alerts.append("无日光时间数据")
    return alerts


def _pct_change(new: Optional[float], old: Optional[float]) -> Optional[str]:
    if new is None or old is None or old == 0:
        return None
    change = (new - old) / abs(old) * 100
    direction = "增加" if change > 0 else "减少"
    return f"{direction} {abs(change):.0f}%"


def _build_digest(day: str, m: Dict, prev: Optional[Dict], my_name: str,
                  steps_min: int, bo_min: float, hr_max: int) -> str:
    dt = datetime.strptime(day, "%Y-%m-%d")
    weekday = WEEKDAYS_CN[dt.weekday()]

    kcal = _kcal(m.get("active_energy_kj"))
    steps = m.get("steps")
    dist = m.get("distance_km")
    rhr = m.get("resting_hr")
    hr_avg = m.get("hr_avg")
    hr_min = m.get("hr_min")
    hr_max_val = m.get("hr_max")
    hrv = m.get("hrv")
    bo = m.get("blood_oxygen")
    stand = m.get("stand_hours")
    exercise = m.get("exercise_min")
    speed = m.get("walking_speed")
    stride = m.get("stride_cm")
    dsup = m.get("double_support_pct")
    sun = m.get("sun_min")
    amb_db = m.get("ambient_db")
    phone_db = m.get("headphone_db")
    sleep_h = m.get("sleep_hours")

    def fmt(v, unit="", decimals=1):
        if v is None:
            return "无数据"
        return f"{round(v, decimals)}{unit}" if decimals else f"{int(v)}{unit}"

    # One-line summary
    step_str = f"{int(steps):,} 步" if steps else "无步数数据"
    rhr_str = f"静息心率 {int(rhr)} bpm" if rhr else ""
    bo_str = f"血氧 {bo}%" if bo else ""
    summary_parts = [p for p in [step_str, rhr_str, bo_str] if p]
    summary = "，".join(summary_parts)
    if steps and steps < steps_min:
        summary += "。需增加运动量。"

    lines = [
        f"📊 {my_name} 的健康日报 — {day}（{weekday}）",
        "",
        "### 健康一句话总结",
        f"{summary} ^health-daily-summary",
        "",
        "### 心血管状况",
    ]

    cv_parts = []
    if rhr:
        cv_parts.append(f"静息心率 {int(rhr)} bpm")
    if hr_avg:
        hr_detail = f"平均心率 {int(hr_avg)} bpm"
        if hr_min or hr_max_val:
            hr_detail += f"（最低 {int(hr_min or 0)} / 最高 {int(hr_max_val or 0)}）"
        cv_parts.append(hr_detail)
    if hrv:
        cv_parts.append(f"HRV {int(hrv)} ms")
    if bo:
        cv_parts.append(f"血氧 {bo}%")
    lines.append(" | ".join(cv_parts) if cv_parts else "无数据")
    lines.append("")

    lines.append("### 运动量")
    activity = []
    if steps:
        activity.append(f"步数 {int(steps):,} 步")
    if dist:
        activity.append(f"距离 {dist} km")
    if kcal:
        activity.append(f"活动能量 {int(kcal)} kcal")
    lines.append(" | ".join(activity) if activity else "无数据")
    ex_str = fmt(exercise, " 分钟", 0) if exercise else "无数据"
    stand_str = fmt(stand, " 小时", 0) if stand else "无数据"
    lines.append(f"锻炼 {ex_str} | 站立 {stand_str}")
    lines.append("")

    lines.append("### 步态")
    gait = []
    if speed:
        gait.append(f"步速 {speed} km/h")
    if stride:
        gait.append(f"步长 {int(stride)} cm")
    if dsup:
        gait.append(f"双脚支撑 {dsup}%")
    lines.append(" | ".join(gait) if gait else "无数据")
    lines.append("")

    lines.append("### 环境")
    env = []
    env.append(f"日光 {fmt(sun, ' 分钟', 0)}" if sun else "日光 无数据")
    env.append(f"环境音量 {fmt(amb_db, ' dB')}" if amb_db else "环境音量 无数据")
    env.append(f"耳机音量 {fmt(phone_db, ' dB')}" if phone_db else "耳机音量 无数据")
    lines.append(" | ".join(env))
    lines.append("")

    if sleep_h:
        lines.append("### 睡眠")
        lines.append(f"总睡眠 {sleep_h} 小时")
        lines.append("")

    alerts = _anomalies(m, steps_min, bo_min, hr_max)
    if alerts:
        lines.append("### ⚠️ 异常提醒")
        for a in alerts:
            lines.append(f"- {a}")
        lines.append("")

    if prev:
        comparisons = []
        if steps is not None and prev.get("steps") is not None:
            ch = _pct_change(steps, prev["steps"])
            if ch:
                comparisons.append(f"步数{ch}（{int(prev['steps']):,} → {int(steps):,}）")
        if rhr is not None and prev.get("resting_hr") is not None:
            ch = _pct_change(rhr, prev["resting_hr"])
            if ch:
                comparisons.append(f"静息心率{ch}（{int(prev['resting_hr'])} → {int(rhr)} bpm）")
        if kcal is not None and prev.get("active_energy_kj") is not None:
            prev_kcal = _kcal(prev["active_energy_kj"])
            ch = _pct_change(kcal, prev_kcal)
            if ch:
                comparisons.append(f"活动能量{ch}（{int(prev_kcal)} → {int(kcal)} kcal）")
        if stand is not None and prev.get("stand_hours") is not None:
            diff = int(stand) - int(prev["stand_hours"])
            if diff:
                direction = "增加" if diff > 0 else "减少"
                comparisons.append(f"站立时间{direction} {abs(diff)} 小时（{int(prev['stand_hours'])} → {int(stand)}）")
        if comparisons:
            lines.append("### 与前日对比")
            for c in comparisons:
                lines.append(f"- {c}")
            lines.append("")

    return "\n".join(lines)


class Plugin(SourcePlugin):
    """Apple Health source plugin — reads CSV from Health Auto Export app."""

    def fetch(self) -> List[SourceData]:
        export_dir = self.context.get_config("export_dir", "~/Downloads")
        days_back = int(self.context.get_config("days_back", 1))
        my_name = self.context.get_config("my_name", "Abe")

        self.logger.info(f"Loading Health Auto Export CSV from {export_dir}")
        all_rows = _load_csv(export_dir)

        if not all_rows:
            self.logger.warning(f"No HealthAutoExport CSV found in {export_dir}")
            return []

        self.logger.info(f"Found data for {len(all_rows)} days")

        results: List[SourceData] = []
        today = date.today()

        for i in range(1, days_back + 1):
            target = (today - timedelta(days=i)).isoformat()
            if target not in all_rows:
                self.logger.debug(f"No data for {target}")
                continue

            # Check if already processed
            if self.context.document_store:
                existing = self.context.database.get_documents(
                    source="source-apple-health", date_from=target, date_to=target
                )
                if existing:
                    self.logger.info(f"Skipping {target} — already in vault")
                    continue

            prev_date = (datetime.strptime(target, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
            results.append(SourceData(
                source="source-apple-health",
                data_type="health-daily",
                content={
                    "date": target,
                    "metrics": all_rows[target],
                    "prev_metrics": all_rows.get(prev_date),
                    "my_name": my_name,
                },
                title=f"{my_name} 的健康日报 — {target}",
                date=target,
                tags=["health", "daily"],
            ))

        self.logger.info(f"Fetched {len(results)} health records to process")
        return results

    def normalize(self, data: SourceData) -> Dict[str, Any]:
        m = data.content["metrics"]
        prev = data.content.get("prev_metrics")
        day = data.content["date"]
        my_name = data.content.get("my_name", "Abe")

        steps_min = int(self.context.get_config("anomaly_steps_min", 3000))
        bo_min = float(self.context.get_config("anomaly_blood_oxygen_min", 93.0))
        hr_max = int(self.context.get_config("anomaly_resting_hr_max", 100))

        digest = _build_digest(day, m, prev, my_name, steps_min, bo_min, hr_max)
        return {"text": digest}
