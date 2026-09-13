"""Compose per-asset multiview evidence and source-neutral overview sheets."""

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ASSET_SHEET_SIZE = (1280, 1088)


def font(size):
    path = "/System/Library/Fonts/Supplemental/Arial.ttf"
    return ImageFont.truetype(path, size) if Path(path).is_file() else ImageFont.load_default()


def checker(size):
    image = Image.new("RGB", size, "#252b35")
    draw = ImageDraw.Draw(image)
    step = 20
    for y in range(0, size[1], step):
        for x in range(0, size[0], step):
            if (x // step + y // step) % 2 == 0:
                draw.rectangle((x, y, x + step - 1, y + step - 1), fill="#313844")
    return image


def composite_rgb(path):
    source = Image.open(path).convert("RGBA")
    background = checker(source.size).convert("RGBA")
    return Image.alpha_composite(background, source).convert("RGB")


def asset_sheet(item):
    cell = 320
    heading = 44
    views = item["views"]
    sheet = Image.new("RGB", ASSET_SHEET_SIZE, "#151922")
    draw = ImageDraw.Draw(sheet)
    draw.text((12, 9), item["sourceContentHash"], font=font(21), fill="white")
    for index, view in enumerate(views):
        x = (index % 4) * cell
        y = heading + (index // 4) * (cell + 28)
        sheet.paste(composite_rgb(view["rgbPath"]), (x, y))
        draw.text((x + 7, y + cell + 4), f"{view['azimuthDegrees']:g}° / {view['elevationDegrees']:g}°", font=font(15), fill="#e5e9ef")
    sheet.save(item["contactSheetPath"], format="PNG", optimize=True)


def reusable_asset_sheet(item):
    destination = Path(item["contactSheetPath"])
    if not destination.is_file() or destination.is_symlink():
        return False
    if destination.stat().st_mtime_ns < max(Path(view["rgbPath"]).stat().st_mtime_ns for view in item["views"]):
        return False
    try:
        with Image.open(destination) as image:
            return image.format == "PNG" and image.size == ASSET_SHEET_SIZE
    except (OSError, ValueError):
        return False


def overview_sheets(items, output):
    per_sheet, columns, cell_w, cell_h, heading = 32, 4, 320, 290, 48
    count = 0
    ordered = sorted(items, key=lambda item: item["sourceContentHash"])
    for page, start in enumerate(range(0, len(ordered), per_sheet), 1):
        chunk = ordered[start : start + per_sheet]
        sheet = Image.new("RGB", (columns * cell_w, heading + math.ceil(len(chunk) / columns) * cell_h), "#151922")
        draw = ImageDraw.Draw(sheet)
        draw.text((14, 10), f"Canonical sources · {start + 1}-{start + len(chunk)} of {len(ordered)}", font=font(22), fill="white")
        for local, item in enumerate(chunk):
            x, y = (local % columns) * cell_w, heading + (local // columns) * cell_h
            first = composite_rgb(item["views"][0]["rgbPath"])
            first.thumbnail((cell_w, cell_h - 34))
            sheet.paste(first, (x + (cell_w - first.width) // 2, y))
            draw.rectangle((x, y + cell_h - 34, x + cell_w, y + cell_h), fill="#222938")
            draw.text((x + 7, y + cell_h - 27), f"{start + local + 1:04d}  {item['sourceContentHash'][:24]}", font=font(14), fill="#f3f5f8")
        sheet.save(output / f"sources-{page:03d}.jpg", quality=90, optimize=True)
        count += 1
    return count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--output", required=True)
    values = parser.parse_args()
    with open(values.job, encoding="utf8") as handle:
        items = json.load(handle)["items"]
    output = Path(values.output)
    output.mkdir(parents=True, exist_ok=True)
    generated = 0
    for item in items:
        if reusable_asset_sheet(item):
            continue
        asset_sheet(item)
        generated += 1
    print(json.dumps({"sheets": overview_sheets(items, output), "assets": len(items), "generated": generated, "reused": len(items) - generated}))


if __name__ == "__main__":
    main()
