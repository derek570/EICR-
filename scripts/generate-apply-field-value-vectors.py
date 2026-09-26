#!/usr/bin/env python3
"""PLAN-W2 — generate config/apply-field-value-vectors.json from a reference rule.

The fixture is the cross-client apply-field value contract (see its $comment).
This script is the reference implementation the vectors were derived from, so a
vector's `stored` / `spoken` / `outcome` is computed, never hand-typed. After
editing it, run it, copy the output to CertMateUnified's Fixtures directory, and
update the paired SHA-256 constants in both repos' contract tests.
"""
import json, os, re, collections
O=collections.OrderedDict
FIELDS=[
 ("boolean","polarity","polarity_confirmed",[]),
 ("boolean","rcd_button","rcd_button_confirmed",[]),
 ("boolean","afdd_button","afdd_button_confirmed",[]),
 ("numeric","rcd_trip_time","rcd_time_ms",["ms","msec","millisecond","milliseconds"]),
 ("numeric","ir_test_voltage","ir_test_voltage_v",["v","volt","volts"]),
 ("numeric","ocpd_rating","ocpd_rating_a",["a","amp","amps","ampere","amperes"]),
 ("numeric","rcd_rating","rcd_rating_a",["a","amp","amps","ampere","amperes"]),
 ("numeric","rcd_operating_current","rcd_operating_current_ma",["ma","milliamp","milliamps"]),
 ("numeric","disconnect_time","max_disconnect_time_s",["s","sec","secs","second","seconds"]),
 ("numeric","number_of_points","number_of_points",["point","points"]),
 ("numeric","ocpd_breaking_capacity","ocpd_breaking_capacity_ka",["ka","k","kiloamp","kiloamps"]),
 ("numeric","ocpd_max_zs","ocpd_max_zs_ohm",["ω","ohm","ohms"]),
]
TRUTHY=["ok","correct","confirmed","yes","true","pass","✓","✔","1","worked","works","operated","operates","okay","passed"]
FALSY=["fail","failed"]
VOCAB=[O(token=t,stored="✓",spoken=("correct" if t in ("✓","✔","1") else t)) for t in TRUTHY]+[O(token=t,stored="✗",spoken=t) for t in FALSY]
LABELS=[("rcd_trip_time","rcd_time_ms","RCD trip time"),("ir_test_voltage","ir_test_voltage_v","insulation test voltage"),
 ("rcd_button","rcd_button_confirmed","RCD test button"),("afdd_button","afdd_button_confirmed","AFDD test button"),
 ("polarity","polarity_confirmed","polarity"),("wiring_type","wiring_type","wiring type"),("ref_method","ref_method","reference method"),
 ("disconnect_time","max_disconnect_time_s","disconnection time"),("ocpd_type","ocpd_type","OCPD type"),("ocpd_rating","ocpd_rating_a","OCPD rating"),
 ("ocpd_bs_en","ocpd_bs_en","OCPD BS EN"),("ocpd_breaking_capacity","ocpd_breaking_capacity_ka","OCPD breaking capacity"),
 ("ocpd_max_zs","ocpd_max_zs_ohm","OCPD maximum Zs"),("rcd_type","rcd_type","RCD type"),("rcd_rating","rcd_rating_a","RCD rating"),
 ("rcd_bs_en","rcd_bs_en","RCD BS EN"),("rcd_operating_current","rcd_operating_current_ma","RCD operating current"),
 ("number_of_points","number_of_points","number of points")]
NUM=re.compile(r'^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)\s*(.*)$')
F={f[1]:f for f in FIELDS}
LEAD=re.compile(r'^(?:[,;:!?]|\.(?![0-9]))+')
TRAIL=re.compile(r'[.,;:!?]+$')
def heard(raw):
    r=raw.strip()
    r=LEAD.sub('',r).strip()
    r=TRAIL.sub('',r).strip()
    return r
def resolve(key,raw):
    kind,_,_,units=F[key]
    r=heard(raw).lower()
    if kind=="numeric":
        m=NUM.match(r)
        if not m: return None
        rest=m.group(2).split()
        if all(t in units for t in rest): return (m.group(1),m.group(1))
        return None
    toks=set(r.split())
    if len(toks)!=1: return None
    t=toks.pop()
    for v in VOCAB:
        if v["token"]==t: return (v["stored"],v["spoken"])
    return None
VALUE=[
 ("polarity","correct"),("polarity","correct correct"),("polarity","Correct."),("polarity","pass"),("polarity","passed"),("polarity","okay"),("polarity","ok"),("polarity","yes"),("polarity","✓"),("polarity","1"),
 ("polarity","fail"),("polarity","failed"),
 ("polarity","not correct"),("polarity","n a"),("polarity","n/a"),("polarity","all correct"),("polarity","incorrect"),("polarity","reversed"),("polarity","no"),("polarity","correct fail"),
 ("rcd_button","worked"),("rcd_button","works"),("rcd_button","operated"),("rcd_button","not tested"),
 ("afdd_button","operates"),("afdd_button","confirmed"),("afdd_button","n/a"),
 ("rcd_trip_time","25 ms"),("rcd_trip_time","25ms"),("rcd_trip_time","25 milliseconds"),("rcd_trip_time","25"),("rcd_trip_time","25.5 msec"),
 ("rcd_trip_time","25 to 30"),("rcd_trip_time","greater than 300"),("rcd_trip_time","about 25"),("rcd_trip_time","25 plus"),("rcd_trip_time","ms 25"),
 ("ir_test_voltage","250 volts"),("ir_test_voltage","500 v"),("ir_test_voltage","500"),("ir_test_voltage","1,000"),
 ("ocpd_rating","32"),("ocpd_rating","32 amps"),("ocpd_rating","32 a"),("ocpd_rating","b 32"),("ocpd_rating","32 b"),
 ("rcd_rating","40 amps"),("rcd_rating","30 ma"),
 ("rcd_operating_current","30 ma"),("rcd_operating_current","30ma"),("rcd_operating_current","30 milliamps"),("rcd_operating_current","30 m"),("rcd_operating_current","30 or 100"),
 ("disconnect_time","0.4"),("disconnect_time",".4"),("disconnect_time","0.4."),("rcd_trip_time","25."),("rcd_trip_time",", 25"),("disconnect_time","0.4 seconds"),("disconnect_time","5 s"),("disconnect_time","0.4 or 5"),
 ("number_of_points","6"),("number_of_points","6 points"),("number_of_points","6 plus 2 spurs"),("number_of_points","6 plus 2"),
 ("ocpd_breaking_capacity","6 ka"),("ocpd_breaking_capacity","6ka"),("ocpd_breaking_capacity","6 k"),("ocpd_breaking_capacity","10 kiloamps"),("ocpd_breaking_capacity","6 or 10"),
 ("ocpd_max_zs","1.37"),("ocpd_max_zs","1.37 ω"),("ocpd_max_zs","1.37 ohms"),("ocpd_max_zs","1.37 or 2.73"),
]
vv=[]
for k,raw in VALUE:
    r=resolve(k,raw)
    row=O(field=k,raw=raw)
    if r: row["outcome"]="accepted"; row["stored"]=r[0]; row["spoken"]=r[1]
    else: row["outcome"]="unresolved"
    vv.append(row)
UTT=[
 ("set polarity to pass for circuits 1 to 4","polarity","pass"),
 ("polarity not correct for circuit 3","polarity","not correct"),
 ("polarity correct for circuit 3","polarity","correct"),
 ("polarity failed for circuit 3","polarity","failed"),
 ("polarity n a for circuit 3","polarity","n a"),
 ("polarity n/a for circuit 3","polarity","n/a"),
 ("polarity all correct for all circuits","polarity","all correct"),
 ("rcd test button worked for all circuits","rcd_button","worked"),
 ("rcd test button not tested for circuit 3","rcd_button","not tested"),
 ("rcd trip time 25 ms for circuit 3","rcd_trip_time","25 ms"),
 ("rcd trip time 25 to 30 for circuit 3","rcd_trip_time","25 to 30"),
 ("rcd trip time greater than 300 for circuit 3","rcd_trip_time","greater than 300"),
 ("rcd trip time for all circuits is 25 ms","rcd_trip_time","25 ms"),
 ("rcd operating current 30 ma for all circuits","rcd_operating_current","30 ma"),
 ("rcd rating 30 ma for circuit 3","rcd_rating","30 ma"),
 ("breaking capacity 6 ka for all circuits","ocpd_breaking_capacity","6 ka"),
 ("disconnect time 0.4 seconds for circuit 2","disconnect_time","0.4 seconds"),
 ("number of points for circuit 4 is 6 plus 2 spurs","number_of_points","6 plus 2 spurs"),
 ("number of points 6 for circuit 4","number_of_points","6"),
 ("ocpd rating b 32 for circuit 3","ocpd_rating","b 32"),
 ("test voltage 500 volts for all circuits","ir_test_voltage","500 volts"),
 ("ocpd max zs 1.37 ohms for circuit 2","ocpd_max_zs","1.37 ohms"),
]
uv=[]
for u,k,h in UTT:
    r=resolve(k,h)
    row=O(utterance=u,field=k,heard=h)
    if r: row["outcome"]="accepted"; row["stored"]=r[0]; row["spoken"]=r[1]
    else: row["outcome"]="unresolved"
    uv.append(row)
TEMPLATE="I couldn't record {label} '{heard}'. {tail}"
TAILS=O(ask="Answer the question first, then say it again.",capture="Finish the feedback first, then say it again.",session="I'm not connected. Say it again in a moment.")
LBL={a:c for a,b,c in LABELS}
LAG=[("polarity","not correct","ask"),("number_of_points","6 plus 2 spurs","ask"),("rcd_trip_time","25","capture"),("disconnect_time","0.4","session"),("wiring_type","a","capture")]
lv=[O(field=k,heard=h,tail=t,text=TEMPLATE.replace("{label}",LBL[k]).replace("{heard}",h).replace("{tail}",TAILS[t])) for k,h,t in LAG]
doc=O()
doc["$comment"]=("PLAN-W2 (Decision 7 wrong-value wave, 2026-09-26) — the apply-field VALUE contract. CROSS-CLIENT CONTRACT: it decides whether a value that a client's LOCAL apply-field parser pulled out of an utterance is ACCEPTED (and what is stored and spoken) or UNRESOLVED (handed to the model, never guessed). It covers the 12 boolean and numeric fields both clients parse locally. Rules, applied to the value residue after the parser strips one leading 'is ', 'to ' or '= ': trim whitespace, strip `leading_trim_pattern` and `trailing_trim_pattern` (edge punctuation `.,;:!?`, keeping a leading decimal point that a digit follows), then lowercase. The trimmed residue, in the parser's case, is also the `heard` text a lag line quotes. NUMERIC: the residue must match `number_pattern`; every whitespace-separated token after the number must be in that field's `units`; stored and spoken are the number capture. BOOLEAN: the residue must hold exactly ONE distinct whitespace-separated token and it must be a `boolean_vocabulary` token; stored is the sigil, spoken is the word. Everything else is unresolved. `labels` and `lag_line` pin the one line a declined command speaks when it cannot be forwarded. web/ tests read this file directly; CertMateUnified keeps a byte-identical copy at Tests/CertMateUnifiedTests/Fixtures/apply-field-value-vectors.json pinned by paired SHA-256 digest constants, and scripts/check-apply-field-value-fixture-sync.sh byte-compares the two as a named pre-TestFlight step in deploy-testflight.sh.")
doc["plan"]="PLAN-W2-2026-09-26"
doc["leading_trim_pattern"]=LEAD.pattern
doc["trailing_trim_pattern"]=TRAIL.pattern
doc["number_pattern"]=NUM.pattern
doc["fields"]=[O(kind=a,ios_key=b,web_field=c,units=d) for a,b,c,d in FIELDS]
doc["boolean_vocabulary"]=VOCAB
doc["labels"]=[O(ios_key=a,web_field=b,label=c) for a,b,c in LABELS]
doc["lag_line"]=O(template=TEMPLATE,tails=TAILS)
doc["value_vectors"]=vv
doc["utterance_vectors"]=uv
doc["lag_line_vectors"]=lv
open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","config","apply-field-value-vectors.json"),"w",encoding="utf-8").write(json.dumps(doc,indent=2,ensure_ascii=False)+"\n")
