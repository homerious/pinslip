#!/usr/bin/env python3
"""PinSlip 应用图标生成器——矢量式重绘，任意尺寸输出。

设计（与 v0.5 托盘/安装包图标一致）：
  圆角黄色便签 + 顶部琥珀色栏 + 红色图钉 + 棕色字母 P + 右下角卷角。

用法：
  python scripts/gen-icon.py                     # 默认输出 apps/desktop/resources/icon.png（1024）
  python scripts/gen-icon.py --size 512 --out /tmp/icon-512.png

依赖：Pillow + matplotlib（仅用其内置 DejaVuSans-Bold.ttf 画字母 P）。
"""
from __future__ import annotations

import argparse
import os

from PIL import Image, ImageDraw, ImageFont

# ---- 设计基准（以 256 为 1x 的相对坐标，颜色采样自 v0.5 正式图标）----
BODY = (255, 213, 79, 255)        # #FFD54F 便签主体
BAR = (240, 188, 52, 255)         # #F0BC34 顶部琥珀栏
BAR_LINE = (222, 168, 44, 255)    # 栏底分隔线
EDGE = (230, 180, 40, 255)        # 外轮廓深色边
PIN = (229, 57, 53, 255)          # #E53935 图钉
PIN_SHADOW = (214, 140, 40, 90)   # 图钉在栏上的软阴影
P_COLOR = (93, 64, 55, 255)       # #5D4037 字母 P
CURL = (255, 255, 255, 255)       # 卷角折面
CURL_SHADOW = (214, 164, 42, 110) # 卷角在纸面上的投影

MARGIN = 8        # 透明边距
RADIUS = 48       # 圆角半径
BAR_BOTTOM = 56   # 顶栏下沿
PIN_C = (128, 41) # 图钉圆心
PIN_R = 19        # 图钉半径
P_BBOX = (99, 110, 163, 198)      # 字母 P 视觉包围盒
CREASE_A = (189, 247)             # 卷角折痕端点 A（左下）
CREASE_B = (247, 189)             # 卷角折痕端点 B（右上）

BASE = 256


def find_p_font() -> str:
    """优先用 matplotlib 内置的 DejaVuSans-Bold；找不到再退化到系统黑体。"""
    try:
        import matplotlib  # noqa: PLC0415

        p = os.path.join(os.path.dirname(matplotlib.__file__), 'mpl-data', 'fonts', 'ttf', 'DejaVuSans-Bold.ttf')
        if os.path.exists(p):
            return p
    except ImportError:
        pass
    for c in ('C:/Windows/Fonts/arialbd.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'):
        if os.path.exists(c):
            return c
    raise RuntimeError('no bold font available for letter P')


def render(size: int) -> Image.Image:
    ss = 4                       # 超采样倍数，消除 PIL 锯齿
    S = size * ss
    k = S / BASE                 # 相对坐标 → 画布坐标

    def sc(v):
        return tuple(int(round(x * k)) for x in v)

    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    m = MARGIN * k
    box = (m, m, S - m, S - m)
    radius = RADIUS * k

    # 主体 + 深色描边（描边用外层稍大的圆角矩形垫底）
    stroke = max(2, int(round(2 * k)))
    d.rounded_rectangle((box[0] - stroke, box[1] - stroke, box[2] + stroke, box[3] + stroke),
                        radius=radius + stroke, fill=EDGE)
    d.rounded_rectangle(box, radius=radius, fill=BODY)

    # 顶部琥珀栏：矩形上段，用主体形状做裁切
    bar = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bar)
    bd.rounded_rectangle(box, radius=radius, fill=BAR)
    bd.rectangle((box[0], BAR_BOTTOM * k, box[2], box[3]), fill=(0, 0, 0, 0))
    img.alpha_composite(bar)
    # 栏底分隔线
    d.line((box[0], BAR_BOTTOM * k, box[2], BAR_BOTTOM * k), fill=BAR_LINE, width=max(2, int(1.5 * k)))

    # 图钉：软阴影 + 圆
    px, py = sc(PIN_C)
    pr = PIN_R * k
    d.ellipse((px - pr * 0.9, py - pr * 0.55 + 5 * k, px + pr * 0.9, py + pr * 0.75 + 5 * k), fill=PIN_SHADOW)
    d.ellipse((px - pr, py - pr, px + pr, py + pr), fill=PIN)

    # 字母 P：按视觉包围盒等比缩放并居中
    bx0, by0, bx1, by1 = sc(P_BBOX)
    font = ImageFont.truetype(find_p_font(), size=10)
    # 二分逼近：让 P 的渲染高度恰好填满包围盒
    lo, hi = 10, S
    for _ in range(24):
        mid = (lo + hi) // 2
        f = ImageFont.truetype(find_p_font(), size=mid)
        h = d.textbbox((0, 0), 'P', font=f)[3]
        if h < by1 - by0:
            lo = mid
        else:
            hi = mid
    font = ImageFont.truetype(find_p_font(), size=lo)
    tb = d.textbbox((0, 0), 'P', font=font)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    d.text((bx0 + (bx1 - bx0 - tw) / 2 - tb[0], by0 + (by1 - by0 - th) / 2 - tb[1]), 'P', font=font, fill=P_COLOR)

    # 右下卷角：折痕 AB + 白色折面（裁到主体形状内）+ 折痕侧软阴影
    ax, ay = sc(CREASE_A)
    bx, by = sc(CREASE_B)
    corner = (S - m, S - m)
    curl = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    cd = ImageDraw.Draw(curl)
    cd.polygon([(ax, ay), (bx, by), corner], fill=CURL)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    img.paste(curl, (0, 0), Image.composite(curl.split()[3], Image.new('L', (S, S), 0), mask))
    # 折痕旁纸面投影（折痕左上侧的窄三角）
    d.polygon([(ax, ay), (bx, by), (bx - int(34 * k), by - int(34 * k))], fill=CURL_SHADOW)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=1024)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'apps', 'desktop', 'resources', 'icon.png'))
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    render(args.size).save(out)
    print(f'[gen-icon] ok → {out} ({args.size}x{args.size})')


if __name__ == '__main__':
    main()
