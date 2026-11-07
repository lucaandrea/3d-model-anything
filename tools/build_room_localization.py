#!/usr/bin/env python3
"""Build private, room-specific recovery assets from explicitly registered sources.

Inputs are local review/spec files. No coordinates or personalized photos belong in Git.
The spec must supply each map's referenceFromSession transform and provenance.
This tool never estimates a transform or edits an original capture.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

import numpy as np
from PIL import Image, ImageDraw, ImageOps


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inside(poly, point, margin=0.06):
    p = np.array(point, dtype=float)
    result = False
    for i, a in enumerate(poly):
        a, b = np.array(a), np.array(poly[(i+1) % len(poly)])
        edge = b-a
        length = float(edge @ edge)
        if length < 1e-8:
            continue
        t = np.clip((p-a) @ edge / length, 0, 1)
        if np.linalg.norm(p-a-t*edge) < margin:
            return False
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]:
            result = not result
    return result


def build(spec_path, output):
    spec = json.loads(spec_path.read_text())
    guide_path, model_path = Path(spec['guide']), Path(spec['model'])
    guide, model = json.loads(guide_path.read_text()), json.loads(model_path.read_text())
    output.mkdir(parents=True, exist_ok=True)
    catalog = dict(format='room-localization/1', houseID=guide['houseID'], floorStepID=guide['floorStepID'],
                   guideSHA256=sha(guide_path), references=[], photos=[], preferredReferenceByRoom=spec['preferredReferenceByRoom'])
    for item in spec['references']:
        matrix = np.array(item['referenceFromSession']).reshape(4, 4, order='F')
        if not np.isfinite(matrix).all() or not np.allclose(matrix[3], [0,0,0,1], atol=1e-5) or not np.allclose(matrix[:3,:3].T @ matrix[:3,:3], np.eye(3), atol=0.01) or abs(np.linalg.det(matrix)-1)>0.02:
            raise ValueError('Reference transform is not rigid')
        source = Path(item['sourceMap'])
        if sha(source) != item['mapSHA256']:
            raise ValueError('Source map hash changed')
        name = item['mapFile']
        if Path(name).name != name or not item['provenance']:
            raise ValueError('Unsafe asset name or missing registration evidence')
        if source.resolve() != (output/name).resolve():
            shutil.copy2(source, output/name)
        catalog['references'].append({k: v for k, v in item.items() if k != 'sourceMap'})
    audit = []
    for room in guide['rooms']:
        candidates = []
        for index, photo in enumerate(model['photos']):
            p, f = np.array(photo['position']), np.array(photo['forward'])
            f /= np.linalg.norm(f)
            if not (room['minY']+0.65 <= p[1] <= room['maxY']) or not inside(room['polygon'], p[[0,2]]):
                continue
            blur = photo.get('blurPixels')
            if not inside(room['polygon'], (p+f*0.65)[[0,2]], 0.02) or abs(f[1]) > 0.45 or (blur is not None and blur > 3):
                continue
            # The explicitly supplied image pattern maps model-photo indices to exported images.
            source = Path(spec['photoPattern'].format(index=index))
            if not source.is_file():
                raise ValueError(f'Missing image for model photo {index}')
            candidates.append(dict(index=index, source=source, p=p, f=f, blur=blur if blur is not None else 3))
        chosen = []
        curated = spec.get('selectedPhotoIndicesByRoom', {}).get(room['id'])
        if curated is not None:
            by_index = {c['index']: c for c in candidates}
            if not 1 <= len(curated) <= 6 or any(i not in by_index for i in curated):
                raise ValueError(f'Curated photos outside the room or quality constraints: {room["id"]}; eligible: {list(by_index)}')
            chosen = [by_index[i] for i in curated]
            candidates = []
        while candidates and len(chosen) < 6:
            def score(c):
                if not chosen:
                    return -c['blur']-abs(c['f'][1])
                novelty = min(min(3, np.linalg.norm(c['p']-v['p'])) + 2*(1-float(c['f'] @ v['f'])) for v in chosen)
                return novelty - 0.1*c['blur']
            best = max(candidates, key=score)
            candidates.remove(best)
            chosen.append(best)
        if not chosen:
            raise ValueError(f'No trustworthy room photographs for {room["id"]}; do not substitute another room')
        thumbnails = []
        for c in chosen:
            name = f'landmark-{room["id"]}-{c["index"]:04}.jpg'
            image = ImageOps.exif_transpose(Image.open(c['source'])).convert('RGB')
            image.thumbnail((900, 1200))
            image.save(output/name, quality=88)
            catalog['photos'].append(dict(roomID=room['id'], file=name, sha256=sha(output/name),
                positionInModel=c['p'].tolist(), forwardInModel=c['f'].tolist()))
            thumbnails.append((name, image.copy(), c['index']))
        sheet = Image.new('RGB', (len(thumbnails)*220, 340), 'white')
        draw = ImageDraw.Draw(sheet)
        for i, (name, image, index) in enumerate(thumbnails):
            image.thumbnail((210, 285))
            sheet.paste(image, (i*220, 35))
            draw.text((i*220+4, 4), f'{room["label"][:25]} / {index}', fill='black')
        sheet.save(output/f'check-{room["id"]}.jpg')
        audit.append(dict(room=room['id'], photoIndices=[c['index'] for c in chosen]))
    data = json.dumps(catalog, sort_keys=True, indent=2)+'\n'
    (output/'localization.json').write_text(data)
    (output/'photo-selection.json').write_text(json.dumps(audit, indent=2)+'\n')
    print(json.dumps(dict(catalogSHA256=sha(output/'localization.json'), rooms=audit), indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.spec, args.output)
