"""Draws the app icon (build/icon.ico + build/icon.png).

The mark is a dark rounded square with a double chevron in the UI's accent
gradient — "rush" as forward motion. Run from the project root:

    python scripts/make-icon.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

BG = (10, 12, 16, 255)
ACCENT = (107, 138, 253)
GREEN = (62, 207, 142)

SIZES = [256, 128, 64, 48, 32, 24, 16]


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def mix(p, q, t):
    return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)


def chevron(draw, size, x_offset, span, thickness, color_fn, alpha=255):
    """One '>' drawn as a thick bent stroke."""
    w = size * span
    top = (x_offset, size * 0.28)
    mid = (x_offset + w, size * 0.5)
    bottom = (x_offset, size * 0.72)
    steps = 64
    for i in range(steps):
        t0 = i / steps
        t1 = (i + 1) / steps
        if t0 < 0.5:
            p0, p1 = mix(top, mid, t0 * 2), mix(top, mid, t1 * 2)
        else:
            p0, p1 = mix(mid, bottom, (t0 - 0.5) * 2), mix(mid, bottom, (t1 - 0.5) * 2)
        draw.line([p0, p1], fill=color_fn(t0) + (alpha,), width=thickness, joint="curve")


def render(size: int) -> Image.Image:
    scale = 4  # supersample, then downscale for smooth edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=BG)
    draw.rounded_rectangle(
        [s * 0.02, s * 0.02, s * 0.98, s * 0.98],
        radius=s * 0.21,
        outline=(44, 53, 69, 255),
        width=max(1, int(s * 0.012)),
    )

    thickness = max(2, int(s * 0.085))
    ramp = lambda t: lerp(ACCENT, GREEN, t)  # noqa: E731
    chevron(draw, s, s * 0.20, 0.20, thickness, ramp)
    chevron(draw, s, s * 0.44, 0.20, thickness, lambda t: lerp(ACCENT, GREEN, t))

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "build"
    out.mkdir(parents=True, exist_ok=True)
    frames = [render(s) for s in SIZES]
    frames[0].save(out / "icon.ico", format="ICO", sizes=[(s, s) for s in SIZES])
    render(512).save(out / "icon.png")
    print(f"wrote {out / 'icon.ico'} ({', '.join(str(s) for s in SIZES)}) and icon.png")


if __name__ == "__main__":
    main()
