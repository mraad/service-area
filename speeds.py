"""MTFCC -> speed (mph). Single source for the ArcPy and CUDA engines."""

MPH = {
    "S1100": 65.0,  # primary road (interstate)
    "S1200": 45.0,  # secondary road
    "S1400": 30.0,  # local street
    "S1500": 10.0,  # 4WD trail
    "S1630": 35.0,  # ramp
    "S1640": 25.0,  # service drive
    "S1730": 10.0,  # alley
    "S1740": 10.0,  # private road
    "S1750": 15.0,  # internal census road
    "S1780": 5.0,   # parking lot road
}
EXCLUDED = ("S1710", "S1820")  # walkway, bike path: not drivable
# Grade-separated classes: never split at crossings, only at T-junctions.
ENDPOINT_ONLY = ("S1100", "S1630")
DEFAULT_MPH = 25.0  # unknown MTFCC


def minutes(length_ft, mtfcc):
    return length_ft / 5280.0 / MPH.get(mtfcc, DEFAULT_MPH) * 60.0
