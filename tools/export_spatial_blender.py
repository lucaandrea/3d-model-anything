"""Run in Blender. Export a disposable derived copy, never save over the editable .blend."""
import argparse
import json
import sys
import struct
import uuid
from pathlib import Path
import bpy
from mathutils import Vector

p = argparse.ArgumentParser()
p.add_argument('--blend', type=Path, required=True)
p.add_argument('--room', type=Path, required=True)
p.add_argument('--out', type=Path, required=True)
p.add_argument('--room-id', required=True)
p.add_argument('--metadata-glb', type=Path, help='Reviewed viewer copy supplying existing cutaway tags by object name')
a = p.parse_args(sys.argv[sys.argv.index('--')+1:])
targets = [a.out/name for name in ['room.blend','room.glb','room.usdz','collision.usdz','export-evidence.json']]
if any(target.resolve() == a.blend.resolve() for target in targets):
    raise ValueError('The export would overwrite its editable source; choose a new output revision folder')
if any(target.exists() for target in targets):
    raise ValueError('This output revision already has assets; choose a new revision folder to preserve them')
a.out.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(a.blend))
viewer_tags={}
if a.metadata_glb:
    with a.metadata_glb.open('rb') as source:
        magic,version,length=struct.unpack('<4sII',source.read(12))
        size,kind=struct.unpack('<I4s',source.read(8))
        if magic!=b'glTF' or version!=2 or kind!=b'JSON' or size>16*1024*1024:raise ValueError('Invalid metadata GLB')
        for node in json.loads(source.read(size))['nodes']:
            viewer_tags[node.get('name','')]={k:v for k,v in node.get('extras',{}).items() if k in ['capture_wall_index','capture_ceiling','capture_item']}
full = next((s for s in bpy.data.scenes if 'Full room' in s.name), bpy.context.scene)
bpy.context.window.scene = full
for layer in full.view_layers[0].layer_collection.children:
    layer.exclude = False
    layer.collection.hide_viewport = False
bpy.ops.object.select_all(action='DESELECT')
names = set()
object_ids = set()
for obj in full.objects:
    if obj.type in {'CAMERA', 'LIGHT'} or any(c.name.startswith(('R00', 'C00', 'L00', 'L20')) for c in obj.users_collection):
        continue
    obj.hide_set(False); obj.hide_viewport = False; obj.hide_render = False
    ident = str(obj.get('spatialObjectID') or uuid.uuid5(uuid.NAMESPACE_URL, a.room_id + '/' + obj.name))
    uuid.UUID(ident)
    if ident in object_ids:raise ValueError(f'Duplicate object ID on {obj.name}; assign a new ID to the duplicated object')
    object_ids.add(ident);obj['spatialObjectID'] = ident
    obj['spatialRoomID'] = a.room_id
    for key,value in viewer_tags.get(obj.name,{}).items():obj[key]=value
    obj.select_set(True); names.add(obj.name)
bpy.context.view_layer.update()
# Preserve editable curves, packed photographs, hierarchy and stable IDs in a derived copy.
bpy.ops.wm.save_as_mainfile(filepath=str(a.out/'room.blend'), copy=True)
curves = [o for o in bpy.context.selected_objects if o.type in {'CURVE','FONT','SURFACE'}]
if curves:
    bpy.ops.object.select_all(action='DESELECT')
    for o in curves: o.select_set(True)
    bpy.context.view_layer.objects.active = curves[0]
    bpy.ops.object.convert(target='MESH')
bpy.ops.object.select_all(action='DESELECT')
for obj in full.objects:
    if obj.name in names: obj.select_set(True)

def bounds(objects):
    points = [o.matrix_world @ Vector(v) for o in objects if o.type == 'MESH' for v in o.bound_box]
    if not points: raise ValueError('No mesh geometry selected')
    # Blender Z-up to runtime Y-up.
    mapped = [(v.x, v.z, -v.y) for v in points]
    return {'min':[min(v[i] for v in mapped) for i in range(3)], 'max':[max(v[i] for v in mapped) for i in range(3)]}

original_bounds = bounds(bpy.context.selected_objects)
objects = [{'id':o['spatialObjectID'], 'name':o.name, 'parentID':o.parent.get('spatialObjectID') if o.parent else None,
            'bounds':bounds([o]) if o.type=='MESH' else None,
            'dimensionsMeters':[o.dimensions.x,o.dimensions.z,o.dimensions.y],
            'sourcePhotos':o.get('source_photos',''), 'measurementConfidence':o.get('measurement_confidence','authored'),
            'reconstructionNote':o.get('reconstruction_note','')}
           for o in bpy.context.selected_objects if 'spatialObjectID' in o]
bpy.ops.export_scene.gltf(filepath=str(a.out/'room.glb'), export_format='GLB', use_selection=True,
    export_apply=True, export_yup=True, export_extras=True, export_cameras=False, export_lights=False)
usd_options = dict(selected_objects_only=True, convert_orientation=True,
    export_global_forward_selection='NEGATIVE_Z', export_global_up_selection='Y',
    export_materials=True, generate_preview_surface=True, export_custom_properties=True,
    export_lights=False, export_cameras=False, use_instancing=True,
    convert_scene_units='METERS', meters_per_unit=1.0, triangulate_meshes=True)
bpy.ops.wm.usd_export(filepath=str(a.out/'room.usdz'), **usd_options)

# A coarse architectural occlusion/collision shell; openings remain open.
room = json.loads(a.room.read_text())
bpy.ops.object.select_all(action='DESELECT')
verts, faces = [], []
def quad(points):
    start=len(verts); verts.extend((x,-z,y) for x,y,z in points); faces.append(tuple(range(start,start+len(points))))
poly=room['polygon']; quad([(x,0,z) for x,z in reversed(poly)])
for wall in room['walls']:
    length, height = wall['length'], wall['height']
    holes=wall.get('openings',[])
    xs=sorted({0,length,*[max(0,min(length,h[k])) for h in holes for k in ['u0','u1']]})
    ys=sorted({0,height,*[max(0,min(height,h[k])) for h in holes for k in ['v0','v1']]})
    for x0,x1 in zip(xs,xs[1:]):
        for y0,y1 in zip(ys,ys[1:]):
            if any(h['u0'] < (x0+x1)/2 < h['u1'] and h['v0'] < (y0+y1)/2 < h['v1'] for h in holes): continue
            origin,u=wall['origin'],wall['u']
            quad([(origin[0]+u[0]*x, origin[1]+y, origin[2]+u[2]*x) for x,y in [(x0,y0),(x1,y0),(x1,y1),(x0,y1)]])
mesh=bpy.data.meshes.new('Measured room collision');mesh.from_pydata(verts,[],faces);mesh.update()
obj=bpy.data.objects.new('Measured room collision',mesh);full.collection.objects.link(obj);obj.select_set(True)
bpy.context.view_layer.objects.active=obj
bpy.context.view_layer.update()
collision_bounds=bounds([obj])
bpy.ops.wm.usd_export(filepath=str(a.out/'collision.usdz'), **usd_options)

# Round-trip both formats through independent importers to catch unit/axis errors.
roundtrips={}
for kind in ['usdz','glb']:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if kind=='usdz': bpy.ops.wm.usd_import(filepath=str(a.out/f'room.{kind}'))
    else: bpy.ops.import_scene.gltf(filepath=str(a.out/f'room.{kind}'))
    b=bounds(bpy.context.scene.objects);roundtrips[kind]=b
    error=max(abs(b[k][i]-original_bounds[k][i]) for k in ['min','max'] for i in range(3))
    if error>0.005: raise ValueError(f'{kind} round-trip bounds changed by {error} metres')
(a.out/'export-evidence.json').write_text(json.dumps({'bounds':original_bounds,'collisionBounds':collision_bounds,'roundtripBounds':roundtrips,
    'objectCount':len(objects),'objects':objects,'editableSource':str(a.blend),'editableDerived':str(a.out/'room.blend'),
    'notes':['Editable source was not overwritten.','Procedural material details may simplify in exported assets.']},indent=2))
print('SPATIAL_EXPORT_OK',a.out,flush=True)
