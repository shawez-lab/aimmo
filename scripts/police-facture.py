"""Écrit `packages/core/src/pilotage/facturx-police.ts` : la police des factures PDF/A-3 (HX60).

Poppins (licence SIL OFL 1.1, sans nom réservé), réduite aux caractères de WinAnsiEncoding, sans indications ni
tables de mise en forme, puis rangée en base64 avec ses chasses, pour que le Worker l'intègre au PDF sans rien charger.
Lancer : python3 scripts/police-facture.py /chemin/Poppins-Regular.ttf /chemin/Poppins-Bold.ttf
"""
import base64, io, sys
from fontTools.ttLib import TTFont
from fontTools import subset

# Les codes WinAnsi (cp1252) définis, de 32 à 255.
CODES = {}
for code in range(32, 256):
    try:
        ch = bytes([code]).decode('cp1252')
    except UnicodeDecodeError:
        continue
    CODES[code] = ord(ch)
CODES[0xA0] = 0xA0


def build(path, name):
    font = TTFont(path)
    opts = subset.Options()
    opts.layout_features = []
    opts.hinting = False
    opts.drop_tables += ['GSUB', 'GPOS', 'GDEF', 'DSIG', 'FFTM', 'meta', 'STAT', 'fvar', 'gvar', 'avar', 'HVAR', 'MVAR']
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    opts.glyph_names = False
    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=sorted(set(CODES.values())))
    sub.subset(font)
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    upm = font['head'].unitsPerEm
    cmap = font.getBestCmap()
    hmtx = font['hmtx']
    widths = []
    for code in range(32, 256):
        u = CODES.get(code)
        g = cmap.get(u) if u is not None else None
        widths.append(round(hmtx[g][0] * 1000 / upm) if g else 0)
    head = font['head']
    os2 = font['OS/2']
    post = font['post']
    s = lambda v: round(v * 1000 / upm)
    meta = {
        'name': name,
        'ascent': s(os2.sTypoAscender),
        'descent': s(os2.sTypoDescender),
        'capHeight': s(getattr(os2, 'sCapHeight', os2.sTypoAscender)),
        'bbox': [s(head.xMin), s(head.yMin), s(head.xMax), s(head.yMax)],
        'italicAngle': post.italicAngle,
        'stemV': 80 if 'Regular' in name else 140,
    }
    return data, widths, meta


def ts(var, data, widths, meta):
    b64 = base64.b64encode(data).decode()
    lines = [b64[i:i + 120] for i in range(0, len(b64), 120)]
    out = [f'export const {var}: PoliceFacture = {{']
    out.append(f"  name: '{meta['name']}',")
    out.append(f"  ascent: {meta['ascent']}, descent: {meta['descent']}, capHeight: {meta['capHeight']}, italicAngle: {meta['italicAngle']}, stemV: {meta['stemV']},")
    out.append(f"  bbox: [{', '.join(map(str, meta['bbox']))}],")
    out.append(f"  widths: [{', '.join(map(str, widths))}],")
    out.append('  base64:')
    out.append('    ' + ' +\n    '.join(f"'{l}'" for l in lines) + ',')
    out.append('};')
    return '\n'.join(out)


reg = build(sys.argv[1], 'Poppins-Regular')
bold = build(sys.argv[2], 'Poppins-Bold')
header = '''/**
 * La police des factures PDF/A-3 (HX60), écrite par `scripts/police-facture.py`, à ne pas modifier à la main.
 *
 * Poppins, Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins), sous licence SIL Open
 * Font License 1.1 (texte entier dans `facturx-police-OFL.txt`) : réduite aux caractères WinAnsi pour être intégrée à chaque facture.
 * `widths` donne la chasse des codes 32 à 255, en millièmes de corps, 0 pour un code absent de WinAnsi.
 */
export interface PoliceFacture {
  name: string;
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  stemV: number;
  bbox: [number, number, number, number];
  widths: number[];
  base64: string;
}

'''
with open('packages/core/src/pilotage/facturx-police.ts', 'w') as f:
    f.write(header + ts('POPPINS_REGULAR', *reg) + '\n\n' + ts('POPPINS_BOLD', *bold) + '\n')
print(len(reg[0]), len(bold[0]))
