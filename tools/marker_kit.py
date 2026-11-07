#!/usr/bin/env python3
"""Generate private printable cards and matching AR reference images, without hardware secrets."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import textwrap
import uuid
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.units import mm
from reportlab.graphics.barcode import qrencoder


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(plan):
    rooms = {r["id"]: r.get("name", r["id"]) for r in plan.get("rooms", [])}
    rows, seen = [], set()
    for category in ("lights", "acs", "devices"):
        for d in plan.get(category, []):
            ident = d.get("id")
            if not isinstance(ident, str) or not ident or ident in seen:
                raise ValueError("Every mapped device must have a unique nonempty plan ID")
            seen.add(ident)
            row = {"deviceID": ident, "label": d.get("name") or ident}
            if d.get("room"):
                row.update(roomID=d["room"], roomName=rooms.get(d["room"], d["room"]))
            rows.append(row)
    return sorted(rows, key=lambda d: (d.get("roomName", ""), d["label"], d["deviceID"]))


def reference_image(kit_id, marker_id, path):
    """Non-repeating, asymmetric, multiscale monochrome art; no labels in the tracked crop."""
    rng = random.Random(int.from_bytes(hashlib.sha256((kit_id + marker_id).encode()).digest(), "big"))
    n = 840
    im = Image.new("L", (n, n), 255)
    d = ImageDraw.Draw(im)
    # Irregular islands distribute distinctive corners throughout the image, at several scales.
    for row in range(6):
        for col in range(6):
            cx, cy = 70 + col * 140 + rng.randint(-18, 18), 70 + row * 140 + rng.randint(-18, 18)
            radius = rng.randint(35, 66)
            sides = rng.randint(4, 8)
            start = rng.uniform(0, math.tau)
            pts = [(cx + math.cos(start + k * math.tau / sides) * radius * rng.uniform(.6, 1.0),
                    cy + math.sin(start + k * math.tau / sides) * radius * rng.uniform(.6, 1.0)) for k in range(sides)]
            d.polygon(pts, fill=0)
            if rng.random() < .65:
                x, y = cx + rng.randint(-13, 13), cy + rng.randint(-13, 13)
                r = rng.randint(9, 19)
                d.ellipse((x-r, y-r, x+r, y+r), fill=255)
            if rng.random() < .5:
                d.line((cx-radius, cy+radius+8, cx+radius//2, cy+radius+20), fill=0, width=rng.randint(5, 11))
    for _ in range(65):
        x, y, r = rng.randint(12, n-12), rng.randint(12, n-12), rng.randint(4, 13)
        color = 255 if im.getpixel((x, y)) < 128 else 0
        d.rectangle((x-r, y-r, x+r, y+r), fill=color)
    im.save(path, optimize=True)


def qr_matrix(payload):
    qr = qrencoder.QRCode(version=None, errorCorrectLevel=qrencoder.QRErrorCorrectLevel.M)
    qr.addData(payload)
    qr.make()
    return qr.modules


def save_qr(payload, path):
    matrix = qr_matrix(payload)
    quiet, scale = 4, 8
    im = Image.new("L", ((len(matrix)+quiet*2)*scale,)*2, 255)
    d = ImageDraw.Draw(im)
    for r, row in enumerate(matrix):
        for c, black in enumerate(row):
            if black:
                x, y = (c+quiet)*scale, (r+quiet)*scale
                d.rectangle((x, y, x+scale-1, y+scale-1), fill=0)
    im.save(path)


def generate_kit(plan, root, extra=0, extra_checkpoints=0):
    if any(type(n) is not int or n<0 for n in [extra,extra_checkpoints]):
        raise ValueError('Additional card counts must be nonnegative integers')
    root.mkdir(parents=True, exist_ok=True)
    registry_path = root / "registry.json"
    registry = json.loads(registry_path.read_text()) if registry_path.exists() else {
        "kitID": str(uuid.uuid4()), "createdAt": datetime.now(timezone.utc).isoformat(), "markers": []}
    rows = registry["markers"]
    previous_path = root / "manifest.json"
    previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
    locked_hashes = registry.setdefault("imageHashes", {
        m["id"]: m["imageSHA256"] for m in previous.get("markers", [])
    })
    if not rows:
        rows.extend({"id": f"C{i:03}", "role": "checkpoint", "label": f"Room checkpoint {i}"} for i in range(1, 7))
    next_checkpoint = max(int(r['id'][1:]) for r in rows if r['role']=='checkpoint') + 1
    rows.extend({"id":f"C{i:03}","role":"checkpoint","label":f"Room checkpoint {i}"}
                for i in range(next_checkpoint,next_checkpoint+extra_checkpoints))
    current = {d["deviceID"]: d for d in inventory(plan)}
    for row in rows:
        if row.get("deviceID"):
            if row["deviceID"] in current:
                row.update(current.pop(row["deviceID"]))
                row.pop("retired", None)
            else:
                row["retired"] = True
    next_id = max([int(r["id"][1:]) for r in rows if r["id"].startswith("D")] or [0]) + 1
    for item in current.values():
        rows.append({"id": f"D{next_id:03}", "role": "device", **item})
        next_id += 1
    spares = max(0, 4 - sum(r["role"] == "spare" for r in rows)) + extra
    for _ in range(spares):
        rows.append({"id": f"D{next_id:03}", "role": "spare", "label": "Unassigned device"})
        next_id += 1
    if len(rows)>500:raise ValueError('A kit supports at most 500 registered cards')
    (root / "reference-images").mkdir(exist_ok=True)
    (root / "qr").mkdir(exist_ok=True)
    markers = []
    for row in rows:
        ident = row["id"]
        path = root / "reference-images" / f"{ident}.png"
        if not path.exists():
            reference_image(registry["kitID"], ident, path)
        image_hash = digest(path)
        if ident in locked_hashes and locked_hashes[ident] != image_hash:
            raise ValueError(f"Artwork changed for {ident}; restore the original image or issue a new marker ID")
        locked_hashes[ident] = image_hash
        size = .14 if row["role"] == "checkpoint" else .07
        url = f"housecontrol://marker?v=1&kit={registry['kitID']}&id={ident}"
        save_qr(url, root / "qr" / f"{ident}.png")
        markers.append({**row, "image": f"reference-images/{ident}.png", "imageSHA256": image_hash,
                        "physicalWidthMeters": size, "physicalHeightMeters": size, "url": url})
    kit = {"format": "marker-kit/1", "kitID": registry["kitID"], "createdAt": registry["createdAt"],
           "revision": hashlib.sha256(canonical(markers)).hexdigest(), "markers": markers}
    registry_path.write_text(json.dumps(registry, indent=2) + "\n")
    (root / "manifest.json").write_text(json.dumps(kit, indent=2) + "\n")
    return kit


def text(c, x, y, value, size=10, bold=False):
    c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
    # PDF base fonts support western European names; typographic dashes normalize for print.
    value = str(value).replace("\u2011", "-").replace("\u2013", "-").replace("\u2014", "-")
    c.drawString(x, y, value)


def lines(c, x, y, value, width=85, size=10, leading=15):
    for line in textwrap.wrap(value, width):
        text(c, x, y, line, size)
        y -= leading
    return y


def footer(c, width, page, kit):
    c.setFillColorRGB(.35, .35, .35)
    text(c, 13*mm, 7*mm, f"LOFT / {kit['kitID'][:8]} / PRINT AT 100%", 7)
    c.drawRightString(width-13*mm, 7*mm, f"PAGE {page}")
    c.setFillColorRGB(0, 0, 0)


def trim(c, x, y, w, h):
    c.saveState()
    c.setStrokeColorRGB(.6, .6, .6)
    c.setLineWidth(.35)
    c.setDash(2, 3)
    c.rect(x, y, w, h)
    c.restoreState()


def draw_qr(c, payload, x, y, size):
    matrix = qr_matrix(payload)
    module = size / (len(matrix)+8)
    c.setFillColorRGB(1, 1, 1)
    c.rect(x, y, size, size, fill=1, stroke=0)
    c.setFillColorRGB(0, 0, 0)
    for r, row in enumerate(matrix):
        for col, black in enumerate(row):
            if black:
                c.rect(x+(col+4)*module, y+(len(matrix)+3-r)*module, module, module, fill=1, stroke=0)


def fit_label(c, x, y, value, width, size=9, max_lines=2):
    words, result, line = value.split(), [], ""
    for word in words:
        candidate = (line + " " + word).strip()
        if c.stringWidth(candidate, "Helvetica-Bold", size) > width and line:
            result.append(line); line = word
        else:
            line = candidate
    result.append(line)
    for i, row in enumerate(result[:max_lines]):
        if i == max_lines-1 and len(result) > max_lines:
            row = row[:max(1, len(row)-3)] + "..."
        text(c, x, y-i*(size+2), row, size, True)


def device_card(c, root, marker, x, y):
    w, h = 90*mm, 120*mm
    trim(c, x, y, w, h)
    fit_label(c, x+5*mm, y+h-6*mm, f"{marker['id']}  {marker['label']}", 80*mm)
    # The image rectangle is exactly 70mm, independent of the QR and card trim.
    c.drawImage(str(root/marker["image"]), x+10*mm, y+30*mm, 70*mm, 70*mm)
    draw_qr(c, marker["url"], x+5*mm, y+3*mm, 25*mm)
    text(c, x+34*mm, y+23*mm, "UP ^  /  DEVICE", 8, True)
    fit_label(c, x+34*mm, y+18*mm, marker.get("roomName", "Assign during setup"), 51*mm, 7, 2)
    text(c, x+34*mm, y+8*mm, "Image: 70 x 70 mm", 7)
    text(c, x+34*mm, y+4*mm, "Never a room origin by default", 6)


def make_pdf(kit, root, destination, page_size, subset=None):
    markers = [m for m in kit["markers"] if not m.get("retired") and (subset is None or m["id"] in subset)]
    checkpoints = [m for m in markers if m["role"] == "checkpoint"]
    devices = [m for m in markers if m["role"] != "checkpoint"]
    index_pages = math.ceil(len(markers)/34)
    first_card = 2 + index_pages
    pages = {m["id"]: first_card+i for i, m in enumerate(checkpoints)}
    for i, m in enumerate(devices):
        pages[m["id"]] = first_card + len(checkpoints) + i//4
    width, height = page_size
    c = canvas.Canvas(str(destination), pagesize=page_size, pageCompression=1, invariant=1)
    c.setTitle("Loft Scan Cards - " + ("A4" if page_size == A4 else "US Letter"))
    c.setAuthor("3D Model Anything / House Control")
    page = 1
    text(c, 18*mm, height-24*mm, "LOFT / SCAN CARDS", 23, True)
    text(c, 18*mm, height-34*mm, "Print. Cut. Place. Verify.", 14)
    y = height-51*mm
    instructions = [
        ("01  PRINT AT ACTUAL SIZE", "Choose 100% / Actual Size, single-sided. Turn off Fit to Page. Use matte white paper or cardstock. Check the ruler below before cutting."),
        ("02  START WITH A PILOT", "Print C001 and two device cards using the index. The cards work with this kit's matching app reference images; printing alone does not calibrate your house."),
        ("03  KEEP ROOM CHECKPOINTS FIXED", "Mount large C cards flat on a doorframe or wall, record the mounting position, and verify alignment against independent room features. Never use a movable lamp as a room origin."),
        ("04  PLACE DEVICE CARDS NEAR FIXTURES", "Place each D card beside its named device. In setup, confirm the correct device and its offset from the card. QR codes identify cards; they never switch anything on."),
        ("05  REPRINT WITHOUT MOVING THE ORIGIN", "Keep the same kit and card IDs. Moving or replacing a card requires position verification. Remove temporary cards for clean detail photos when they obscure surfaces."),
    ]
    for heading, body in instructions:
        text(c, 18*mm, y, heading, 10, True)
        y = lines(c, 18*mm, y-16, body, width=87, size=9, leading=12)-17
    ruler_y = max(27*mm, y-8*mm)
    text(c, 18*mm, ruler_y+12*mm, "SCALE CHECK: this line must measure exactly 100 mm", 9, True)
    c.setLineWidth(.7)
    c.line(18*mm, ruler_y, 118*mm, ruler_y)
    for i in range(11):
        x = (18+i*10)*mm
        c.line(x, ruler_y-2*mm, x, ruler_y+(4 if i%5 == 0 else 2)*mm)
    text(c, 18*mm, ruler_y-6*mm, "0", 7)
    text(c, 108*mm, ruler_y-6*mm, "100 mm", 7)
    footer(c, width, page, kit); c.showPage(); page += 1
    for start in range(0, len(markers), 34):
        text(c, 15*mm, height-22*mm, "CARD INDEX", 20, True)
        text(c, 15*mm, height-31*mm, "Print selected PDF pages; keep unused cards for later setup.", 9)
        y = height-44*mm
        for marker in markers[start:start+34]:
            text(c, 15*mm, y, marker["id"], 9, True)
            label = marker["label"] + (" / " + marker["roomName"] if marker.get("roomName") else "")
            while c.stringWidth(label, "Helvetica", 8) > width-72*mm:
                label = label[:-4] + "..."
            text(c, 34*mm, y, label, 8)
            text(c, width-31*mm, y, f"p. {pages[marker['id']]}", 8)
            c.setStrokeColorRGB(.84, .84, .84); c.setLineWidth(.25)
            c.line(15*mm, y-6, width-15*mm, y-6)
            y -= 6*mm
        footer(c, width, page, kit); c.showPage(); page += 1
    for marker in checkpoints:
        text(c, 16*mm, height-20*mm, "FIXED ROOM CHECKPOINT", 15, True)
        text(c, 16*mm, height-29*mm, "Mount flat on a fixed feature. Verify before using for alignment.", 9)
        x, y = (width-170*mm)/2, (height-204*mm)/2-5*mm
        trim(c, x, y, 170*mm, 204*mm)
        text(c, x+15*mm, y+193*mm, marker["id"] + " / UP ^", 16, True)
        c.drawImage(str(root/marker["image"]), x+15*mm, y+44*mm, 140*mm, 140*mm)
        draw_qr(c, marker["url"], x+15*mm, y+9*mm, 29*mm)
        text(c, x+50*mm, y+32*mm, "TRACKING IMAGE: 140 x 140 mm", 9, True)
        text(c, x+50*mm, y+24*mm, "Room / mounting position:", 9)
        c.line(x+50*mm, y+15*mm, x+155*mm, y+15*mm)
        text(c, x+50*mm, y+8*mm, "Moving this card requires re-verification.", 8)
        footer(c, width, page, kit); c.showPage(); page += 1
    for start in range(0, len(devices), 4):
        x0, y0 = (width-186*mm)/2, (height-246*mm)/2
        for j, marker in enumerate(devices[start:start+4]):
            device_card(c, root, marker, x0+(j%2)*96*mm, y0+(1-j//2)*126*mm)
        footer(c, width, page, kit); c.showPage(); page += 1
    c.save()
    return {"file": destination.name, "pages": page-1, "cardPages": pages}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--plan", type=Path, required=True)
    p.add_argument("--kit", type=Path, default=Path("output/marker-kit"))
    p.add_argument("--pdf", type=Path, default=Path("output/pdf"))
    p.add_argument("--add-spares", type=int, default=0)
    p.add_argument("--add-checkpoints", type=int, default=0)
    p.add_argument("--only", help="Comma-separated card IDs for a replacement/pilot PDF; never renumbers")
    args = p.parse_args()
    if args.add_spares < 0 or args.add_checkpoints < 0:
        p.error("Additional card counts cannot be negative")
    kit = generate_kit(json.loads(args.plan.read_text()), args.kit, args.add_spares, args.add_checkpoints)
    args.pdf.mkdir(parents=True, exist_ok=True)
    subset = set(args.only.split(",")) if args.only else None
    if subset and not subset.issubset({m["id"] for m in kit["markers"]}):
        p.error("--only contains unknown card IDs")
    suffix = "-Selected" if subset else ""
    outputs = [make_pdf(kit, args.kit, args.pdf/f"Loft-Scan-Cards-{name}{suffix}.pdf", size, subset)
               for name, size in (("Letter", letter), ("A4", A4))]
    (args.kit/"print-index.json").write_text(json.dumps(outputs, indent=2)+"\n")
    print(json.dumps({"kitID": kit["kitID"], "cards": len(kit["markers"]), "outputs": outputs}, indent=2))


if __name__ == "__main__":
    main()
