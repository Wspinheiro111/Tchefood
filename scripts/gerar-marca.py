#!/usr/bin/env python3
"""
Gera os arquivos da logo do Tchê Food a partir da logo animada oficial
(docs/brand/logo-tchefood-original.gif, enviada pelo Will em 11/11/2026).

A logo nova é a mesma marca de antes SEM o "^" solto em cima do balão, com o
balão um pouco maior em relação ao nome. O GIF tem só 800x400, então as versões
estáticas são remontadas em alta resolução com as peças vetoriais que já
existiam (balão, "TchêFood" e a frase), na mesma posição e proporção do GIF.

Uso (na raiz do repositório):  python3 scripts/gerar-marca.py
Requer Pillow e numpy. Gera:
  docs/brand/logo.png, logo-dark.png, logo-mono.png, icon.png
  src/assets/brand/logo.png, logo-dark.png, icon.png, logo-print.png, logo-animada.webp, logoAnimada.ts
  landing/src/assets/brand/logo.png, icon.png, landing/public/og-image.png
  android/app/src/pagbank/assets/tchefood-logo-print.png
  src/services/printer/brandLogoRaster.ts
"""
import base64
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / 'docs/brand'
GIF = BRAND / 'logo-tchefood-original.gif'
# Peças de alta resolução (versão anterior da marca, guardada no git em 7038254..875b9ac).
OLD = BRAND / 'fontes-v1'

GIF_BG = np.array([252, 252, 252], dtype=float)


def bbox(mask: np.ndarray):
    ys, xs = np.where(mask)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def gif_frames():
    im = Image.open(GIF)
    frames, durations = [], []
    for i in range(im.n_frames):
        im.seek(i)
        frames.append(np.asarray(im.convert('RGB')).astype(float))
        durations.append(im.info.get('duration', 40))
    return frames, durations


def gif_layout(last: np.ndarray):
    """Caixas do balão, do nome e da frase no último quadro (logo parada)."""
    ink = np.abs(last - GIF_BG).sum(2) > 30
    split = 260  # coluna entre o balão e o texto
    bubble = bbox(ink[:, :split])
    text = ink[:, split:]
    word = bbox(text[:236])
    tag = bbox(text[240:])
    word = (word[0] + split, word[1], word[2] + split, word[3])
    tag = (tag[0] + split, tag[1] + 240, tag[2] + split, tag[3] + 240)
    return bubble, word, tag


def tight(img: Image.Image) -> Image.Image:
    """Recorta pelo que é visível (alfa > 40), ignorando resíduos quase transparentes."""
    x0, y0, x1, y1 = bbox(np.asarray(img)[:, :, 3] > 40)
    return img.crop((x0, y0, x1, y1))


def pieces(img: Image.Image):
    """Separa balão (sem o ^), nome e frase de uma logo horizontal antiga."""
    a = np.asarray(img)[:, :, 3] > 40
    w = img.width
    cols = np.where(a.any(0))[0]
    # o balão termina na primeira coluna vazia larga depois do início
    gaps = np.where(np.diff(cols) > 40)[0]
    bubble_right = int(cols[gaps[0]]) + 1
    left = a[:, :bubble_right]
    rows = np.where(left.any(1))[0]
    # o ^ fica separado do balão por linhas vazias
    rgaps = np.where(np.diff(rows) > 5)[0]
    bubble_top = int(rows[rgaps[0] + 1]) if len(rgaps) else int(rows[0])
    bubble = img.crop((0, bubble_top, bubble_right, img.height))
    bubble = tight(bubble)
    text = img.crop((bubble_right, 0, w, img.height))
    ta = np.asarray(text)[:, :, 3] > 40
    trows = np.where(ta.any(1))[0]
    tg = np.where(np.diff(trows) > 20)[0]
    split = int(trows[tg[-1]]) + 1
    word = text.crop((0, 0, text.width, split))
    word = tight(word)
    tag = text.crop((0, split, text.width, text.height))
    tag = tight(tag)
    return bubble, word, tag


def compose(src: Image.Image, layout, scale: float) -> Image.Image:
    bubble_box, word_box, tag_box = layout
    x0 = min(b[0] for b in layout)
    y0 = min(b[1] for b in layout)
    x1 = max(b[2] for b in layout)
    y1 = max(b[3] for b in layout)
    out = Image.new('RGBA', (round((x1 - x0) * scale), round((y1 - y0) * scale)), (0, 0, 0, 0))
    for piece, box in zip(pieces(src), layout):
        w = round((box[2] - box[0]) * scale)
        h = round((box[3] - box[1]) * scale)
        out.alpha_composite(piece.resize((w, h), Image.LANCZOS), (round((box[0] - x0) * scale), round((box[1] - y0) * scale)))
    return out


def mono_without_caret(img: Image.Image) -> Image.Image:
    a = np.asarray(img)[:, :, 3] > 40
    rows = np.where(a.any(1))[0]
    rgaps = np.where(np.diff(rows) > 5)[0]
    top = int(rows[rgaps[0] + 1])  # primeira linha do balão, depois do ^
    out = img.crop((0, top, img.width, img.height))
    return tight(out)


def color_to_alpha(frame: np.ndarray) -> np.ndarray:
    """Tira o fundo cinza-claro do GIF preservando o antisserrilhado."""
    bg = GIF_BG
    diff = frame - bg
    denom = np.where(diff < 0, bg, 255 - bg)
    denom = np.where(denom == 0, 1, denom)
    alpha = np.clip((np.abs(diff) / denom).max(2), 0, 1)
    safe = np.where(alpha == 0, 1, alpha)[:, :, None]
    rgb = np.clip(bg + diff / safe, 0, 255)
    return np.dstack([rgb, alpha * 255]).astype(np.uint8)


def raster(img: Image.Image, width=360, height=198, box=(300, 182)):
    """Logo 1 bit para GS v 0 (bit 1 = ponto preto, MSB primeiro)."""
    k = min(box[0] / img.width, box[1] / img.height)
    small = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS)
    canvas = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    canvas.alpha_composite(small, ((width - small.width) // 2, (height - small.height) // 2))
    black = np.asarray(canvas)[:, :, 3] >= 128
    packed = np.packbits(black, axis=1)
    la = np.zeros((height, width, 2), dtype=np.uint8)
    la[:, :, 1] = np.where(black, 255, 0)
    return Image.fromarray(la, 'LA'), packed


def main():
    if not GIF.exists():
        sys.exit(f'falta {GIF}')
    frames, durations = gif_frames()
    layout = gif_layout(frames[-1])

    old_logo = Image.open(OLD / 'logo.png').convert('RGBA')
    old_dark = Image.open(OLD / 'logo-dark.png').convert('RGBA')
    old_mono = Image.open(OLD / 'logo-mono.png').convert('RGBA')

    # escala: o nome "TchêFood" fica do mesmo tamanho que na versão antiga
    _, old_word, _ = pieces(old_logo)
    scale = old_word.width / (layout[1][2] - layout[1][0])
    logo = compose(old_logo, layout, scale)
    _, dark_word, _ = pieces(old_dark)
    dark = compose(old_dark, layout, dark_word.width / (layout[1][2] - layout[1][0]))
    icon, _, _ = pieces(old_logo)
    mono = mono_without_caret(old_mono)

    for p, im in [('logo.png', logo), ('logo-dark.png', dark), ('icon.png', icon), ('logo-mono.png', mono)]:
        im.save(BRAND / p, optimize=True)
    for p in ['logo.png', 'logo-dark.png', 'icon.png']:
        shutil.copy(BRAND / p, ROOT / 'src/assets/brand' / p)
    for p in ['logo.png', 'icon.png']:
        shutil.copy(BRAND / p, ROOT / 'landing/src/assets/brand' / p)

    # imagem de compartilhamento da landing (1200x630, fundo branco)
    og = Image.new('RGBA', (1200, 630), (255, 255, 255, 255))
    k = 1000 / logo.width
    ol = logo.resize((1000, round(logo.height * k)), Image.LANCZOS)
    og.alpha_composite(ol, (100, (630 - ol.height) // 2))
    og.convert('RGB').save(ROOT / 'landing/public/og-image.png', optimize=True)

    # bobina térmica: raster 1 bit
    la, packed = raster(mono)
    la.save(ROOT / 'src/assets/brand/logo-print.png', optimize=True)
    Image.fromarray(np.where(np.asarray(la)[:, :, 1] > 0, 0, 255).astype(np.uint8)).convert('1').save(
        ROOT / 'android/app/src/pagbank/assets/tchefood-logo-print.png', optimize=True)
    h, wb = packed.shape
    b64 = base64.b64encode(packed.tobytes()).decode()
    (ROOT / 'src/services/printer/brandLogoRaster.ts').write_text(
        '// Gerado por scripts/gerar-marca.py a partir da versão monocromática oficial da marca (docs/brand/logo-mono.png).\n'
        '// 1 bit por ponto, 360 pontos de largura, para GS v 0 em bobinas de 58mm e 80mm.\n'
        'export const BRAND_LOGO_RASTER = {\n'
        f'  widthDots: {wb * 8},\n'
        f'  widthBytes: {wb},\n'
        f'  heightDots: {h},\n'
        f"  base64: '{b64}',\n"
        '} as const;\n')

    # logo animada (efeitos do GIF) com fundo transparente, recortada no que se mexe
    rgba = [color_to_alpha(f) for f in frames]
    union = np.zeros(rgba[0].shape[:2], dtype=bool)
    for f in rgba:
        union |= f[:, :, 3] > 8
    x0, y0, x1, y1 = bbox(union)
    pad = 4
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(union.shape[1], x1 + pad), min(union.shape[0], y1 + pad)
    anim = [Image.fromarray(f[y0:y1, x0:x1], 'RGBA') for f in rgba]
    anim[0].save(ROOT / 'src/assets/brand/logo-animada.webp', save_all=True, append_images=anim[1:],
                 duration=durations, loop=0, quality=88, method=6, lossless=False, allow_mixed=True)
    # onde a logo parada fica dentro do quadro animado (para a animada ocupar o mesmo lugar da estática)
    lx0, ly0 = min(b[0] for b in layout), min(b[1] for b in layout)
    lx1, ly1 = max(b[2] for b in layout), max(b[3] for b in layout)
    lw, lh = lx1 - lx0, ly1 - ly0
    (ROOT / 'src/assets/brand/logoAnimada.ts').write_text(
        '// Gerado por scripts/gerar-marca.py. Posição do quadro de logo-animada.webp em relação à logo\n'
        '// parada (em % da largura e da altura dela): o quadro animado tem folga para o balão pular,\n'
        '// o acento cair e os farelos, então ele transborda a caixa da logo estática.\n'
        'export const LOGO_ANIMADA_ENCAIXE = {\n'
        f'  left: {-(lx0 - x0) / lw * 100:.3f},\n'
        f'  top: {-(ly0 - y0) / lh * 100:.3f},\n'
        f'  width: {(x1 - x0) / lw * 100:.3f},\n'
        f'  height: {(y1 - y0) / lh * 100:.3f},\n'
        '} as const;\n')
    print('ok', logo.size, dark.size, icon.size, mono.size, (x1 - x0, y1 - y0))


if __name__ == '__main__':
    main()
