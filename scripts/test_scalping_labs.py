"""Chronology / append-future checks on stored candle evidence, not image-injected trades."""
import sys as _rs, os as _ro; _rs.path.insert(0, _ro.path.dirname(_ro.path.abspath(__file__))); from reports_dir import REPORTS, SCALPING_BACKTEST  # noqa: E402
import importlib.util
import json
import unittest
from pathlib import Path

ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('labs',ROOT/'scalping_labs_updated.py')
labs=importlib.util.module_from_spec(spec);spec.loader.exec_module(labs)

class CausalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data=json.loads((ROOT/'mss-smoke-input.json').read_text(encoding='utf-8'))
        cls.data.update(confirmation='CHOCH',arrayScope='EXISTING',scalping={'version':1,'playbooks':['RAID','INVERSION','BREAKER','REACTION','OPENING','CONTINUATION'],'anchor':'CE','stop':'EXTREME','target':'LIQUIDITY','tickSize':.01,'maxAgeBars':200})
        cls.full=labs.run(cls.data)

    def test_entry_activation_and_geometry(self):
        entries=[(i,a,a['entry']) for i in self.full['investigations'] for a in i['arrays'] if a['entry']]
        self.assertGreater(len(entries),0,'Fixture must exercise actual entries')
        for i,a,e in entries:
            for known in [i['htf']['knownAt'],i['mss']['knownAt'],a['zone']['knownAt']]:self.assertLessEqual(known,e['at'])
            self.assertLess(i['touch']['t'],i['mss']['at'])
            self.assertLessEqual(e['plan']['targetSource']['knownAt'],e['at'])
            sign=1 if i['mss']['direction']=='BUY' else -1
            self.assertGreater(sign*(e['price']-e['plan']['stop']),0)
            self.assertGreater(sign*(e['plan']['target']-e['price']),0)

    def test_appending_future_does_not_change_earlier_plans(self):
        prefix=dict(self.data);prefix['lower']=self.data['lower'][:-35]
        clock=prefix['lower'][-1]['knownAt']
        prefix['higher']=[b for b in self.data['higher'] if b['knownAt']<=clock]
        prefix['daily']=[b for b in self.data['daily'] if b['knownAt']<=clock]
        before=labs.run(prefix)
        def plans(result):
            return {(i['id'],a['zone']['id'],e['at']):(e['price'],e['plan']['stop'],e['plan']['target'],tuple(e['playbooks']))
                    for i in result['investigations'] for a in i['arrays'] if (e:=a['entry']) and e['knownAt']<=clock}
        self.assertEqual(plans(before),plans(self.full))

    def test_wire_graph_is_lossless(self):
        wire=labs.object_graph(self.full);nodes=[]
        def resolve(v):return nodes[v['$']] if isinstance(v,dict) else v
        for kind,payload in wire['nodes']:
            nodes.append({k:resolve(v) for k,v in payload.items()} if kind=='o' else [resolve(v) for v in payload])
        self.assertEqual(resolve(wire['root']),self.full)
        self.assertLess(len(json.dumps(wire)),len(json.dumps(self.full)))

    def test_liquidity_sweep_keeps_context_but_invalidated_array_expires(self):
        line={'kind':'BSL','knownAt':1,'retiredAt':3}
        self.assertFalse(labs.active(line,4))
        self.assertTrue(labs.context_live(line,4))
        self.assertFalse(labs.context_live(line,0))
        self.assertFalse(labs.context_live({**line,'kind':'OB'},4))

    def test_displacement_union_versions_are_causal(self):
        bars=[{'t':i,'knownAt':i+1,'day':'2026-01-01','o':20,'h':20,'l':1,'c':10} for i in range(8)]
        gaps=[{'id':str(i),'kind':'FVG','direction':'SELL','low':low,'high':high,'origin':i,'knownAt':i+3,'raw':{'middleIndex':i+1}} for i,low,high in [(0,17,18),(1,14,16),(2,11,13)]]
        before=labs.displacement_ranges(gaps[:2],bars,'5m')
        after=labs.displacement_ranges(gaps,bars,'5m')
        self.assertEqual((before[0]['low'],before[0]['high'],before[0]['knownAt']),(14,18,4))
        self.assertEqual((after[1]['low'],after[1]['high'],after[1]['knownAt']),(11,18,5))
        self.assertEqual(after[0]['retiredAt'],5)
        self.assertEqual(len(after[1]['raw']['sourceIds']),3)
        broken=[dict(gaps[0]),{**gaps[1],'raw':{'middleIndex':7}}]
        self.assertEqual(labs.displacement_ranges(broken,bars,'5m'),[])

    def test_late_array_cannot_reset_shift_age_or_breach(self):
        for direction in ['BUY','SELL']:
            bars=[{'t':i,'knownAt':i+1,'day':'2026-01-01','o':10,'c':10,'l':9,'h':11} for i in range(1,9)]
            event={'knownAt':2,'formationStart':1,'at':1,'direction':direction}
            context={'kind':'OB','knownAt':0,'retiredAt':None}
            zone={'kind':'FVG','knownAt':7,'origin':6,'retiredAt':None,'direction':direction,'low':9.5,'high':10.5}
            settings={**self.data['scalping'],'maxAgeBars':3}
            self.assertEqual(labs.retests(bars,zone,event,context,settings,'CONTINUATION','ALL'),[])
            settings['maxAgeBars']=200
            broken=[dict(b) for b in bars]
            broken[2]['l' if direction=='BUY' else 'h']=8 if direction=='BUY' else 12
            self.assertEqual(labs.retests(broken,zone,event,context,settings,'CONTINUATION','ALL'),[])
            # A late array remains eligible when the originating shift is alive.
            self.assertTrue(labs.retests(bars,zone,event,context,settings,'CONTINUATION','ALL'))

    def test_apr14_2355_entry_does_not_revive_old_cisd(self):
        evidence=json.loads((REPORTS/'scalping-labs/eurusd-apr14-ob-valid-fvg.json').read_text(encoding='utf-8'))
        target=1776225300000
        found=[]
        for investigation in evidence['investigations']:
            for array in investigation['arrays']:
                entry=array.get('entry')
                if entry and entry['at']==target:
                    found.append(entry)
                    retests=labs.retests(evidence['lower'],array['zone'],investigation['mss'],investigation['htf'],evidence['scalping'],'CONTINUATION','ALL')
                    self.assertFalse(any(e['at']==target for e in retests))
        self.assertEqual(len(found),7)

    def test_tf1_five_candle_window_and_no_future_refresh(self):
        higher=[{'t':i*60,'knownAt':(i+1)*60} for i in range(8)]
        touches=[{'t':10,'knownAt':15},{'t':310,'knownAt':315}]
        window=labs.TF1TouchWindow(higher,touches,'1h')
        self.assertTrue(window.proof(299,50)['valid'])  # candle 0 still in latest five
        self.assertFalse(window.proof(300,50)['valid']) # candles 1..5 exclude candle 0
        self.assertTrue(window.proof(320)['valid'])
        self.assertFalse(window.proof(320,50)['valid']) # new touch cannot renew an old shift
        self.assertFalse(window.proof(14)['valid']) # touch candle has not closed
        prefix=labs.TF1TouchWindow(higher[:5],touches[:1],'1h')
        self.assertEqual(prefix.proof(299),window.proof(299))
        sparse=labs.TF1TouchWindow([{'t':i*86400,'knownAt':i*86400+60} for i in range(6)],touches[:1],'1h')
        self.assertTrue(sparse.proof(4*86400)['valid']) # actual candles, not elapsed hours
        self.assertFalse(sparse.proof(5*86400)['valid'])

    def test_every_emitted_entry_has_fresh_tf1_evidence(self):
        for investigation in self.full['investigations']:
            for array in investigation['arrays']:
                entry=array.get('entry')
                if not entry:continue
                check=next(c for c in entry['checklist']['checks'] if c['id']=='TF1_TOUCH_FRESHNESS')
                self.assertTrue(check['required']);self.assertEqual(check['verdict'],'PASS')
                proof=check['evidence']
                for at in ['shift','entry']:
                    self.assertTrue(proof[at]['valid']);self.assertLessEqual(proof[at]['touchKnownAt'],proof[at]['at'])
                    self.assertGreaterEqual(proof[at]['touchAt'],proof[at]['windowStart'])
                self.assertLessEqual(proof['entry']['touchKnownAt'],investigation['mss']['knownAt'])

    def test_anchor_uses_source_candle_not_confirmation(self):
        bars=[{'t':1,'o':10,'c':8,'h':11,'l':7},{'t':2,'o':8,'c':12,'h':13,'l':8}]
        z={'kind':'OB','direction':'BUY','origin':1,'low':7,'high':11}
        self.assertEqual(labs.anchor_price(z,bars,'OB_OPEN'),10)
        self.assertEqual(labs.anchor_price(z,bars,'BODY_MT'),9)

    def test_previous_day_context_cannot_enter_following_session(self):
        bars=[{'t':i,'knownAt':i+1,'day':'2026-01-01' if i<4 else '2026-01-02',
               'o':10,'c':10,'l':9,'h':11} for i in range(1,7)]
        event={'knownAt':2,'formationStart':1,'at':1,'direction':'BUY'}
        context={'kind':'PDL','knownAt':0,'retiredAt':None,'sessionDay':'2026-01-01'}
        zone={'kind':'FVG','knownAt':4,'origin':3,'retiredAt':None,'direction':'BUY','low':9.5,'high':10.5}
        self.assertTrue(labs.context_bar_live(context,bars[0]))
        self.assertFalse(labs.context_bar_live(context,bars[-1]))
        self.assertEqual(labs.retests(bars,zone,event,context,self.data['scalping'],'CONTINUATION','ALL'),[])
        self.assertTrue(labs.retests(bars,zone,event,{**context,'kind':'OB','sessionDay':None},self.data['scalping'],'CONTINUATION','ALL'))

    def test_previous_day_level_retirement_is_session_local(self):
        source={'t':0,'day':'2025-12-31','o':10,'h':12,'l':9,'c':10}
        bars=[{'t':i,'knownAt':i+1,'day':'2026-01-01' if i<3 else '2026-01-02',
               'o':10,'c':8 if i==1 else 10,'l':8,'h':11} for i in range(1,6)]
        previous=labs.derived('PDL',1,9,9,source,0,'1d',bars)
        current=labs.derived('PDL',1,9,9,source,0,'1d',[b for b in bars if b['day']=='2026-01-02'])
        self.assertEqual(previous['retiredAt'],2)
        self.assertIsNone(current['retiredAt'])

    def test_retest_cache_separates_liquidity_story_and_array_lifetimes(self):
        bars=[{'t':i,'knownAt':i+1,'day':'2026-01-01','o':10,'c':10,'l':9,'h':11} for i in range(1,9)]
        event={'id':'shift','knownAt':3,'formationStart':1,'at':2,'direction':'BUY'}
        zone={'id':'entry-array','kind':'FVG','knownAt':6,'origin':5,'retiredAt':None,'direction':'BUY','low':9.5,'high':10.5}
        line={'kind':'SSL','knownAt':0,'retiredAt':5}
        array={**line,'kind':'OB'}
        self.assertTrue(labs.retests(bars,zone,event,line,self.data['scalping'],'CONTINUATION','ALL'))
        self.assertEqual(labs.retests(bars,zone,event,array,self.data['scalping'],'CONTINUATION','ALL'),[])
        key=lambda c:labs.retest_cache_key(zone,event,c,self.data['scalping'],'ALL')
        self.assertNotEqual(key(line),key(array))

    def test_independent_audit_rejects_retired_arrays_and_wrong_daily_session(self):
        from scalping_backtest_validation import audit_candidate
        investigation,candidate=next((i,a) for i in self.full['investigations'] for a in i['arrays'] if a.get('entry'))
        entry=candidate['entry']
        self.assertEqual(audit_candidate(investigation,candidate),[])
        retired={**investigation,'htf':{**investigation['htf'],'kind':'OB','retiredAt':entry['at']}}
        retired_candidate={**candidate,'zone':{**candidate['zone'],'retiredAt':entry['at']}}
        violations=audit_candidate(retired,retired_candidate)
        self.assertIn('retired_tf1_context_at_entry',violations)
        self.assertIn('retired_tf2_array_at_entry',violations)
        line={**retired,'htf':{**retired['htf'],'kind':'SSL'}}
        self.assertNotIn('retired_tf1_context_at_entry',audit_candidate(line,candidate))
        previous={**investigation,'htf':{**investigation['htf'],'sessionDay':'1900-01-01'}}
        self.assertIn('previous_day_context_wrong_session',audit_candidate(previous,candidate))

    def test_indexed_retests_and_evidence_equal_reference_walks(self):
        bars=self.data['lower'];index=labs.BarIndex(bars)
        zones,_=labs.base.cached_scan(bars,self.data['tf2'])
        zones=labs.enrich(zones,bars,self.data['tf2'])
        checklist_zones=[z for z in zones if z['kind'] in {'BREAKER','FVG','BSL','SSL'}]
        exercised=0
        for investigation in self.full['investigations']:
            event=investigation.get('mss')
            if not event:continue
            for candidate in investigation['arrays']:
                entry=candidate.get('entry')
                if not entry:continue
                zone=candidate['zone'];context=investigation['htf']
                args=(bars,zone,event,context,self.data['scalping'],'EXISTING','ALL')
                self.assertEqual(labs.retests(*args),labs.retests(*args,index=index))
                filters={'version':1,'playbook':'CUSTOM','required':[],'direction':'ALL','entryPrice':'CE','minRR':0,'maxRR':None,'session':'ANY'}
                args=(entry,event,investigation['touch'],context,zone,bars,zones,filters)
                reference=labs.evaluate(*args)
                fast=labs.evaluate(entry,event,investigation['touch'],context,zone,bars,checklist_zones,filters,index=index)
                self.assertEqual(reference,fast)
                exercised+=1
                if exercised>=30:return
        self.assertGreater(exercised,0)

if __name__=='__main__':unittest.main()
