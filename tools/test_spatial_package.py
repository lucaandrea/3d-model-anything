import argparse
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
import spatial_package as spatial


class SpatialPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def fixture(self, name="office"):
        root = self.root / name
        root.mkdir()
        asset = root / "room.glb"
        asset.write_bytes(b"test geometry payload")
        manifest = {"format": "house-spatial/1", "houseID": "fixture-house", "name": name,
            "createdAt": "2026-01-01T00:00:00Z", "producer": "test", "units": "meters", "upAxis": "Y", "handedness": "right",
            "levels": [{"id": "ground", "name": "Ground", "elevation": 0}],
            "rooms": [{"id": name, "name": name, "levelID": "ground", "polygon": [[0,0],[4,0],[4,3],[0,3]],
                "floorY": 0, "ceilingY": 2.6, "roomToHouse": spatial.IDENTITY[:],
                "source": {"sessionID": name, "roomIndex": 0, "worldToRoom": spatial.IDENTITY[:]},
                "alignment": {"method": "first", "verified": False}}],
            "assets": [{"id": name+"-display", "representation": "glb", "path": "room.glb", "sha256": spatial.sha(asset),
                "byteLength": asset.stat().st_size, "mediaType": "model/gltf-binary", "roomID": name,
                "kind": "display", "bounds": {"min": [0,0,0], "max": [4,2.6,3]}}],
            "checkpoints": [], "provenance": {"sourceFormat": "house-capture/5", "geometryStatus": "measured", "notes": []}}
        self.write(root, manifest)
        return root, manifest

    def write(self, root, manifest):
        manifest.pop("revision", None)
        manifest["revision"] = hashlib.sha256(spatial.canonical(manifest)).hexdigest()
        (root / "manifest.json").write_text(json.dumps(manifest))

    def test_rigid_rejects_scale_reflection_nonfinite_and_boolean(self):
        self.assertTrue(spatial.rigid(spatial.IDENTITY))
        for value in (2, -1, float("nan"), True):
            bad = spatial.IDENTITY[:]; bad[0] = value
            self.assertFalse(spatial.rigid(bad))

    def test_changed_asset_and_manifest_revisions_reject(self):
        root, manifest = self.fixture()
        spatial.validate(root)
        (root / "room.glb").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum"):
            spatial.validate(root)
        manifest["name"] = "different"
        (root / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "revision"):
            spatial.validate(root)

    def test_unknown_floor_zero_polygon_bounds_and_fake_alignment_reject(self):
        root, manifest = self.fixture()
        cases = [lambda m: m["rooms"][0].update(levelID="unmapped"),
                 lambda m: m["rooms"][0].update(polygon=[[0,0],[1,0],[2,0]]),
                 lambda m: m["assets"][0].update(bounds={"min": [4,0,0], "max": [0,3,3]}),
                 lambda m: m["rooms"][0].update(alignment={"method": "card", "verified": True})]
        for mutate in cases:
            bad = copy.deepcopy(manifest); mutate(bad); self.write(root, bad)
            with self.assertRaises(ValueError): spatial.validate(root)

    def test_paths_and_parent_symlinks_reject(self):
        root, _ = self.fixture()
        for path in ("../office/room.glb", "/tmp/asset", "./room.glb", "room\\glb"):
            with self.assertRaises(ValueError): spatial.contained(root, path)
        (root / "linked").symlink_to(root, target_is_directory=True)
        with self.assertRaises(ValueError): spatial.contained(root, "linked/room.glb")

    def test_two_floors_preserve_explicit_transforms_ids_and_hashes(self):
        first, a = self.fixture("office")
        second, b = self.fixture("upstairs")
        transform = spatial.IDENTITY[:]; transform[13] = 3.2
        config = {"houseID": "joined-house", "name": "House", "levels": [
            {"id": "ground", "name": "Ground", "elevation": 0}, {"id": "upper", "name": "Upper", "elevation": 3.2}],
            "rooms": [{"package": "office", "roomID": "office", "roomToHouse": spatial.IDENTITY, "levelID": "ground"},
                      {"package": "upstairs", "roomID": "upstairs", "roomToHouse": transform, "levelID": "upper"}]}
        source = self.root / "join.json"; source.write_text(json.dumps(config))
        joined = spatial.assemble(source, self.root / "joined")
        self.assertEqual(joined["rooms"][1]["roomToHouse"][13], 3.2)
        self.assertEqual(joined["assets"][1]["sha256"], b["assets"][0]["sha256"])
        self.assertFalse(any(room["alignment"]["verified"] for room in joined["rooms"]))
        self.assertEqual(joined["checkpoints"], [])
        config["rooms"][1].pop("roomToHouse")
        source.write_text(json.dumps(config))
        out = self.root / "invalid"
        with self.assertRaises(KeyError): spatial.publish(argparse.Namespace(output=out, assemble=source))
        self.assertFalse(out.exists(), "Failed assembly must not expose a partial package")


if __name__ == "__main__": unittest.main()
