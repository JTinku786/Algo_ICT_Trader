"""Read-only pixel/body alignment against stored OHLC. Ranking aid, not validation."""
import sys as _rs, os as _ro; _rs.path.insert(0, _ro.path.dirname(_ro.path.abspath(__file__))); from reports_dir import REPORTS, SCALPING_BACKTEST  # noqa: E402
import cv2,numpy as np,json
from pathlib import Path
root=(REPORTS/'icy-tea')
params={34:(100,520,780,1140,308,9.2,441),8:(164,534,720,1130,306,9.85,455),10:(184,527,700,1070,432,9.15,488),12:(164,430,790,1150,302,9.6,428),17:(211,483,750,1130,224,9.2,484),21:(210,450,740,1060,262,6.55,354),22:(185,444,140,570,293,10.5,417),23:(196,455,770,1100,290,6.4,390),24:(123,483,160,535,397,9.4,421),32:(240,439,160,540,403,6.8,414)}
refs=json.loads((root/'references.json').read_text(encoding='utf-8'))
outputs=[]
for idx,(xmin,xmax,ymin,ymax,xbase,step,entryx) in params.items():
 r=next(r for r in refs if r['index']==idx)
 key=f"{r['symbol']}-{r['date']}-{r['tf1'] or '1h'}-{r['tf2']}-{r['entryKind']}"
 d=json.loads((root/f'evidence-{key}.json').read_text(encoding='utf-8')) if idx!=34 else json.loads((root/'alignment-bars-34.json').read_text(encoding='utf-8'))
 if idx==34:d={'lower':d['bars']};r={**r,'date':'2026-05-28'}
 bars=[b for b in d['lower'] if b['day']==r['date']]
 im=cv2.imread(str(root/f'{idx:02}.jpg')).astype(np.int16)
 b,g,red=cv2.split(im)
 mask=((g-red>15)&(g-b>10)&(g<170)&(red<130))|((red<75)&(g<75)&(b<75))
 # Body width removes one-pixel wicks; only main-chart region selected manually.
 samples=[]
 for k in range(int((xmin-xbase)/step)-1,int((xmax-xbase)/step)+2):
  x=round(xbase+k*step)
  if not xmin<=x<=xmax:continue
  rows=np.flatnonzero(mask[ymin:ymax,x-2:x+3].sum(axis=1)>=3)
  groups=np.split(rows,np.where(np.diff(rows)>1)[0]+1)
  groups=[v for v in groups if len(v)>=5]
  if not groups:continue
  v=max(groups,key=len)
  samples.append((k,float((v[0]+v[-1])/2+ymin),len(v),x))
 if len(samples)<8:continue
 ks=np.array([v[0] for v in samples]);ys=np.array([v[1] for v in samples])
 ranked=[]
 for pos in range(-int(ks.min()),len(bars)-int(ks.max())):
  mids=np.array([(bars[pos+k]['o']+bars[pos+k]['c'])/2 for k in ks])
  if np.std(mids)<1e-8:continue
  corr=float(np.corrcoef(mids,ys)[0,1])
  if corr>=-0.6:continue
  scale,offset=np.polyfit(mids,ys,1);errors=np.abs(mids*scale+offset-ys)
  ranked.append((float(np.sqrt(np.mean(errors**2))),corr,pos,float(scale),float(offset)))
 ranked.sort()
 findings=[]
 for error,corr,pos,scale,offset in ranked[:5]:
  ei=pos+round((entryx-xbase)/step)
  findings.append({'pixelRMSE':error,'correlation':corr,'entryMinute':bars[ei]['minute'] if 0<=ei<len(bars) else None,'entryBar':bars[ei] if 0<=ei<len(bars) else None,'baseBar':bars[pos],'priceScale':scale,'priceOffset':offset})
 outputs.append({'index':idx,'samples':samples,'fits':findings,'note':'Pixel body midpoints only. Axis-free chart alignment must be checked against open/close direction, extrema and annotations before accepting.'})
 print(idx,[(round(x['pixelRMSE'],1),round(x['correlation'],3),x['entryMinute']) for x in findings])
(root/'pixel-alignment.json').write_text(json.dumps(outputs,indent=2),encoding='utf-8')
