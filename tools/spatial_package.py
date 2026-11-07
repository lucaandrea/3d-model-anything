#!/usr/bin/env python3
"""Build and validate a derived house-spatial/1 package, without changing source captures."""
import argparse
import hashlib
import json
import math
import shutil
import copy
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

IDENTITY = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]

def canonical(v): return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode()
def finite(v): return type(v) in (int,float) and math.isfinite(v)
def vector(v,n): return isinstance(v,list) and len(v)==n and all(finite(x) for x in v)
def is_hash(v): return isinstance(v,str) and re.fullmatch('[0-9a-f]{64}',v) is not None
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024), b''): h.update(block)
    return h.hexdigest()

def rigid(m):
    if not vector(m,16): return False
    if any(abs(m[i]-v)>1e-4 for i,v in [(3,0),(7,0),(11,0),(15,1)]): return False
    cols=[m[i:i+3] for i in [0,4,8]]
    for i in range(3):
        for j in range(3):
            if abs(sum(a*b for a,b in zip(cols[i],cols[j]))-(1 if i==j else 0))>1e-3:return False
    a,b,c=cols
    det=a[0]*(b[1]*c[2]-b[2]*c[1])-b[0]*(a[1]*c[2]-a[2]*c[1])+c[0]*(a[1]*b[2]-a[2]*b[1])
    return abs(det-1)<1e-3

def contained(root, name):
    root=Path(root)
    if root.is_symlink():raise ValueError('Symbolic package roots are not allowed')
    p=Path(name)
    if not isinstance(name,str) or '\\' in name or p.as_posix()!=name or p.is_absolute() or '..' in p.parts or not p.parts: raise ValueError('Invalid relative asset path')
    candidate=root/p
    current=root
    for part in p.parts:
        current=current/part
        if current.is_symlink():raise ValueError('Symbolic links are not allowed')
    if not candidate.resolve().is_relative_to(root.resolve()) or not candidate.is_file(): raise ValueError('Missing or escaped asset')
    return candidate

def validate(root):
    root=Path(root);m=json.loads((root/'manifest.json').read_text())
    if (m.get('format'),m.get('units'),m.get('upAxis'),m.get('handedness'))!=('house-spatial/1','meters','Y','right'):raise ValueError('Unsupported spatial format')
    claimed=m['revision'];body={k:v for k,v in m.items() if k!='revision'}
    if hashlib.sha256(canonical(body)).hexdigest()!=claimed:raise ValueError('Manifest revision mismatch')
    if not m.get('houseID') or not 0<len(m['rooms'])<=1000 or not 0<len(m['assets'])<=2000:raise ValueError('Empty or oversized package')
    levels={level['id'] for level in m['levels']}
    if not levels or len(levels)!=len(m['levels']) or any(not level['id'] or not finite(level['elevation']) for level in m['levels']):raise ValueError('Invalid floor levels')
    ids=set()
    for room in m['rooms']:
        if room['id'] in ids or not rigid(room['roomToHouse']) or not rigid(room['source']['worldToRoom']):raise ValueError('Invalid room identity/transform')
        ids.add(room['id'])
        if room['levelID'] not in levels or not 3<=len(room['polygon'])<=1000 or not all(vector(p,2) for p in room['polygon']):raise ValueError('Invalid polygon or floor level')
        poly=room['polygon'];area=sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(poly,poly[1:]+poly[:1]))
        if abs(area)<.01:raise ValueError('Zero-area polygon')
        if not finite(room['floorY']) or not finite(room['ceilingY']) or room['floorY']>=room['ceilingY']:raise ValueError('Invalid room height')
        if type(room['alignment']['verified']) is not bool or (room['alignment']['verified'] and not m.get('checkpoints')):raise ValueError('Alignment verification requires independent checkpoint evidence')
    keys=set();paths=set();total=0
    for asset in m['assets']:
        key=(asset['id'],asset['representation'])
        if key in keys or asset['path'] in paths:raise ValueError('Duplicate asset representation or path')
        keys.add(key);paths.add(asset['path']);path=contained(root,asset['path'])
        if not is_hash(asset['sha256']) or type(asset['byteLength']) is not int or not 0<asset['byteLength']<=512*1024*1024:raise ValueError('Invalid asset size or hash')
        total+=asset['byteLength']
        if total>2*1024*1024*1024:raise ValueError('Spatial package exceeds 2 GiB')
        if path.stat().st_size!=asset['byteLength'] or sha(path)!=asset['sha256']:raise ValueError('Asset checksum mismatch')
        if asset.get('roomID') is not None and asset['roomID'] not in ids:raise ValueError('Unknown asset room')
        if asset['kind'] not in ['display','collision','reference']:raise ValueError('Unknown asset kind')
        b=asset['bounds']
        if not vector(b.get('min'),3) or not vector(b.get('max'),3) or any(a>z for a,z in zip(b['min'],b['max'])):raise ValueError('Invalid bounds')
    kit=None
    if m.get('markerKit'):
        kit_path=contained(root,m['markerKit']);kit=json.loads(kit_path.read_text())
        if kit.get('format')!='marker-kit/1' or hashlib.sha256(canonical(kit['markers'])).hexdigest()!=kit['revision']:raise ValueError('Invalid marker kit revision')
        if len({v['id'] for v in kit['markers']})!=len(kit['markers']):raise ValueError('Duplicate marker')
        for marker in kit['markers']:
            if sha(contained(kit_path.parent,marker['image']))!=marker['imageSHA256']:raise ValueError('Changed marker artwork')
    checkpoint_ids=set()
    for checkpoint in m.get('checkpoints',[]):
        key=(checkpoint['kitID'],checkpoint['markerID'])
        if key in checkpoint_ids:raise ValueError('Duplicate checkpoint')
        checkpoint_ids.add(key)
        if not kit or kit['kitID']!=checkpoint['kitID'] or not any(v['id']==checkpoint['markerID'] and v['role']=='checkpoint' and not v.get('retired') for v in kit['markers']):raise ValueError('Checkpoint must be an active fixed marker')
        if not rigid(checkpoint['houseFromMarker']) or len(checkpoint['validationPoints'])<3:raise ValueError('Unverified checkpoint')
        for point in checkpoint['validationPoints']:
            if not vector(point['house'],3) or not vector(point['observed'],3) or not finite(point['errorMeters']):raise ValueError('Invalid checkpoint measurements')
            actual=math.dist(point['house'],point['observed'])
            if not math.isfinite(actual) or actual>0.10 or abs(actual-point['errorMeters'])>0.001:raise ValueError('Checkpoint error exceeds tolerance')
        points=checkpoint['validationPoints']
        if any(math.dist(a['house'],b['house'])<.5 for i,a in enumerate(points) for b in points[i+1:]):raise ValueError('Checkpoint measurements must be independently spaced')
    return m

def build(args):
    out=args.output
    if out.exists():raise ValueError('Output already exists; use a new revision directory')
    room=json.loads(args.room.read_text());evidence=json.loads((args.assets/'export-evidence.json').read_text())
    placement=room.get('housePlacement',{})
    transform=placement.get('roomToHouse',IDENTITY)
    if placement and placement.get('status')=='blocked':raise ValueError('Room placement is unresolved')
    if not rigid(transform):raise ValueError('Room placement is not rigid')
    out.mkdir(parents=True);(out/'assets').mkdir()
    assets=[]
    for filename,kind,mime in [('room.usdz','display','model/vnd.usdz+zip'),('room.glb','display','model/gltf-binary'),('collision.usdz','collision','model/vnd.usdz+zip')]:
        dest=out/'assets'/filename;shutil.copy2(args.assets/filename,dest)
        assets.append({'id':args.room_id+'-'+kind,'representation':dest.suffix[1:],'path':'assets/'+filename,
            'sha256':sha(dest),'byteLength':dest.stat().st_size,'mediaType':mime,'roomID':args.room_id,'kind':kind,'bounds':evidence.get('collisionBounds',evidence['bounds']) if kind=='collision' else evidence['bounds']})
    manifest={'format':'house-spatial/1','houseID':args.house_id,'name':args.name,'createdAt':datetime.now(timezone.utc).isoformat(),
        'producer':'3D Model Anything spatial_package.py/1','units':'meters','upAxis':'Y','handedness':'right',
        'levels':[{'id':args.level_id,'name':args.level_name,'elevation':args.level_elevation}],
        'rooms':[{'id':args.room_id,'name':args.name,'levelID':args.level_id,'polygon':room['polygon'],'floorY':args.floor_y,
            'ceilingY':args.ceiling_y if args.ceiling_y is not None else max(w['height'] for w in room['walls']),'roomToHouse':transform,
            'source':{'sessionID':placement.get('session',room.get('source','unknown')),'roomIndex':args.room_index,'worldToRoom':room['transform']['worldToRoom']},
            'alignment':{'method':'first' if not placement else 'manual','verified':False}}],
        'assets':assets,'checkpoints':[],
        'provenance':{'sourceFormat':'house-capture/5','geometryStatus':'mixed','notes':[
            'Single-room pilot; no physical card registration has been measured.',
            'Measured shell and photo-authored objects; hidden surfaces/material details may be approximate.',
            'No unscanned room or loft floor is inferred from the estimated House Control plan.']}}
    if args.kit:
        kit=json.loads((args.kit/'manifest.json').read_text())
        target=out/'marker-kit';target.mkdir();(target/'reference-images').mkdir()
        shutil.copy2(args.kit/'manifest.json',target/'manifest.json')
        for marker in kit['markers']:shutil.copy2(contained(args.kit,marker['image']),target/marker['image'])
        manifest['markerKit']='marker-kit/manifest.json'
    manifest['revision']=hashlib.sha256(canonical(manifest)).hexdigest()
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    shutil.copy2(args.assets/'export-evidence.json',out/'export-evidence.json')
    validate(out)
    return manifest

def assemble(config_path,out):
    """Join validated derived packages using explicit placements; never infer joins from names."""
    config=json.loads(config_path.read_text())
    manifest={'format':'house-spatial/1','houseID':config['houseID'],'name':config['name'],
        'createdAt':datetime.now(timezone.utc).isoformat(),'producer':'3D Model Anything spatial_package.py/1',
        'units':'meters','upAxis':'Y','handedness':'right','levels':config['levels'],'rooms':[],'assets':[],
        'checkpoints':[],'provenance':{'sourceFormat':'house-spatial/1','geometryStatus':'mixed','notes':[
            'Room joins and floor elevations are explicit; physical localization remains unverified.',
            'Source capture transforms, object IDs and asset hashes are preserved.']}}
    out.mkdir(parents=True);kit_identity=None
    for number,placement in enumerate(config['rooms']):
        root=(config_path.parent/placement['package']).resolve();source=validate(root)
        room=copy.deepcopy(next(r for r in source['rooms'] if r['id']==placement['roomID']))
        transform=placement['roomToHouse']
        if not rigid(transform):raise ValueError('Explicit rigid roomToHouse is required for every room')
        room.update(roomToHouse=transform,levelID=placement['levelID'],alignment={'method':'manual','verified':False})
        manifest['rooms'].append(room)
        for original in source['assets']:
            if original.get('roomID')!=room['id']:continue
            asset=copy.deepcopy(original);path=f'assets/room-{number:03d}/{Path(asset["path"]).name}'
            dest=out/path;dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(contained(root,asset['path']),dest);asset['path']=path;manifest['assets'].append(asset)
        if source.get('markerKit'):
            kitfile=contained(root,source['markerKit']);kit=json.loads(kitfile.read_text())
            identity=(kit['kitID'],kit['revision'])
            if kit_identity and identity!=kit_identity:raise ValueError('All rooms must use the same current marker kit revision')
            if not kit_identity:
                target=out/'marker-kit';(target/'reference-images').mkdir(parents=True)
                shutil.copy2(kitfile,target/'manifest.json')
                for marker in kit['markers']:shutil.copy2(contained(kitfile.parent,marker['image']),target/marker['image'])
                manifest['markerKit']='marker-kit/manifest.json';kit_identity=identity
    manifest['revision']=hashlib.sha256(canonical(manifest)).hexdigest()
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');validate(out)
    return manifest

def publish(args):
    out=args.output
    if out.exists():raise ValueError('Output already exists; use a new revision directory')
    out.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.spatial-stage-',dir=out.parent) as temp:
        stage=Path(temp)/'package';args.output=stage
        try:manifest=assemble(args.assemble,stage) if args.assemble else build(args)
        finally:args.output=out
        stage.rename(out)
    print(json.dumps({'package':str(out),'revision':manifest['revision'],'rooms':len(manifest['rooms']),'assets':len(manifest['assets']),'physicallyCalibrated':False},indent=2))

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--validate',type=Path)
    p.add_argument('--assemble',type=Path,help='Explicit multi-room placement config; no implicit room matching')
    p.add_argument('--room',type=Path);p.add_argument('--assets',type=Path);p.add_argument('--kit',type=Path)
    p.add_argument('--output',type=Path);p.add_argument('--room-id',default='office-entrance');p.add_argument('--room-index',type=int,default=0)
    p.add_argument('--house-id',default='loft-scan-pilot');p.add_argument('--name',default='Office / Entrance')
    p.add_argument('--level-id',default='ground');p.add_argument('--level-name',default='Ground floor');p.add_argument('--level-elevation',type=float,default=0)
    p.add_argument('--floor-y',type=float,default=0);p.add_argument('--ceiling-y',type=float)
    a=p.parse_args()
    if a.validate:validate(a.validate);print('Spatial package validated')
    else:
        if not a.output or (not a.assemble and not all([a.room,a.assets])):p.error('--output and either --assemble or --room/--assets are required')
        publish(a)

if __name__=='__main__':main()
