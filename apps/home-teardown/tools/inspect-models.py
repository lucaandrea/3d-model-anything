#!/usr/bin/env python3
"""Reports each GLB's bounding size in metres (glTF is Y-up, metres), node/mesh/material/texture counts and file size.
Run with -I:  python3 -I apps/home-teardown/tools/inspect-models.py apps/home-teardown/catalog-assets/models/*.glb"""
import json, math, os, struct, sys


def mat(n):
    if 'matrix' in n:
        m = n['matrix']
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = n.get('translation', [0, 0, 0]); q = n.get('rotation', [0, 0, 0, 1]); s = n.get('scale', [1, 1, 1])
    x, y, z, w = q
    R = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[R[r][0] * s[0], R[r][1] * s[1], R[r][2] * s[2], t[r]] for r in range(3)] + [[0, 0, 0, 1]]


def mul(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def inspect(path):
    if path.lower().endswith('.gltf'):
        with open(path, 'r', encoding='utf-8') as f:
            j = json.load(f)
    else:
        with open(path, 'rb') as f:
            magic, _, _ = struct.unpack('<III', f.read(12))
            if magic != 0x46546C67:
                return {'file': os.path.basename(path), 'error': 'not a GLB'}
            clen, _ = struct.unpack('<II', f.read(8))
            j = json.loads(f.read(clen))
    nodes, meshes, acc = j.get('nodes', []), j.get('meshes', []), j.get('accessors', [])
    lo, hi = [math.inf] * 3, [-math.inf] * 3

    def walk(i, M):
        n = nodes[i]
        M = mul(M, mat(n))
        if 'mesh' in n:
            for p in meshes[n['mesh']]['primitives']:
                a = acc[p['attributes']['POSITION']]
                for cx in (a['min'][0], a['max'][0]):
                    for cy in (a['min'][1], a['max'][1]):
                        for cz in (a['min'][2], a['max'][2]):
                            v = [M[r][0] * cx + M[r][1] * cy + M[r][2] * cz + M[r][3] for r in range(3)]
                            for k in range(3):
                                lo[k] = min(lo[k], v[k]); hi[k] = max(hi[k], v[k])
        for c in n.get('children', []):
            walk(c, M)

    I = [[1 if r == c else 0 for c in range(4)] for r in range(4)]
    scene = j.get('scenes', [{}])[j.get('scene', 0)]
    for r in scene.get('nodes', []):
        walk(r, I)
    size = [round(hi[k] - lo[k], 3) for k in range(3)]
    return {'file': os.path.basename(path), 'size_xyz_m': size, 'min': [round(v, 3) for v in lo], 'nodes': len(nodes), 'meshes': len(meshes), 'materials': [m.get('name', '') for m in j.get('materials', [])][:8], 'textures': len(j.get('textures', [])), 'mb': round(sum(os.path.getsize(os.path.join(dp, x)) for dp, _, fs in os.walk(os.path.dirname(path)) for x in fs) / 1048576, 2) if path.lower().endswith('.gltf') else round(os.path.getsize(path) / 1048576, 2), 'extensions': j.get('extensionsUsed', []), 'lights': len(j.get('extensions', {}).get('KHR_lights_punctual', {}).get('lights', [])), 'animations': len(j.get('animations', []))}


for p in sys.argv[1:]:
    print(json.dumps(inspect(p)))
