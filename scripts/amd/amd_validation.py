"""Independent stored-row invariants plus sampled OHLC execution replay for V2."""
import datetime as dt
import json
import numpy as np
import pandas as pd
import amd_data as data

def validate(C,T,df,tf):
    failures=[]; cc={}; tc={}
    def check(book,name,values):
        v=pd.Series(values,dtype=bool)
        book[name]={'pass':int(v.sum()),'n':len(v)}
        if not v.all(): failures.append(f'{name}: {int((~v).sum())} failures')
    if not len(T):
        return dict(scope='full_population_timing_and_geometry; sampled_exit_replay',checked_cycles=len(C),total_cycles=len(C),checked_trades=0,total_trades=0,cycle_checks=cc,trade_checks=tc,failures=[],validated_at=dt.datetime.now().isoformat(timespec='seconds'))
    J=T.merge(C[['run_id','cycle_id','acc_confirm','mss_date','return_date','sweep_extreme','atr','acc_hi','acc_lo','ce','fvg']],on=['run_id','cycle_id'],validate='many_to_one')
    check(tc,'all required decision candles precede entry bars',J.decision_date<J.entry_date)
    for name in ['decision_known_at','order_active_at','entry_not_before','exit_known_at','mss_known_at','fvg_known_at']:
        J[name]=pd.to_datetime(J[name],utc=True)
    check(tc,'decision complete before order activation',J.decision_known_at<=J.order_active_at)
    check(tc,'order active before entry interval',J.order_active_at<=J.entry_not_before)
    check(tc,'exit cannot precede entry',J.exit_known_at>=J.entry_not_before)
    check(tc,'directional stop and target geometry',np.where(J.side.eq('bull'),(J.stop<J.entry)&(J.tgt.isna()|(J.tgt>J.entry)),(J.stop>J.entry)&(J.tgt.isna()|(J.tgt<J.entry))))
    m=J.model.str.startswith('MSS'); f=J.model.str.startswith('MSS_FVG')
    check(tc,'MSS complete before decision and fill',J.loc[m,'mss_known_at'].notna()&(J.loc[m,'mss_known_at']<=J.loc[m,'decision_known_at'])&(J.loc[m,'mss_date']<J.loc[m,'entry_date']))
    check(tc,'FVG third candle complete before decision',J.loc[f,'fvg_known_at'].notna()&(J.loc[f,'fvg_known_at']<=J.loc[f,'decision_known_at']))
    check(tc,'accumulation and reclaim precede decision', (J.acc_confirm<=J.decision_date)&(J.return_date<=J.decision_date))
    check(tc,'unique trade identities',~T.duplicated(['run_id','trade_id']))
    # Link every trade to the exact raw segment and source candle.
    raw=df[['sym','d','o','h','l','c','segment']]
    E=J.merge(raw.rename(columns={'d':'entry_date','o':'eo','h':'eh','l':'el','c':'ec','segment':'es'}),on=['sym','entry_date'],how='left',validate='many_to_one')
    E=E.merge(raw[['sym','d','segment']].rename(columns={'d':'decision_date','segment':'ds'}),on=['sym','decision_date'],how='left',validate='many_to_one')
    E=E.merge(raw[['sym','d','segment']].rename(columns={'d':'exit_date','segment':'xs'}),on=['sym','exit_date'],how='left',validate='many_to_one')
    check(tc,'raw input exists; no order crosses a data gap',E['es'].notna()&(E['es']==E['ds'])&(E['es']==E['xs']))
    check(tc,'market entries equal next observed raw open',np.isclose(E.loc[~f,'entry'],E.loc[~f,'eo'],rtol=0,atol=1e-7))
    check(tc,'limit fill touches planned CE',np.where(E.loc[f,'side'].eq('bull'),E.loc[f,'el']<=E.loc[f,'planned_entry'],E.loc[f,'eh']>=E.loc[f,'planned_entry']))
    check(tc,'recorded cost risk matches price geometry',np.isclose(J.risk_pct,100*(J.entry-J.stop).abs()/J.entry,rtol=0,atol=1e-7))
    # Independently inspect every FVG's source candles and first eligible touch.
    sources={s:g.set_index('d') for s,g in df.groupby('sym')}
    # Validate actual structure, not just the emitted labels/timestamps.
    mss_checks=[]; acc_checks=[]; raid_checks=[]
    for row in C[C.family.eq('structural')].itertuples():
        g=sources[row.sym]
        s=g.index.get_loc(pd.Timestamp(row.acc_start)); j=g.index.get_loc(pd.Timestamp(row.acc_confirm))
        box=g.iloc[s:j+1]
        acc_checks.append(np.isclose(box.h.max(),row.acc_hi,rtol=0,atol=1e-7) and np.isclose(box.l.min(),row.acc_lo,rtol=0,atol=1e-7) and box.segment.nunique()==1)
        if pd.notna(row.return_date):
            p=g.index.get_loc(pd.Timestamp(row.pierce_date)); r=g.index.get_loc(pd.Timestamp(row.return_date))
            bull=row.manip_side=='dn'; raid=g.iloc[p:r+1]
            extreme=raid.l.min() if bull else raid.h.max()
            raid_checks.append(np.isclose(extreme,row.sweep_extreme,rtol=0,atol=1e-7) and p>j and r>=p)
        if pd.notna(row.mss_date):
            k=g.index.get_loc(pd.Timestamp(row.mss_date)); q=g.index.get_loc(pd.Timestamp(row.mss_swing_date))
            bull=row.manip_side=='dn'; body=(g.c.iloc[k]-g.o.iloc[k])*(1 if bull else -1); width=g.h.iloc[k]-g.l.iloc[k]
            swing=(g.h.iloc[q]>g.h.iloc[q-1] and g.h.iloc[q]>=g.h.iloc[q+1]) if bull else (g.l.iloc[q]<g.l.iloc[q-1] and g.l.iloc[q]<=g.l.iloc[q+1])
            level=g.h.iloc[q] if bull else g.l.iloc[q]
            cross=g.c.iloc[k-1]<=level<g.c.iloc[k] if bull else g.c.iloc[k-1]>=level>g.c.iloc[k]
            mss_checks.append(q+1<k and q>=s and swing and cross and np.isclose(level,row.mss_level,rtol=0,atol=1e-7) and body>=.75*row.atr-1e-9 and width>0 and body>=.5*width-1e-9)
    check(cc,'raw accumulation edges and continuity',acc_checks)
    check(cc,'raw raid extreme and chronological reclaim',raid_checks)
    check(cc,'raw confirmed swing, new close-through and displacement',mss_checks)
    fg=[]; fresh=[]; first=[]; cancellations=[]
    for row in E[f].itertuples():
        g=sources[row.sym]; pos=g.index.get_loc(pd.Timestamp(row.fvg_formed_at)); dec=g.index.get_loc(pd.Timestamp(row.decision_date)); ent=g.index.get_loc(pd.Timestamp(row.entry_date))
        bull=row.side=='bull'; start=pos-2
        correct=pos>=2 and g.segment.iloc[start]==g.segment.iloc[pos]
        correct=correct and ((g.l.iloc[pos]>g.h.iloc[start]) if bull else (g.h.iloc[pos]<g.l.iloc[start]))
        low,high=(g.h.iloc[start],g.l.iloc[pos]) if bull else (g.h.iloc[pos],g.l.iloc[start])
        body=(g.c.iloc[pos-1]-g.o.iloc[pos-1])*(1 if bull else -1); width=g.h.iloc[pos-1]-g.l.iloc[pos-1]
        correct=correct and body>=.75*row.atr-1e-9 and width>0 and body>=.5*width-1e-9
        planned=(high+.01 if bull else low-.01) if row.model=='MSS_FVG_EDGE' else (low+high)/2
        correct=correct and np.isclose(row.planned_entry,planned,rtol=0,atol=1e-7)
        fg.append(correct)
        xs=g.iloc[pos+1:dec+1]
        fresh.append(not ((xs.l<=row.planned_entry).any() if bull else (xs.h>=row.planned_entry).any()))
        xs=g.iloc[dec+1:ent+1]
        touches=np.flatnonzero((xs.l<=row.planned_entry).values if bull else (xs.h>=row.planned_entry).values)
        first.append(len(touches)>0 and dec+1+touches[0]==ent and ent<=dec+10)
        prior=g.iloc[dec:ent]
        invalid=((prior.c<row.sweep_extreme)|(prior.l<=row.stop)|(prior.h>=row.acc_hi)) if bull else ((prior.c>row.sweep_extreme)|(prior.h>=row.stop)|(prior.l<=row.acc_lo))
        cancellations.append(not invalid.any())
    check(tc,'FVG raw three-candle geometry and planned entry level',fg)
    check(tc,'FVG entry level unfilled before activation',fresh)
    check(tc,'FVG first eligible touch inside expiry',first)
    check(tc,'pending FVG not invalidated before entry',cancellations)
    # Separate execution replay; do not call the engine's simulator.
    results=[]
    for row in E.sample(min(1500,len(E)),random_state=19).itertuples():
        g=sources[row.sym]; e=g.index.get_loc(pd.Timestamp(row.entry_date)); x=g.index.get_loc(pd.Timestamp(row.exit_date)); bull=row.side=='bull'
        expected=None
        for k in range(e,x+1):
            bar=g.iloc[k]; isfirst=k==e
            stop_hit=bar.l<=row.stop if bull else bar.h>=row.stop
            target_hit=(bar.h>=row.tgt if bull else bar.l<=row.tgt) if pd.notna(row.tgt) else False
            if stop_hit:
                px=bar.o if not isfirst and (bar.o<row.stop if bull else bar.o>row.stop) else row.stop
                expected=('loss',px,k); break
            if isfirst and row.model.startswith('MSS_FVG'): continue
            if target_hit:
                px=bar.o if not isfirst and (bar.o>row.tgt if bull else bar.o<row.tgt) else row.tgt
                expected=('win',px,k); break
        if expected is None: expected=(row.outcome,g.c.iloc[x],x)
        outcome,px,k=expected; risk=abs(row.entry-row.stop)
        results.append(outcome==row.outcome and k==x and np.isclose((px-row.entry)*(1 if bull else -1)/risk,row.r,rtol=0,atol=1e-7))
    check(tc,'sampled raw OHLC exits and R replay',results)
    structural=C[C.family.eq('structural')]
    check(cc,'accumulation confirms before manipulation',structural.return_date.isna()|(structural.acc_confirm<structural.return_date))
    if tf!='1d':
        S=J[J.family.eq('session')]
        ends=S.decision_known_at.dt.tz_convert('America/New_York')
        check(tc,'session reclaim candle closes before noon',ends.dt.hour<12)
        check(tc,'session exit remains on entry day',S.entry_date.dt.normalize()==S.exit_date.dt.normalize())
    return dict(scope='full_population_timing_geometry_and_fvg; exit_replay_sample_1500',checked_cycles=len(C),total_cycles=len(C),checked_trades=len(T),total_trades=len(T),cycle_checks=cc,trade_checks=tc,failures=failures,validated_at=dt.datetime.now().isoformat(timespec='seconds'))
