"""agent-health-monitor — parses Apple Health documents and generates alerts.

Runs every 6 hours (default cron: 0 */6 * * *).  Reads the last 7 days of
source-apple-health documents from the vault, extracts numeric metrics via
regex, and writes an alert document whenever a threshold is exceeded.
"""

import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from pios.sdk import AgentPlugin


# Regex patterns for the Markdown output produced by source-apple-health
_RE_STEPS       = re.compile(r'步数[：:]\s*[\*]{0,2}([\d,，]+)[\*]{0,2}\s*步')
_RE_BLOOD_OX    = re.compile(r'血氧[：:]\s*[\*]{0,2}([\d.]+)[\*]{0,2}\s*%')
_RE_HR_AVG      = re.compile(r'平均心率[：:]\s*[\*]{0,2}([\d.]+)[\*]{0,2}')
_RE_HR_REST     = re.compile(r'静息心率[：:]\s*[\*]{0,2}([\d.]+)[\*]{0,2}')
_RE_STAND_HOURS = re.compile(r'站立时间[：:]\s*[\*]{0,2}([\d.]+)[\*]{0,2}\s*小时')
_RE_EXERCISE    = re.compile(r'运动时间[：:]\s*[\*]{0,2}([\d.]+)[\*]{0,2}\s*分')


def _parse_metrics(text: str) -> Dict[str, float]:
    """Extract numeric health metrics from an Apple Health Markdown document."""
    metrics: Dict[str, float] = {}

    def _num(pattern: re.Pattern, key: str) -> None:
        m = pattern.search(text)
        if m:
            raw = m.group(1).replace(",", "").replace("，", "")
            try:
                metrics[key] = float(raw)
            except ValueError:
                pass

    _num(_RE_STEPS,       "steps")
    _num(_RE_BLOOD_OX,    "blood_oxygen")
    _num(_RE_HR_AVG,      "heart_rate_avg")
    _num(_RE_HR_REST,     "heart_rate_rest")
    _num(_RE_STAND_HOURS, "stand_hours")
    _num(_RE_EXERCISE,    "exercise_min")
    return metrics


class Plugin(AgentPlugin):
    """Health monitoring agent — detects anomalies in Apple Health data."""

    async def run(self) -> Dict[str, Any]:
        self.logger.info("agent-health-monitor: starting")

        steps_threshold  = int(self.context.get_config("alert_threshold_steps",  5000))
        bo_threshold     = float(self.context.get_config("alert_threshold_bo",   93.0))
        hr_max_threshold = float(self.context.get_config("alert_threshold_hr_max", 100.0))

        # Query last 7 days of Apple Health docs
        today = datetime.utcnow().date()
        date_from = (today - timedelta(days=7)).isoformat()
        date_to   = today.isoformat()

        health_docs: List[Dict] = []
        if self.context.database:
            health_docs = self.context.database.get_documents(
                source="source-apple-health",
                date_from=date_from,
                date_to=date_to,
                limit=7,
            )

        if not health_docs:
            self.logger.info("No Apple Health documents found in last 7 days")
            return {"status": "success", "alerts": 0, "days_analyzed": 0}

        # Load full text and parse metrics
        metrics_by_date: Dict[str, Dict[str, float]] = {}
        if self.context.document_store:
            for doc in health_docs:
                full = self.context.document_store.get(doc["id"])
                if full and full.content.get("text"):
                    parsed = _parse_metrics(full.content["text"])
                    if parsed:
                        metrics_by_date[doc.get("date", "unknown")] = parsed

        self.logger.info(f"Parsed metrics for {len(metrics_by_date)} days")

        # Build alerts
        alerts: List[Dict[str, Any]] = []
        for date_str, m in sorted(metrics_by_date.items()):
            if "steps" in m and m["steps"] < steps_threshold:
                alerts.append({
                    "type": "low_steps",
                    "date": date_str,
                    "value": int(m["steps"]),
                    "threshold": steps_threshold,
                    "message": f"步数 {int(m['steps'])} 步，未达目标（{steps_threshold} 步）",
                })
            if "blood_oxygen" in m and m["blood_oxygen"] < bo_threshold:
                alerts.append({
                    "type": "low_blood_oxygen",
                    "date": date_str,
                    "value": m["blood_oxygen"],
                    "threshold": bo_threshold,
                    "message": f"血氧 {m['blood_oxygen']}%，低于警戒线（{bo_threshold}%）",
                })
            if "heart_rate_avg" in m and m["heart_rate_avg"] > hr_max_threshold:
                alerts.append({
                    "type": "high_heart_rate",
                    "date": date_str,
                    "value": m["heart_rate_avg"],
                    "threshold": hr_max_threshold,
                    "message": f"平均心率 {m['heart_rate_avg']} bpm，超过阈值（{hr_max_threshold} bpm）",
                })

        self.logger.info(f"Generated {len(alerts)} health alerts")

        # Save analysis document (always — shows trends even without alerts)
        content = self._format_report(metrics_by_date, alerts, date_from, date_to)
        doc_id = self.save_document(
            title=f"健康分析 {date_to}",
            content=content,
            doc_type="health-analysis",
            tags=["health", "analysis"] + (["alert"] if alerts else []),
        )
        self.logger.info(f"Saved health analysis {doc_id}")

        return {
            "status": "success",
            "days_analyzed": len(metrics_by_date),
            "alerts": len(alerts),
            "alert_details": alerts,
        }

    # ------------------------------------------------------------------ helpers

    def _format_report(
        self,
        metrics_by_date: Dict[str, Dict[str, float]],
        alerts: List[Dict[str, Any]],
        date_from: str,
        date_to: str,
    ) -> str:
        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M")
        lines = [
            f"# 健康分析报告",
            f"分析区间：{date_from} ～ {date_to}　生成时间：{now}",
            "",
        ]

        if alerts:
            lines.append("## ⚠️ 异常提醒")
            for a in alerts:
                lines.append(f"- **{a['date']}** — {a['message']}")
            lines.append("")

        lines.append("## 近期趋势")
        lines.append("")
        lines.append("| 日期 | 步数 | 血氧 | 平均心率 | 静息心率 | 运动(分) |")
        lines.append("|------|------|------|----------|----------|----------|")
        for date_str, m in sorted(metrics_by_date.items()):
            steps   = f"{int(m['steps'])}" if "steps" in m else "-"
            bo      = f"{m['blood_oxygen']}%" if "blood_oxygen" in m else "-"
            hr_avg  = f"{m['heart_rate_avg']}" if "heart_rate_avg" in m else "-"
            hr_rest = f"{m['heart_rate_rest']}" if "heart_rate_rest" in m else "-"
            ex      = f"{int(m['exercise_min'])}" if "exercise_min" in m else "-"
            lines.append(f"| {date_str} | {steps} | {bo} | {hr_avg} | {hr_rest} | {ex} |")

        return "\n".join(lines)
