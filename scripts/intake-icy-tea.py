"""Read-only source intake; checkpoint each OCR result and deduplicate by content."""
import sys as _rs, os as _ro; _rs.path.insert(0, _ro.path.dirname(_ro.path.abspath(__file__))); from reports_dir import REPORTS, SCALPING_BACKTEST  # noqa: E402
import hashlib,json,time,threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image,ImageOps,ImageDraw
from rapidocr_onnxruntime import RapidOCR
ROOT=(REPORTS/'icy-tea/intake')
ROOT.mkdir(parents=True,exist_ok=True)
SOURCE=Path(r'C:/Users/saite/Downloads/some_icy_tea')
prior=json.loads((REPORTS/'icy-tea/inventory.json').read_text())
known={Path(r['file']).name:r['index'] for r in prior}
files=sorted(p for p in SOURCE.iterdir() if p.is_file())
seen={};rows=[]
for p in files:
 digest=hashlib.sha256(p.read_bytes()).hexdigest()
 row={'id':digest[:16],'file':str(p),'sha256':digest,'size':p.stat().st_size,'priorIndex':known.get(p.name),'duplicateOf':seen.get(digest),'type':p.suffix[1:]}
 if digest not in seen:seen[digest]=p.name
 rows.append(row)
(ROOT/'inventory.json').write_text(json.dumps(rows,indent=2))
local=threading.local()
images=[r for r in rows if r['type']!='mp4' and not r['duplicateOf']]
def intake(pair):
 n,r=pair
 dst=ROOT/(r['id']+'.json')
 if dst.exists():return
 t=time.perf_counter()
 im=Image.open(r['file']).convert('RGB')
 im.save(ROOT/(r['id']+'.jpg'),quality=92)
 if not hasattr(local,"ocr"):local.ocr=RapidOCR(intra_op_num_threads=1,inter_op_num_threads=1)
 result,_=local.ocr(str(ROOT/(r['id']+'.jpg')))
 payload={**r,'width':im.width,'height':im.height,'ocr':[{'box':x[0],'text':x[1],'confidence':x[2]} for x in result or []],'seconds':round(time.perf_counter()-t,2)}
 dst.write_text(json.dumps(payload,indent=2))
 print(n+1,len(images),r['id'],payload['seconds'],flush=True)
with ThreadPoolExecutor(max_workers=4) as executor:
 list(executor.map(intake,enumerate(images)))
for page in range(0,len(images),12):
 canvas=Image.new('RGB',(1800,1800),'#eeeeee');draw=ImageDraw.Draw(canvas)
 for pos,r in enumerate(images[page:page+12]):
  im=Image.open(ROOT/(r['id']+'.jpg'));im.thumbnail((590,410))
  x=(pos%3)*600;y=(pos//3)*450
  canvas.paste(im,(x,y+25));draw.text((x+8,y+7),f"{page+pos}: {r['id']} prior={r['priorIndex']}",fill='black')
 canvas.save(ROOT/f'sheet-{page//12:02}.jpg',quality=94)
summary={'files':len(rows),'unique':len(seen),'newFiles':sum(r['priorIndex'] is None for r in rows),'uniqueImages':len(images),'duplicateFiles':sum(bool(r['duplicateOf']) for r in rows),'ocrCompleted':len(list(ROOT.glob('*.json')))-1}
(ROOT/'summary.json').write_text(json.dumps(summary,indent=2))
print(summary)
