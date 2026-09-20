"""Export Windows icons from the approved Voxden logo artwork."""
from __future__ import annotations

import os

from PIL import Image, ImageFilter

# How much the small .ico frames are sharpened after the downscale, as
# (radius, percent) for the largest frame each applies to. A downscale this far
# softens the glow and blurs the three speed bars together; a light unsharp
# mask brings the edges back without changing the drawing. Larger frames are
# left as resized.
SMALL_FRAME_SHARPEN = ((24, 0.6, 90), (32, 0.8, 70), (48, 0.8, 45))


def fit_square(source: Image.Image, size: int) -> Image.Image:
    """Resize without redrawing, recoloring, cropping, or changing the logo."""
    image = source.convert("RGBA")
    if image.width != image.height:
        side = max(image.size)
        square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        square.alpha_composite(image, ((side - image.width) // 2, (side - image.height) // 2))
        image = square
    return image.resize((size, size), Image.Resampling.LANCZOS)


def ico_frame(source: Image.Image, size: int) -> Image.Image:
    """One .ico frame, resized straight from the full-size artwork."""
    frame = fit_square(source, size)
    for largest, radius, percent in SMALL_FRAME_SHARPEN:
        if size <= largest:
            alpha = frame.getchannel("A")
            frame = frame.filter(ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=1))
            frame.putalpha(alpha)
            break
    return frame


def save_multi_size_ico(dst: str, source: Image.Image, sizes: list[int]) -> None:
    frames = [ico_frame(source, size) for size in sizes]
    frames[-1].save(dst, format="ICO", sizes=[(size, size) for size in sizes], append_images=frames[:-1])


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets = os.path.join(root, "assets")
    reference = os.path.join(assets, "icon-reference.png")
    if not os.path.isfile(reference):
        print("missing assets/icon-reference.png")
        return 1

    approved = Image.open(reference).convert("RGBA")
    source = fit_square(approved, 1024)
    source.save(os.path.join(assets, "icon-source.png"), format="PNG", optimize=True)

    icon = fit_square(approved, 512)
    icon_png = os.path.join(assets, "icon.png")
    icon_ico = os.path.join(assets, "icon.ico")
    icon.save(icon_png, format="PNG", optimize=True)
    save_multi_size_ico(icon_ico, approved, [16, 24, 32, 48, 64, 128, 256])

    print(icon_png)
    print(icon_ico)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
