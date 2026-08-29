"""Export the Windows app icon from the metallic plate, and keep logo.svg for in-app UI."""
from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFilter


def squircle_mask(size: int, radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def plate_from_photo(src: str, size: int = 1024) -> Image.Image:
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    px = im.load()
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r + g + b > 18:
                xs.append(x)
                ys.append(y)
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    pad = 8
    crop = im.crop((
        max(0, x0 - pad),
        max(0, y0 - pad),
        min(w, x1 + pad + 1),
        min(h, y1 + pad + 1),
    ))
    side = max(crop.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(crop, ((side - crop.size[0]) // 2, (side - crop.size[1]) // 2), crop)
    out = canvas.resize((size, size), Image.Resampling.LANCZOS)
    radius = int(size * 0.22)
    mask = squircle_mask(size, radius)
    # soften the cut so the bevel edge stays
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(1, size // 400)))
    out.putalpha(mask)
    return out


def find_photo(root: str, assets: str) -> str | None:
    local = os.path.join(assets, "icon-source.png")
    if os.path.isfile(local):
        return local
    # Cursor attachment of the metallic plate
    att = os.path.join(
        os.path.expanduser("~"),
        ".cursor",
        "projects",
        "c-Users-souna-Projects-speakbar",
        "assets",
    )
    if os.path.isdir(att):
        for name in os.listdir(att):
            if name.lower().endswith((".jpg", ".jpeg", ".png")) and "hf_" in name:
                return os.path.join(att, name)
    return None


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets = os.path.join(root, "assets")
    os.makedirs(assets, exist_ok=True)

    src = find_photo(root, assets)
    if not src:
        print("missing metallic icon source")
        return 1

    plate = plate_from_photo(src, 1024)
    source_png = os.path.join(assets, "icon-source.png")
    if os.path.abspath(src) != os.path.abspath(source_png):
        plate.save(source_png, format="PNG")

    icon_png = os.path.join(assets, "icon.png")
    out = plate.resize((512, 512), Image.Resampling.LANCZOS)
    out.save(icon_png, format="PNG", optimize=True)

    ico_dst = os.path.join(assets, "icon.ico")
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    out.save(ico_dst, format="ICO", sizes=sizes)
    print(icon_png)
    print(ico_dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
