"""Free-wording test set: the 100 gold prompts' situations, said the way a person would say them instead of the way
the game prints them. Text is written as the fine-tuned speech models write it (lower-case spoken words).
Styles: plain (own words), terse (clipped / reordered), other (another phraseology standard, grouped numbers),
multi (several commands in one transmission), chat (not a command: must not be sent).
    python3 ml/s1/freeword/build.py  ->  ml/s1/freeword/rows.json"""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
P = {p["id"]: p for p in json.loads((ROOT / "public/voice/gold-prompts.json").read_text())["prompts"]}

SAID = {
 "v04": [("plain", "speedbird three two seven go up to flight level eight zero"), ("other", "speedbird three twenty seven climb and maintain flight level eight zero")],
 "v01": [("plain", "hong kong express five two eight you can push back expect runway two five left"), ("terse", "hong kong express five two eight push approved expect two five left")],
 "s01": [("plain", "velocity four nine nine go to tower on one one eight decimal five"), ("other", "velocity four ninety nine contact tower one one eight point five good day")],
 "v06": [("plain", "cathay two two two you're good to start expect runway two five left qnh one zero two four"), ("terse", "cathay two two two start approved expect two five left")],
 "v03": [("plain", "jetblue four twenty two copy that"), ("other", "jetblue four two two roger thanks")],
 "v02": [("plain", "emirates four six nine speed up to one nine zero knots"), ("terse", "emirates four six nine one nine zero knots")],
 "s02": [("plain", "cathay nine three six come down to seven thousand"), ("other", "cathay nine three six descend and maintain seven thousand feet")],
 "f01": [("plain", "air india five zero four you're cleared for the ils two nine left call me established"), ("other", "air india five zero four cleared ils runway two nine left approach report established on the localizer")],
 "s03": [("plain", "velocity four zero zero can't do that right now traffic stand by"), ("terse", "velocity four zero zero negative unable due traffic")],
 "v05": [("plain", "hong kong express five two eight hang on a moment stand by"), ("terse", "hong kong express five two eight stand by one")],
 "v11": [("plain", "lufthansa nine seven eight abort the landing go around"), ("terse", "lufthansa nine seven eight go around go around")],
 "v09": [("plain", "easy five three two you can expect the ils for runway two seven left"), ("terse", "easy five three two expect ils two seven left")],
 "f02": [("plain", "easy five three two switch to tower one one eight five"), ("other", "easy five three two contact the tower now one one eight decimal five")],
 "s05": [("plain", "velocity five eight zero you're cleared for takeoff runway two five wind two one five at one two"), ("terse", "velocity five eight zero runway two five cleared takeoff")],
 "v08": [("plain", "speedbird nine three two okay understood"), ("terse", "speedbird nine three two copied")],
 "s04": [("plain", "virgin five zero taxi out to runway one six right via kilo and lima and hold short of runway zero seven"), ("other", "virgin five zero runway one six right taxi via kilo lima hold short runway zero seven")],
 "v12": [("plain", "jetblue five zero plan on the ils runway two seven information bravo is current"), ("terse", "jetblue five zero expect ils two seven")],
 "v07": [("plain", "easy five zero four over to tower one one eight decimal five bye"), ("terse", "easy five zero four tower one one eight five")],
 "v10": [("plain", "scooter four nine eight turn to heading one six one"), ("terse", "scooter four nine eight heading one six one")],
 "s06": [("plain", "jetstar six one four make your heading three five one"), ("terse", "jetstar six one four heading three five one")],
 "v16": [("plain", "hong kong express five two seven wind is three zero one degrees at one zero knots"), ("terse", "hong kong express five two seven wind three zero one at ten")],
 "f03": [("plain", "ifly nine seven eight steer heading two four zero"), ("other", "ifly nine seventy eight fly heading two four zero")],
 "v14": [("plain", "new zealand seven three seven come onto heading three zero one"), ("terse", "new zealand seven three seven heading three zero one")],
 "v17": [("plain", "hong kong express five two seven you can cross runway two five right tell me when you're clear"), ("terse", "hong kong express five two seven cross two five right")],
 "s09": [("plain", "virgin four eight give me a second stand by"), ("terse", "virgin four eight stand by")],
 "v13": [("plain", "jetblue five zero stop before runway two seven hold short"), ("terse", "jetblue five zero hold short two seven")],
 "v15": [("plain", "new zealand seven three seven cleared for the ils approach two zero left report when established"), ("terse", "new zealand seven three seven cleared ils two zero left report established")],
 "v18": [("plain", "sierra kilo whiskey eight five three enter the hold at boswe right hand turns one minute legs"), ("terse", "sierra kilo whiskey eight five three hold boswe right turns one minute legs")],
 "s07": [("plain", "southwest eight six five turn heading three five five"), ("other", "southwest eight sixty five fly heading three five five")],
 "s08": [("plain", "qantas two three five descend faster please expedite"), ("terse", "qantas two three five expedite your descent")],
 "f04": [("plain", "klm seven four four runway two seven right you're clear to go cleared for takeoff"), ("other", "klm seven four four wind two four eight at one four runway two seven right cleared for takeoff")],
 "v20": [("plain", "virgin seven seven one turn onto heading three one three"), ("terse", "virgin seven seven one heading three one three")],
 "s12": [("plain", "qantas two seven zero i have you on radar expect the ils runway three four right"), ("terse", "qantas two seven zero radar contact expect three four right")],
 "v19": [("plain", "japan air six four nine cleared for takeoff three zero left"), ("other", "japan air six four nine runway three zero left cleared for takeoff wind three three nine at ten")],
 "v24": [("plain", "hong kong express five two eight taxi to runway two eight and hold short of runway one zero"), ("terse", "hong kong express five two eight taxi holding point two eight hold short one zero")],
 "s10": [("plain", "qatari three one nine taxi to runway two five using alpha alpha one alpha two hold short of one six left"), ("other", "qatari three one nine runway two five taxi via alpha alpha one alpha two hold short runway one six left")],
 "v23": [("plain", "scooter four nine eight radar contact you can expect runway three zero right"), ("terse", "scooter four nine eight identified expect ils three zero right")],
 "v22": [("plain", "japan air nine one six turn to heading zero six five"), ("terse", "japan air nine one six heading zero six five")],
 "v21": [("plain", "southwest five zero four fly a heading of zero six six"), ("other", "southwest five oh four fly heading zero six six")],
 "s11": [("plain", "qantas two eight seven slow down to one six zero knots"), ("terse", "qantas two eight seven speed one six zero")],
 "v28": [("plain", "speedbird nine three two you can keep taxiing"), ("terse", "speedbird nine three two continue")],
 "v26": [("plain", "easy eight one call tower on one one eight decimal five"), ("terse", "easy eight one contact tower")],
 "s15": [("plain", "qantas nine five the wind is two two zero at one zero knots"), ("terse", "qantas nine five wind two two zero degrees ten knots")],
 "s14": [("plain", "qantas one seven seven push and start approved expect runway one six right"), ("other", "qantas one seven seven you're cleared to push and start expect one six right")],
 "s13": [("plain", "qantas five zero turn heading two six four"), ("terse", "qantas five zero heading two six four")],
 "v25": [("plain", "united three three five descend down to one thousand feet"), ("other", "united three thirty five descend and maintain one thousand")],
 "f05": [("plain", "scooter four nine eight bring the speed back to one six zero"), ("terse", "scooter four nine eight reduce one six zero knots")],
 "v30": [("plain", "delta eight nine nine fly heading three four four please"), ("other", "delta eight ninety nine heading three four four")],
 "v27": [("plain", "virgin four two stop where you are hold position"), ("terse", "virgin four two hold your position")],
 "v35": [("plain", "scooter four nine eight go direct to sfono"), ("terse", "scooter four nine eight direct sfono")],
 "v36": [("plain", "delta six three nine climb up to one three thousand"), ("other", "delta six thirty nine climb and maintain thirteen thousand")],
 "s18": [("plain", "air china five eight zero turn to heading two one zero"), ("terse", "air china five eight zero heading two one zero")],
 "s17": [("plain", "cathay nine one five expect an ils approach for runway zero seven"), ("terse", "cathay nine one five expect ils zero seven information bravo")],
 "s16": [("plain", "jetstar seven one eight go ahead and cross runway one six right"), ("terse", "jetstar seven one eight cross one six right report vacated")],
 "v31": [("plain", "scooter four nine eight you're cleared to land runway two five right"), ("terse", "scooter four nine eight two five right cleared to land")],
 "v34": [("plain", "hong kong express five zero four radar contact expect the ils two five right qnh one zero two four"), ("terse", "hong kong express five zero four radar identified expect runway two five right")],
 "v32": [("plain", "virgin five two unable at the moment due to traffic"), ("terse", "virgin five two negative traffic")],
 "f06": [("plain", "air india five zero four taxi to stand romeo one five via foxtrot two foxtrot three and foxtrot four"), ("terse", "air india five zero four stand romeo fifteen via foxtrot two foxtrot three foxtrot four")],
 "v33": [("plain", "united eight eight eight stop stop cancel takeoff"), ("terse", "united eight eight eight abort takeoff stop immediately")],
 "v42": [("plain", "scooter four nine eight pick up the speed to one nine zero"), ("terse", "scooter four nine eight speed one nine zero knots")],
 "v39": [("plain", "air china nine seven eight expedite descent please"), ("terse", "air china nine seven eight expedite down")],
 "f07": [("plain", "japan air five two seven hold short of zero four"), ("terse", "japan air five two seven hold short runway zero four")],
 "v40": [("plain", "hong kong express five two eight hold position there's traffic crossing"), ("terse", "hong kong express five two eight hold position traffic")],
 "s21": [("terse", "velocity four one six cleared ils zero seven report established"), ("other", "velocity four sixteen cleared for the ils runway zero seven approach report established")],
 "v38": [("plain", "lufthansa one five five turn to a heading of one zero seven"), ("terse", "lufthansa one five five heading one zero seven")],
 "v37": [("plain", "scooter four two eight taxi to holding point runway two one via echo echo two hold short zero two right"), ("other", "scooter four two eight runway two one via echo echo two hold short of runway zero two right")],
 "s19": [("plain", "qantas one eight three stop immediately i say again stop immediately"), ("terse", "qantas one eight three cancel takeoff clearance")],
 "v41": [("plain", "ups nine nine eight contact control on one two seven decimal one"), ("terse", "ups nine nine eight control one two seven one good day")],
 "f08": [("terse", "scooter five zero four cleared to land two zero left"), ("other", "scooter five zero four runway two zero left cleared to land wind one six six at one three")],
 "v43": [("plain", "sierra kilo whiskey nine seven eight expedite your descent"), ("terse", "sierra kilo whiskey nine seven eight expedite descent")],
 "v48": [("plain", "speedbird five zero route direct to big"), ("terse", "speedbird five zero direct big"), ("other", "speedbird five zero proceed direct bravo india golf")],
 "v45": [("terse", "air india five zero four hold at idpno right turns one minute legs")],
 "s23": [("plain", "qantas two nine three hold short of runway two five please"), ("terse", "qantas two nine three short of two five hold")],
 "v46": [("plain", "hong kong express five zero four take charlie five to vacate"), ("terse", "hong kong express five zero four vacate charlie five")],
 "v47": [("plain", "united eight two four climb to one three thousand feet"), ("other", "united eight twenty four climb and maintain one three thousand")],
 "v44": [("plain", "ryanair one one eight hold position traffic ahead")],
 "s22": [("plain", "velocity four six six hold your position"), ("terse", "velocity four six six stop hold position")],
 "s24": [("terse", "cathay nine one four climb one six thousand"), ("other", "cathay nine fourteen climb and maintain one six thousand")],
 "f09": [("plain", "speedbird three two seven go direct buzad"), ("terse", "speedbird three two seven direct buzad")],
 "v51": [("plain", "klm seven two two turn heading zero eight five"), ("terse", "klm seven two two heading zero eight five")],
 "s27": [("other", "singapore eight four one proceed direct sierra sierra yankee whiskey echo")],
 "v50": [("plain", "singapore two two two cleared for takeoff runway two one"), ("other", "singapore two two two runway two one cleared for takeoff wind one six three at one three")],
 "s25": [("other", "qantas three zero eight hold at sierra sierra yankee november oscar right turns one minute legs")],
 "s26": [("plain", "velocity seven zero seven fly heading zero eight six"), ("terse", "velocity seven zero seven heading zero eight six")],
 "v49": [("plain", "jetblue two two two taxi to stand charlie six hold short of runway two two left")],
 "v54": [("plain", "jetblue two zero turn to heading zero nine zero"), ("other", "jetblue twenty heading zero nine zero")],
 "v52": [("plain", "cathay eight nine eight stand by i'll call you back")],
 "v53": [("terse", "qatari three three two cleared ils approach two nine left report established")],
 "v55": [("plain", "cathay six four two cross runway zero two center"), ("terse", "cathay six four two cross zero two center report vacated")],
 "s28": [("plain", "cathay nine one five roger that")],
 "s30": [("plain", "qantas six five eight reduce to one six zero knots"), ("terse", "qantas six five eight slow to one six zero")],
 "v60": [("terse", "scooter four nine eight unable due traffic")],
 "v58": [("plain", "sky dubai five six six push and start approved expect runway three zero left")],
 "v57": [("plain", "japan air six four nine taxi to runway three one left hold short of two two right")],
 "s29": [("terse", "jetstar six one three cleared to land one six left")],
 "v56": [("plain", "alaska nine zero one slow down to one six zero"), ("other", "alaska nine oh one reduce speed one six zero knots")],
 "f10": [("plain", "american three eight seven descend to niner thousand"), ("other", "american three eighty seven descend and maintain nine thousand")],
}
# several commands in one transmission: (situation of prompt, said, gold line)
MULTI = [
 ("v04", "speedbird three two seven fly heading two seven zero climb flight level eight zero", "BAW327 Fly heading 270 Altitude 8000"),
 ("s02", "cathay nine three six descend to seven thousand and reduce speed two one zero knots", "CPA936 Altitude 7000 Speed 210"),
 ("v10", "scooter four nine eight heading one six one descend five thousand speed one eight zero", "SCO498 Fly heading 161 Altitude 5000 Speed 180"),
 ("s11", "qantas two eight seven reduce speed to one six zero then descend to three thousand", "QFA287 Speed 160 Altitude 3000"),
 ("v36", "delta six three nine climb one three thousand fly heading zero nine zero", "DAL639 Altitude 13000 Fly heading 090"),
 ("v22", "japan air nine one six turn heading zero six five and slow to one eight zero knots", "JAL916 Fly heading 065 Speed 180"),
 ("s24", "cathay nine one four climb one six thousand and proceed direct to the field heading three six zero", "SAY AGAIN"),
 ("v47", "united eight two four climb to one three thousand and speed two five zero", "UAL824 Altitude 13000 Speed 250"),
]
# not commands: nothing may be sent
CHAT = [
 ("v04", "speedbird three two seven how's the ride at your level"), ("s14", "qantas one seven seven are you ready to push"),
 ("v31", "scooter four nine eight do you have the airport in sight"), ("v06", "good morning everybody tower is open"),
 ("v10", "scooter four nine eight what's your fuel state"), ("v36", "delta six three nine thanks for the help today"),
 ("s11", "uh qantas two eight seven uh never mind"), ("v19", "japan air six four nine is your gear down"),
 ("v02", "um where was i"), ("v47", "united eight two four did you copy the weather"),
 ("s02", "cathay nine three six how many souls on board"), ("v22", "japan air nine one six welcome to the frequency"),
]
rows = []
for pid, items in SAID.items():
    p = P[pid]
    for i, (style, said) in enumerate(items):
        rows.append({"key": f"{pid}.{i}", "style": style, "kind": p["kind"], "heard": said, "ctx": p["ctx"], "line": p["line"], "icao": p["icao"]})
for i, (pid, said, line) in enumerate(MULTI):
    p = P[pid]; rows.append({"key": f"m{i}", "style": "multi", "kind": "multi", "heard": said, "ctx": p["ctx"], "line": line, "icao": p["icao"]})
for i, (pid, said) in enumerate(CHAT):
    p = P[pid]; rows.append({"key": f"c{i}", "style": "chat", "kind": "chat", "heard": said, "ctx": p["ctx"], "line": "SAY AGAIN", "icao": p["icao"]})
out = Path(__file__).parent / "rows.json"; out.write_text(json.dumps(rows, indent=1))
print(len(rows), "rows", {s: sum(r["style"] == s for r in rows) for s in ("plain", "terse", "other", "multi", "chat")})

# Held-out set: written after the plain-language layer (asr-repair PLAIN_WORDS) was tuned on the set above, with
# wordings that were not looked at while tuning. This is the number to quote.
HELD = {
 "v04": [("plain", "speedbird three two seven up to flight level eight zero please"), ("plain", "speedbird three two seven continue climb flight level eight zero")],
 "s02": [("terse", "cathay nine three six down to seven thousand"), ("plain", "cathay nine three six start your descent to seven thousand feet")],
 "v25": [("terse", "united three three five descend one thousand")],
 "v36": [("plain", "delta six three nine climb now to one three thousand")],
 "v02": [("plain", "emirates four six nine give me one nine zero knots"), ("terse", "emirates four six nine increase to one nine zero")],
 "s11": [("plain", "qantas two eight seven back to one six zero knots please"), ("terse", "qantas two eight seven speed back one six zero")],
 "v56": [("terse", "alaska nine zero one reduce one six zero")],
 "v10": [("plain", "scooter four nine eight new heading one six one"), ("plain", "scooter four nine eight turn one six one degrees")],
 "s06": [("terse", "jetstar six one four heading now three five one")],
 "v22": [("plain", "japan air nine one six take up heading zero six five")],
 "s01": [("terse", "velocity four nine nine tower now one one eight decimal five"), ("plain", "velocity four nine nine change to tower one one eight five")],
 "v26": [("plain", "easy eight one talk to tower")],
 "v41": [("plain", "ups nine nine eight contact control one two seven decimal one see you")],
 "v03": [("plain", "jetblue four two two got it"), ("plain", "jetblue four two two okay thanks")],
 "v05": [("plain", "hong kong express five two eight wait one"), ("plain", "hong kong express five two eight just a moment")],
 "s03": [("plain", "velocity four zero zero not possible right now traffic")],
 "v11": [("plain", "lufthansa nine seven eight go around runway is not clear"), ("plain", "lufthansa nine seven eight break off the approach go around")],
 "v09": [("plain", "easy five three two it'll be the ils two seven left"), ("terse", "easy five three two expect two seven left ils")],
 "s05": [("plain", "velocity five eight zero cleared to take off runway two five"), ("plain", "velocity five eight zero runway two five you are cleared for takeoff")],
 "v31": [("plain", "scooter four nine eight clear to land two five right"), ("terse", "scooter four nine eight land runway two five right")],
 "s04": [("terse", "virgin five zero taxi runway one six right kilo lima hold short zero seven")],
 "v24": [("plain", "hong kong express five two eight taxi to two eight hold short of one zero")],
 "f06": [("plain", "air india five zero four taxi to romeo one five via foxtrot two foxtrot three foxtrot four")],
 "v17": [("plain", "hong kong express five two seven cross two five right now"), ("plain", "hong kong express five two seven cleared to cross runway two five right")],
 "v13": [("terse", "jetblue five zero hold short of two seven"), ("plain", "jetblue five zero do not cross runway two seven hold short")],
 "v27": [("plain", "virgin four two hold there"), ("plain", "virgin four two stop taxi hold position")],
 "v28": [("plain", "speedbird nine three two continue taxiing"), ("plain", "speedbird nine three two carry on")],
 "v35": [("plain", "scooter four nine eight cleared direct sfono"), ("plain", "scooter four nine eight when ready direct sfono")],
 "v48": [("plain", "speedbird five zero direct to big now")],
 "v15": [("terse", "new zealand seven three seven cleared ils two zero left call established")],
 "s12": [("other", "qantas two seven zero radar contact expect ils approach runway three four right")],
 "v16": [("plain", "hong kong express five two seven surface wind three zero one degrees one zero knots")],
 "s08": [("terse", "qantas two three five expedite descent"), ("plain", "qantas two three five increase your rate of descent")],
 "v33": [("plain", "united eight eight eight cancel takeoff i say again cancel takeoff")],
 "v46": [("terse", "hong kong express five zero four exit charlie five"), ("plain", "hong kong express five zero four vacate at charlie five")],
 "v01": [("plain", "hong kong express five two eight pushback is approved expect two five left")],
 "s14": [("plain", "qantas one seven seven start and push approved expect runway one six right")],
 "v06": [("terse", "cathay two two two startup approved expect runway two five left")],
 "v18": [("terse", "sierra kilo whiskey eight five three hold at boswe right turns one minute")],
}
HELD_MULTI = [
 ("v04", "speedbird three two seven climb flight level eight zero speed two five zero", "BAW327 Altitude 8000 Speed 250"),
 ("s02", "cathay nine three six fly heading one eight zero descend seven thousand", "CPA936 Fly heading 180 Altitude 7000"),
 ("v22", "japan air nine one six heading zero six five speed one eight zero", "JAL916 Fly heading 065 Speed 180"),
 ("s11", "qantas two eight seven descend three thousand speed one six zero", "QFA287 Altitude 3000 Speed 160"),
]
HELD_CHAT = [("v04", "speedbird three two seven say hello to the cabin crew for me"), ("v10", "scooter four nine eight where are you parked tonight"),
 ("s02", "is anyone on this frequency"), ("v36", "delta six three nine nice landing by the way"), ("v19", "japan air six four nine do you need anything from us")]
held = []
for pid, items in HELD.items():
    p = P[pid]
    for i, (style, said) in enumerate(items):
        held.append({"key": f"h{pid}.{i}", "style": style, "kind": p["kind"], "heard": said, "ctx": p["ctx"], "line": p["line"], "icao": p["icao"]})
for i, (pid, said, line) in enumerate(HELD_MULTI):
    p = P[pid]; held.append({"key": f"hm{i}", "style": "multi", "kind": "multi", "heard": said, "ctx": p["ctx"], "line": line, "icao": p["icao"]})
for i, (pid, said) in enumerate(HELD_CHAT):
    p = P[pid]; held.append({"key": f"hc{i}", "style": "chat", "kind": "chat", "heard": said, "ctx": p["ctx"], "line": "SAY AGAIN", "icao": p["icao"]})
(Path(__file__).parent / "held.json").write_text(json.dumps(held, indent=1))
print(len(held), "held-out rows")
