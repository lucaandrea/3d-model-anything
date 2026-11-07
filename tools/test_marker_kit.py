import json
import tempfile
import unittest
from pathlib import Path
import marker_kit


class MarkerKitTests(unittest.TestCase):
    def test_reprint_and_append_preserve_identity_pixels_and_retired_cards(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = {"rooms": [{"id": "r", "name": "Room"}], "lights": [{"id": "a", "name": "Lamp", "room": "r"}]}
            first = marker_kit.generate_kit(plan, root)
            before = {m["id"]: m["imageSHA256"] for m in first["markers"]}
            second = marker_kit.generate_kit(plan, root)
            self.assertEqual(first, second)
            plan["lights"].append({"id": "b", "name": "Another lamp", "room": "r"})
            third = marker_kit.generate_kit(plan, root, extra=1)
            self.assertEqual(first["kitID"], third["kitID"])
            self.assertTrue(all(before[m["id"]] == m["imageSHA256"] for m in third["markers"] if m["id"] in before))
            plan["lights"] = plan["lights"][1:]
            fourth = marker_kit.generate_kit(plan, root)
            self.assertTrue(next(m for m in fourth["markers"] if m.get("deviceID") == "a")["retired"])

    def test_private_fields_not_exported(self):
        row = marker_kit.inventory({"devices": [{"id": "safe", "name": "Lamp", "link": {"id": "hardware-secret"}, "password": "secret"}]})
        self.assertNotIn("secret", json.dumps(row))

    def test_additional_checkpoints_append_without_changing_existing_cards(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = marker_kit.generate_kit({}, root)
            second = marker_kit.generate_kit({}, root, extra_checkpoints=2)
            self.assertEqual(second['kitID'], first['kitID'])
            indexed = {m['id']:m for m in second['markers']}
            self.assertTrue(all(indexed[m['id']]==m for m in first['markers']))
            self.assertEqual(indexed['C008']['physicalWidthMeters'], .14)
            with self.assertRaises(ValueError): marker_kit.generate_kit({},root,extra=-1)

    def test_duplicate_device_ids_reject(self):
        with self.assertRaises(ValueError):
            marker_kit.inventory({"lights": [{"id": "a"}], "devices": [{"id": "a"}]})

    def test_modified_art_rejects_and_missing_replacement_restores_exact_pixels(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = marker_kit.generate_kit({}, root)
            image = root / first["markers"][0]["image"]
            original = image.read_bytes()
            image.unlink()
            self.assertEqual(marker_kit.generate_kit({}, root), first)
            self.assertEqual(image.read_bytes(), original)
            image.write_bytes(b"changed artwork")
            with self.assertRaisesRegex(ValueError, "Artwork changed"):
                marker_kit.generate_kit({}, root)


if __name__ == "__main__":
    unittest.main()
