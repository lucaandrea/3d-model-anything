#!/usr/bin/env python3
"""Verify rendered QR evidence and PDF reference pixels, physical sizes, ruler and trim."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import pdfplumber
from PIL import Image

MM = 72 / 25.4


def verify(pdf_path, kit_path, qr_results):
    kit = json.loads((kit_path / 'manifest.json').read_text())
    markers = [m for m in kit['markers'] if not m.get('retired')]
    by_pixels = {}
    for marker in markers:
        path = kit_path / marker['image']
        if hashlib.sha256(path.read_bytes()).hexdigest() != marker['imageSHA256']:
            raise ValueError('Reference image checksum differs from manifest')
        with Image.open(path) as image:
            key = hashlib.sha256(image.convert('L').tobytes()).hexdigest()
        if key in by_pixels: raise ValueError('Duplicate tracking artwork')
        by_pixels[key] = marker
    seen = Counter()
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for char in page.chars:
                if char['x0'] < 0 or char['x1'] > page.width or char['top'] < 0 or char['bottom'] > page.height:
                    raise ValueError(f'Text clipped on page {page.page_number}')
            for image in page.images:
                marker = by_pixels.get(hashlib.sha256(image['stream'].get_data()).hexdigest())
                if marker is None: raise ValueError('PDF image differs from registered tracking pixels')
                for actual, expected in [(image['width'], marker['physicalWidthMeters'] * 1000 * MM),
                                         (image['height'], marker['physicalHeightMeters'] * 1000 * MM)]:
                    if abs(actual - expected) > .02: raise ValueError(f'Incorrect printed size for {marker["id"]}')
                if min(image['x0'], image['top'], page.width-image['x1'], page.height-image['bottom']) < 5*MM:
                    raise ValueError('Tracking image enters printer margins')
                trim = (170,204) if marker['role'] == 'checkpoint' else (90,120)
                if not any(abs(r['width']-trim[0]*MM)<.02 and abs(r['height']-trim[1]*MM)<.02
                           and r['x0'] < image['x0'] and r['x1'] > image['x1']
                           and r['top'] < image['top'] and r['bottom'] > image['bottom'] for r in page.rects):
                    raise ValueError(f'Missing or wrong cut rectangle for {marker["id"]}')
                seen[marker['id']] += 1
        if seen != Counter(m['id'] for m in markers): raise ValueError('Missing or duplicated printed markers')
        if not any(abs(line['width']-100*MM)<.02 and abs(line['height'])<.02 for line in pdf.pages[0].lines):
            raise ValueError('Missing exact 100 mm ruler')
        pages = len(pdf.pages)
    decoded = json.loads(qr_results.read_text())
    if len(decoded) != pages: raise ValueError('QR decoding did not cover every rendered PDF page')
    actual = Counter(value for values in decoded.values() for value in values)
    if actual != Counter(m['url'] for m in markers): raise ValueError('Rendered QR payloads do not match manifest exactly')
    return {'file': str(pdf_path), 'pages': pages, 'markers': sum(seen.values()), 'QRs': sum(actual.values()),
            'referencePixelsMatch': True, 'physicalDimensionsMatch': True, 'ruler100mm': True,
            'cutRectanglesMatch': True, 'textWithinPage': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pdf', type=Path); parser.add_argument('kit', type=Path); parser.add_argument('qr_results', type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.pdf,args.kit,args.qr_results),indent=2))
