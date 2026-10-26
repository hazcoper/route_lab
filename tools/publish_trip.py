#!/usr/bin/env python3
"""Convert ESP32 GPSLOG01/GPSLOG02 .bin into GitHub Pages dashboard assets.
Example: python3 tools/publish_trip.py big_trip.bin
"""
import argparse
import json
from pathlib import Path
#!/usr/bin/env python3
"""Local GPSLOG01 trip dashboard. Run: python app.py"""

import csv
import io
import math
import os
import statistics
import struct
import uuid
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from xml.etree import ElementTree as ET


MAGIC = b"GPSLOG01"
MAGIC_V2 = b"GPSLOG02"  # Extended 20-byte records with signed altitude in centimetres
RECORD = struct.Struct("<IiiHBB")
RECORD_V2 = struct.Struct("<IiiHBBi")
FIX = {0: "No fix", 1: "GPS", 2: "DGPS", 4: "RTK fixed", 5: "RTK float", 6: "Estimated"}
MAX_UPLOAD = 16 * 1024 * 1024
CACHE_LIMIT = 6


def haversine(a: dict, b: dict) -> float:
    """Great-circle distance in kilometres."""
    r1, r2 = math.radians(a["lat"]), math.radians(b["lat"])
    dr = r2 - r1
    dl = math.radians(b["lon"] - a["lon"])
    h = math.sin(dr / 2) ** 2 + math.cos(r1) * math.cos(r2) * math.sin(dl / 2) ** 2
    return 6371.0088 * 2 * math.asin(min(1, math.sqrt(h)))


def decode(blob: bytes) -> dict:
    if blob.startswith(MAGIC_V2):
        record = RECORD_V2
    elif blob.startswith(MAGIC):
        record = RECORD
    else:
        raise ValueError("Expected GPSLOG01 or GPSLOG02 binary header.")
    payload = blob[8:]
    if not payload:
        raise ValueError("The file contains no GPS records.")
    trailing = len(payload) % record.size
    count = len(payload) // record.size
    if not count:
        raise ValueError("The file contains no complete GPS records.")
    points = []
    dropped = 0
    for idx in range(count):
        values = record.unpack_from(payload, idx * record.size)
        ts, raw_lat, raw_lon, speed, sats, quality = values[:6]
        altitude = values[6] / 100.0 if record is RECORD_V2 and values[6] != -2147483648 else None
        lat, lon = raw_lat / 1e7, raw_lon / 1e7
        if not (-90 <= lat <= 90 and -180 <= lon <= 180 and 946684800 <= ts <= 4102444800):
            dropped += 1
            continue
        points.append({
            "ts": ts, "time": datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z"),
            "lat": lat, "lon": lon, "speed": speed / 100.0,
            "sat": sats, "fix": quality, "fixName": FIX.get(quality, f"Other ({quality})"),
            "altitude": altitude,
        })
    if not points:
        raise ValueError("No valid timestamps and coordinates were found.")
    points.sort(key=lambda p: p["ts"])
    dt_values = [b["ts"] - a["ts"] for a, b in zip(points, points[1:]) if b["ts"] > a["ts"]]
    expected = statistics.median(dt_values) if dt_values else 60
    gap_threshold = max(180, 3 * expected)
    # Large temporal gaps or physically implausible straight-line speeds break the route.
    segments = [[0]]
    distance = 0.0
    all_pairs_distance = 0.0
    cumulative_connected = 0.0
    elapsed_valid = 0.0
    moving_s = 0.0
    stopped_s = 0.0
    gaps = []
    for i in range(1, len(points)):
        a, b = points[i - 1], points[i]
        seconds = b["ts"] - a["ts"]
        km = haversine(a, b)
        all_pairs_distance += km
        inferred_speed = km * 3600 / seconds if seconds > 0 else float("inf")
        is_gap = seconds <= 0 or seconds > gap_threshold or inferred_speed > 250
        if is_gap:
            if seconds > gap_threshold:
                gaps.append({"from": a["time"], "to": b["time"], "seconds": seconds})
            segments.append([i])
        else:
            segments[-1].append(i)
            distance += km
            elapsed_valid += seconds
            if (a["speed"] + b["speed"]) / 2 >= 3:
                moving_s += seconds
            else:
                stopped_s += seconds
    segments = [s for s in segments if s]
    # Per-point cumulative sums include all pairs and only accepted/connected pairs.
    points[0]["allPairsDistanceKm"] = 0.0
    points[0]["connectedDistanceKm"] = 0.0
    connected = {seg[j] for seg in segments for j in range(1, len(seg))}
    all_running = connected_running = 0.0
    for i in range(1, len(points)):
        step = haversine(points[i - 1], points[i])
        all_running += step
        if i in connected:
            connected_running += step
        points[i]["allPairsDistanceKm"] = round(all_running, 6)
        points[i]["connectedDistanceKm"] = round(connected_running, 6)
    durations = points[-1]["ts"] - points[0]["ts"]
    speeds = [p["speed"] for p in points]
    moving_speeds = [v for v in speeds if v >= 3]
    stat = {
        "points": len(points), "invalidPoints": dropped, "trailingBytes": trailing,
        "start": points[0]["time"], "end": points[-1]["time"],
        "durationSeconds": durations,
        "distanceKm": round(distance, 3),
        "allPairsDistanceKm": round(all_pairs_distance, 3),
        "altitudeAvailable": any(p["altitude"] is not None for p in points),
        "averageSpeedKmh": round(statistics.mean(speeds), 2),
        "movingSpeedKmh": round(statistics.mean(moving_speeds), 2) if moving_speeds else 0,
        "maxSpeedKmh": max(speeds), "medianSpeedKmh": round(statistics.median(speeds), 2),
        "overallLowerBoundKmh": round(distance / (durations / 3600), 2) if durations else 0,
        "connectedAverageKmh": round(distance / (elapsed_valid / 3600), 2) if elapsed_valid else 0,
        "movingSecondsEstimate": moving_s, "stoppedSecondsEstimate": stopped_s,
        "gaps": len(gaps), "gapSeconds": sum(g["seconds"] for g in gaps),
        "gapThresholdSeconds": round(gap_threshold), "expectedIntervalSeconds": round(expected, 1),
        "satMean": round(statistics.mean(p["sat"] for p in points), 1),
        "fixCounts": dict(Counter(p["fixName"] for p in points)),
        "bounds": [[min(p["lat"] for p in points), min(p["lon"] for p in points)],
                   [max(p["lat"] for p in points), max(p["lon"] for p in points)]],
    }
    return {"points": points, "segments": segments, "stats": stat, "gaps": gaps}


def export_csv(points: list) -> bytes:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(("timestamp_utc", "latitude", "longitude", "speed_kmh", "satellites", "fix_quality", "fix_type", "altitude_m"))
    for p in points:
        writer.writerow((p["time"], p["lat"], p["lon"], p["speed"], p["sat"], p["fix"], p["fixName"], p["altitude"]))
    return output.getvalue().encode("utf-8")


def export_gpx(data: dict) -> bytes:
    ns = "http://www.topografix.com/GPX/1/1"
    ET.register_namespace("", ns)
    root = ET.Element(f"{{{ns}}}gpx", version="1.1", creator="ESP32 GPS Trip Dashboard")
    track = ET.SubElement(root, f"{{{ns}}}trk")
    ET.SubElement(track, f"{{{ns}}}name").text = "GPS trip"
    for indices in data["segments"]:
        segment = ET.SubElement(track, f"{{{ns}}}trkseg")
        for i in indices:
            p = data["points"][i]
            node = ET.SubElement(segment, f"{{{ns}}}trkpt", lat=str(p["lat"]), lon=str(p["lon"]))
            ET.SubElement(node, f"{{{ns}}}time").text = p["time"]
            if p["altitude"] is not None:
                ET.SubElement(node, f"{{{ns}}}ele").text = str(p["altitude"])
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def export_kml(data: dict) -> bytes:
    ns = "http://www.opengis.net/kml/2.2"
    ET.register_namespace("", ns)
    k = lambda name: f"{{{ns}}}{name}"
    root = ET.Element(k("kml"))
    doc = ET.SubElement(root, k("Document"))
    ET.SubElement(doc, k("name")).text = "GPS Trip"
    style = ET.SubElement(doc, k("Style"), id="route")
    line_style = ET.SubElement(style, k("LineStyle"))
    ET.SubElement(line_style, k("color")).text = "ff4fc3f7"
    ET.SubElement(line_style, k("width")).text = "4"
    for index, indices in enumerate(data["segments"]):
        placemark = ET.SubElement(doc, k("Placemark"))
        ET.SubElement(placemark, k("name")).text = f"Route section {index+1}"
        ET.SubElement(placemark, k("styleUrl")).text = "#route"
        line = ET.SubElement(placemark, k("LineString"))
        ET.SubElement(line, k("tessellate")).text = "1"
        ET.SubElement(line, k("coordinates")).text = " ".join(
            f'{data["points"][i]["lon"]},{data["points"][i]["lat"]},0' for i in indices)
    for name, p in (("Start", data["points"][0]), ("End", data["points"][-1])):
        pm = ET.SubElement(doc, k("Placemark"))
        ET.SubElement(pm, k("name")).text = name
        ET.SubElement(pm, k("description")).text = p["time"]
        pt = ET.SubElement(pm, k("Point"))
        ET.SubElement(pt, k("coordinates")).text = f'{p["lon"]},{p["lat"]},0'
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)




def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('binary', type=Path)
    ap.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'data')
    args=ap.parse_args()
    blob=args.binary.read_bytes()
    if len(blob) > 16 * 1024 * 1024:
        ap.error('Maximum input size is 16 MB')
    try:
        trip=decode(blob)
    except (ValueError, OverflowError, struct.error) as e:
        ap.error(str(e))
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output/'trip.json').write_text(json.dumps(trip, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    (args.output/'trip.csv').write_bytes(export_csv(trip['points']))
    (args.output/'trip.gpx').write_bytes(export_gpx(trip))
    (args.output/'trip.kml').write_bytes(export_kml(trip))
    print(f"Saved {len(trip['points'])} GPS positions to {args.output}")
    print(f"Distance (connected segments): {trip['stats']['distanceKm']} km")


if __name__ == '__main__':
    main()
