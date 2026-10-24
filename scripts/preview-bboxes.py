# 目检 bbox：把 scripts/last-run.json 里 l0 regions / plan annotations 画到原图上
# 用法：python scripts/preview-bboxes.py
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
IMG_DIR = ROOT / "doc" / "猫角落改造助手 · 项目思路与执行纲领" / "图片和附件"
FILES = {
    "img1": IMG_DIR / "img1_scene.jpg",
    "img2": IMG_DIR / "img2_annotate.jpg",
    "img3": IMG_DIR / "img3_measure.jpg",
}
REGION_COLORS = {
    "ok": (34, 197, 94),
    "conditional": (245, 158, 11),
    "blocked": (239, 68, 68),
    "unknown": (148, 163, 184),
}


def load_font(size: int):
    for name in ("arial.ttf", "segoeui.ttf", "msyh.ttc"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_box(draw, bbox, color, width, label, font):
    w, h = draw._image.size
    x, y, bw, bh = bbox
    x1, y1, x2, y2 = int(x * w), int(y * h), int((x + bw) * w), int((y + bh) * h)
    draw.rectangle([x1, y1, x2, y2], outline=color, width=width)
    tx, ty = x1 + 4, max(2, y1 - 22)
    label = str(label)
    try:
        tb = draw.textbbox((tx, ty), label, font=font)
        draw.rectangle([tb[0] - 3, tb[1] - 2, tb[2] + 3, tb[3] + 2], fill=(0, 0, 0))
    except Exception:
        pass
    draw.text((tx, ty), label, fill=color, font=font)


def main() -> int:
    run_file = ROOT / "scripts" / "last-run.json"
    if not run_file.exists():
        print("缺少 scripts/last-run.json，先跑 node scripts/test-ai.mjs")
        return 1
    data = json.loads(run_file.read_text(encoding="utf-8"))
    payloads = data.get("payloads", [])
    by_key: dict[str, dict[str, dict]] = {}
    for p in payloads:
        by_key.setdefault(p["image"], {})[p["stage"]] = p["applied"]

    for key, path in FILES.items():
        if key not in by_key or not path.exists():
            continue
        stages = by_key[key]
        img = Image.open(path).convert("RGB")
        scale = 1600 / img.width
        img = img.resize((1600, int(img.height * scale)), Image.LANCZOS)
        draw = ImageDraw.Draw(img)
        font = load_font(26)
        small = load_font(20)

        l0 = stages.get("l0") or {}
        for region in l0.get("regions", []):
            bbox = region.get("bbox")
            if not bbox or len(bbox) != 4:
                continue
            color = REGION_COLORS.get(region.get("verdict"), (148, 163, 184))
            draw_box(draw, bbox, color, 4, f"{region.get('id')} {region.get('verdict')}", small)

        plan = stages.get("plan") or {}
        for ann in plan.get("annotations", []):
            bbox = ann.get("bbox")
            if not bbox or len(bbox) != 4:
                continue
            draw_box(draw, bbox, (34, 211, 238), 7, f"#{ann.get('id')} {ann.get('label')}", font)

        out = ROOT / "scripts" / f"bbox-{key}.jpg"
        img.save(out, quality=88)
        print(f"{key}: {out}  regions={len(l0.get('regions', []))} annotations={len(plan.get('annotations', []))}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
