"""Prepare desktop icons from the supplied bitmap without modifying its design.

The source was flattened onto a nearly black background. Recover its existing
antialiased outline and remove that matte before resizing. Generated previews
and the reproducibility report use one fixed workspace slot, never system TEMP.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SIZES = (16, 24, 32, 48, 64, 128, 256)


def remove_black_matte(image):
    source = image.convert("RGB")
    red, green, blue = source.split()
    maximum = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    silhouette = maximum.point(lambda value: 255 if value > 32 else 0)
    bounds = silhouette.getbbox()
    if not bounds:
        raise ValueError("源图没有可识别的彩色图标")

    # Full opacity inside the artwork prevents gradient texture from acquiring
    # holes. Only the narrow original outline is reconstructed from its matte.
    inner = silhouette.filter(ImageFilter.MinFilter(5))
    outer = silhouette.filter(ImageFilter.MaxFilter(5))
    nearby = maximum.filter(ImageFilter.MaxFilter(9))
    source_bytes = source.tobytes()
    output = bytearray(source.width * source.height * 4)
    for index, (value, local, inside, around) in enumerate(zip(
            maximum.tobytes(), nearby.tobytes(), inner.tobytes(), outer.tobytes())):
        alpha = 255 if inside else round(value * 255 / local) if around and value > 4 and local else 0
        if not alpha:
            continue
        rgb = source_bytes[index * 3:index * 3 + 3]
        position = index * 4
        # Undo the black premultiplication to prevent a dark fringe on a light
        # desktop. Interior pixels retain their exact original RGB values.
        output[position:position + 4] = bytes((*[min(255, round(channel * 255 / alpha)) for channel in rgb], alpha))
    transparent = Image.frombytes("RGBA", source.size, bytes(output))
    alpha = transparent.getchannel("A")
    # Suppress isolated matte noise without extending or redrawing the contour.
    alpha = ImageChops.darker(alpha, alpha.filter(ImageFilter.MedianFilter(3)))
    transparent.putalpha(alpha.point(lambda value: value if value >= 8 else 0))
    crop = transparent.getchannel("A").getbbox()
    if not crop:
        raise ValueError("图标透明轮廓为空")
    return transparent.crop(crop), bounds, crop


def render_icon(artwork, size):
    content = ImageOps.contain(artwork, (size, size), Image.Resampling.LANCZOS)
    if size <= 64:
        # Keep the leaf and play mark crisp at tray scale; preserve alpha.
        alpha = content.getchannel("A")
        content = content.convert("RGB").filter(ImageFilter.UnsharpMask(radius=0.45, percent=75, threshold=2)).convert("RGBA")
        content.putalpha(alpha)
    canvas = Image.new("RGBA", (size, size))
    canvas.alpha_composite(content, ((size - content.width) // 2, (size - content.height) // 2))
    return canvas


def preview(large, frames, path):
    sheet = Image.new("RGB", (960, 740), "#eceef2")
    draw = ImageDraw.Draw(sheet)
    for index, background in enumerate(("#ffffff", "#252830")):
        x = 20 + index * 480
        draw.rectangle((x, 40, x + 440, 480), fill=background)
        image = large.resize((416, 416), Image.Resampling.LANCZOS)
        sheet.paste(image, (x + 12, 52), image)
        draw.text((x, 14), "Light background" if not index else "Dark background", fill="#222222")
    draw.text((20, 505), "ICO native sizes; the enlarged 16 px mark below uses nearest-neighbor display", fill="#222222")
    x = 20
    for size in SIZES:
        image = frames[size]
        if size > 128:
            continue
        draw.text((x, 534), str(size) + " px", fill="#222222")
        sheet.paste(image, (x, 555), image)
        x += max(70, size + 20)
    small = frames[16].resize((128, 128), Image.Resampling.NEAREST)
    sheet.paste(small, (805, 555), small)
    sheet.save(path, optimize=True)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, nargs="?", default=Path.home() / "Downloads" / "红果短剧渐彩应用图标.png")
    args = parser.parse_args()
    before = digest(args.source)
    with Image.open(args.source) as source:
        source_info = {"path": str(args.source.resolve()), "size": list(source.size), "mode": source.mode, "sha256": before}
        artwork, bounds, crop = remove_black_matte(source)
    assets = ROOT / "assets"
    assets.mkdir(exist_ok=True)
    icon, brand = render_icon(artwork, 1024), render_icon(artwork, 512)
    icon.save(assets / "icon.png", optimize=True)
    brand.save(assets / "brand.png", optimize=True)
    frames = {size: render_icon(artwork, size) for size in SIZES}
    frames[256].save(assets / "icon.ico", format="ICO", sizes=[(size, size) for size in SIZES],
                     append_images=[frames[size] for size in SIZES if size != 256])

    work = ROOT / "_work" / "icon-preview"
    work.mkdir(parents=True, exist_ok=True)
    preview(brand, frames, work / "contact-sheet.png")
    with Image.open(assets / "icon.ico") as saved:
        actual_sizes = sorted(saved.info.get("sizes", ()))
        if actual_sizes != [(size, size) for size in SIZES]:
            raise ValueError("生成的 ICO 尺寸不完整")
        for size in actual_sizes:
            if saved.ico.getimage(size).mode != "RGBA":
                raise ValueError("ICO 缺少透明通道")
    if digest(args.source) != before:
        raise ValueError("源图在处理过程中发生变化")
    report = {"source": source_info, "colorBounds": list(bounds), "cropBounds": list(crop),
              "croppedSize": list(artwork.size), "icoSizes": [list(size) for size in actual_sizes],
              "outputs": [{"path": str(path.resolve()), "size": list(Image.open(path).size),
                           "bytes": path.stat().st_size, "sha256": digest(path)}
                          for path in (assets / "icon.png", assets / "brand.png", assets / "icon.ico")],
              "preview": str((work / "contact-sheet.png").resolve())}
    (work / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True))


if __name__ == "__main__":
    main()
