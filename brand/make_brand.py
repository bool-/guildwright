"""Generate every Guildwright brand asset (SVG + PNG) from one geometry.

    python brand/make_brand.py brand        (from the repository root; needs Pillow)

Colours, the tagline and the banner shape are constants at the top. Change one and re-run;
every file in brand/ is rewritten.

Windows only as written: the PNG wordmarks are drawn with Segoe UI from C:/Windows/Fonts
(FONT_FILE and BODY_FONT_FILE below). Point them at any other .ttf files to run it elsewhere. The SVG wordmarks
are live text in the same font stack, so they render slightly differently on machines without
Segoe UI; the PNGs are the exact versions.
"""
import math
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

TEAL = "#0F4C5C"
GOLD = "#E0A526"
INK = "#0A2229"      # near-black teal for dark backgrounds
CREAM = "#F2EBDD"    # light wordmark on dark
FONT_STACK = "'Segoe UI Semibold','Segoe UI',Inter,'Helvetica Neue',Arial,sans-serif"
FONT_FILE = "C:/Windows/Fonts/seguisb.ttf"       # wordmark (Segoe UI Semibold)
BODY_FONT_FILE = "C:/Windows/Fonts/segoeui.ttf"  # taglines (Segoe UI)

# Geometry in a 120x120 icon box.
BANNER = [(22, 6), (98, 6), (98, 112), (79, 96), (60, 112), (41, 96), (22, 112)]
HAMMERS = [  # handle start, handle end, head centre, head angle (deg)
    ((42, 84), (73, 49), (75, 46.5), 42),
    ((78, 84), (47, 49), (45, 46.5), -42),
]
HANDLE_W, HEAD_W, HEAD_H = 7, 27, 11


def svg_icon(banner_fill, hammer_fill, transform=""):
    pts = " ".join(f"{x},{y}" for x, y in BANNER)
    parts = [f'<g transform="{transform}">' if transform else "<g>",
             f'<polygon points="{pts}" fill="{banner_fill}"/>']
    for (x1, y1), (x2, y2), (cx, cy), ang in HAMMERS:
        parts.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{hammer_fill}" '
                     f'stroke-width="{HANDLE_W}" stroke-linecap="round"/>')
        parts.append(f'<rect x="{-HEAD_W/2}" y="{-HEAD_H/2}" width="{HEAD_W}" height="{HEAD_H}" rx="2" '
                     f'fill="{hammer_fill}" transform="translate({cx},{cy}) rotate({ang})"/>')
    parts.append("</g>")
    return "".join(parts)


def svg(w, h, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'role="img" aria-label="{title}"><title>{title}</title>{body}</svg>\n')


def wordmark_svg(x, y, size, fill):
    return (f'<text x="{x}" y="{y}" font-family="{FONT_STACK}" font-size="{size}" font-weight="600" '
            f'fill="{fill}" letter-spacing="0.5">Guildwright</text>')


# ---------- PNG rendering (4x supersampled) ----------
SS = 4


def draw_icon(d, ox, oy, s, banner_fill, hammer_fill):
    k = s * SS
    P = lambda x, y: (ox * SS + x * k, oy * SS + y * k)
    d.polygon([P(x, y) for x, y in BANNER], fill=banner_fill)
    for (x1, y1), (x2, y2), (cx, cy), ang in HAMMERS:
        w = HANDLE_W * k
        d.line([P(x1, y1), P(x2, y2)], fill=hammer_fill, width=round(w))
        for px, py in (P(x1, y1), P(x2, y2)):
            d.ellipse([px - w / 2, py - w / 2, px + w / 2, py + w / 2], fill=hammer_fill)
        a = math.radians(ang)
        corners = []
        for dx, dy in ((-HEAD_W / 2, -HEAD_H / 2), (HEAD_W / 2, -HEAD_H / 2),
                       (HEAD_W / 2, HEAD_H / 2), (-HEAD_W / 2, HEAD_H / 2)):
            rx = dx * math.cos(a) - dy * math.sin(a)
            ry = dx * math.sin(a) + dy * math.cos(a)
            corners.append(P(cx + rx, cy + ry))
        d.polygon(corners, fill=hammer_fill)


def canvas(w, h, bg):
    img = Image.new("RGBA", (w * SS, h * SS), bg if bg else (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def save(img, w, h, name):
    img.resize((w, h), Image.LANCZOS).save(OUT / name)


def draw_text(d, x, y, size, text, fill):
    font = ImageFont.truetype(FONT_FILE, size * SS)
    d.text((x * SS, y * SS), text, font=font, fill=fill, anchor="ls")


# 1. Icon (transparent)
(OUT / "guildwright-icon.svg").write_text(svg(120, 120, svg_icon(TEAL, GOLD), "Guildwright"))
for px in (64, 256, 512):
    img, d = canvas(px, px, None)
    draw_icon(d, 0, 0, px / 120, TEAL, GOLD)
    save(img, px, px, f"guildwright-icon-{px}.png")

# 2. Avatar (square, circle-crop safe) for Discord / GitHub
av_body = (f'<rect width="512" height="512" fill="{TEAL}"/>'
           + svg_icon(GOLD, TEAL, "translate(256,256) scale(3.1) translate(-60,-59)"))
(OUT / "guildwright-avatar.svg").write_text(svg(512, 512, av_body, "Guildwright"))
for px in (512, 1024):
    img, d = canvas(px, px, TEAL)
    s = 3.1 * px / 512
    draw_icon(d, px / 2 - 60 * s, px / 2 - 59 * s, s, GOLD, TEAL)
    save(img, px, px, f"guildwright-avatar-{px}.png")

# 3. Horizontal logo, light and dark backgrounds
for variant, word in (("light", TEAL), ("dark", CREAM)):
    body = svg_icon(TEAL if variant == "light" else "#1C7A8F", GOLD, "translate(8,10)") \
        + wordmark_svg(146, 92, 64, word)
    (OUT / f"guildwright-logo-{variant}.svg").write_text(svg(560, 140, body, "Guildwright"))
    img, d = canvas(560, 140, None)
    draw_icon(d, 8, 10, 1, TEAL if variant == "light" else "#1C7A8F", GOLD)
    draw_text(d, 146, 92, 64, "Guildwright", word)
    save(img, 1120, 280, f"guildwright-logo-{variant}.png")

# 4. GitHub social preview, 1280x640
TAG = "Ask in Discord. Approve it. Get it built."
sp_body = (f'<rect width="1280" height="640" fill="{INK}"/>'
           + svg_icon("#1C7A8F", GOLD, "translate(150,170) scale(2.5)")
           + wordmark_svg(520, 330, 104, CREAM)
           + f'<text x="524" y="400" font-family="{FONT_STACK}" font-size="38" fill="{GOLD}">{TAG}</text>')
(OUT / "guildwright-social.svg").write_text(svg(1280, 640, sp_body, "Guildwright"))
img, d = canvas(1280, 640, INK)
draw_icon(d, 150, 170, 2.5, "#1C7A8F", GOLD)
draw_text(d, 520, 330, 104, "Guildwright", CREAM)
font = ImageFont.truetype(BODY_FONT_FILE, 38 * SS)
d.text((524 * SS, 400 * SS), TAG, font=font, fill=GOLD, anchor="ls")
save(img, 1280, 640, "guildwright-social.png")

# 5. Discord cover / invite image, 1024x576 (16:9)
img, d = canvas(1024, 576, INK)
draw_icon(d, 92, 138, 2.5, "#1C7A8F", GOLD)
draw_text(d, 430, 300, 84, "Guildwright", CREAM)
font = ImageFont.truetype(BODY_FONT_FILE, 30 * SS)
d.text((433 * SS, 356 * SS), "Ask in Discord. Approve it.", font=font, fill=GOLD, anchor="ls")
d.text((433 * SS, 396 * SS), "Get it built.", font=font, fill=GOLD, anchor="ls")
save(img, 1024, 576, "guildwright-cover-1024x576.png")

# 6. Discord bot profile banner, 680x240 (17:6). The avatar overlaps the
# bottom-left corner of the profile card, so content sits centre-right.
img, d = canvas(680, 240, INK)
d.line([0, 16 * SS, 680 * SS, 22 * SS], fill="#2A4F59", width=2 * SS)   # bunting string
for i, x in enumerate(range(6, 680, 30)):
    y = 16 + 6 * x / 680
    col = "#1C7A8F" if i % 2 == 0 else "#8A6A1F"
    d.polygon([(x * SS, y * SS), ((x + 22) * SS, (y + 0.2) * SS), ((x + 11) * SS, (y + 22) * SS)], fill=col)
d.rectangle([0, 235 * SS, 680 * SS, 240 * SS], fill=GOLD)
draw_icon(d, 192, 66, 0.9, "#1C7A8F", GOLD)
draw_text(d, 306, 138, 50, "Guildwright", CREAM)
font = ImageFont.truetype(BODY_FONT_FILE, 17 * SS)
d.text((309 * SS, 170 * SS), "Ask in Discord. Approve it. Get it built.", font=font, fill=GOLD, anchor="ls")
save(img, 680, 240, "guildwright-discord-banner-680x240.png")
save(img, 1360, 480, "guildwright-discord-banner-1360x480.png")

print("\n".join(sorted(p.name for p in OUT.iterdir())))
