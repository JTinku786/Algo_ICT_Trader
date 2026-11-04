"""Record an explicit verified performance-only policy compatibility allowlist.

Run before changing any active detector/runner source. This is not a generic
cache fallback: exact old config + snapshot + dataset hashes remain mandatory.
"""
import sys as _rs, os as _ro; _rs.path.insert(0, _ro.path.dirname(_ro.path.abspath(__file__))); from reports_dir import REPORTS, SCALPING_BACKTEST  # noqa: E402
import json
from scalping_backtest_runner import OUT,policy_fingerprint,freeze_config,json_write
if __name__=='__main__':
    snap=json.loads((OUT/'input-snapshot.json').read_text(encoding='utf-8'))
    inventory=json.loads((OUT/'coverage-inventory.json').read_text(encoding='utf-8'))
    symbols=sorted({(r['market'],r['symbol']) for r in inventory if r['table']=='historical_candles_5m'})
    previous=json.loads((OUT/'performance-compatible-policies.json').read_text(encoding='utf-8')) if (OUT/'performance-compatible-policies.json').exists() else {'policies':[]}
    for market,symbol in symbols:
        config={**freeze_config(market,symbol,snap['start'],snap['end']),'snapshotAt':snap['snapshotAt']}
        digest,hashes=policy_fingerprint(config,7)
        record={'market':market,'symbol':symbol,'fingerprint':digest,'config':config,'chunkDays':7,'engineHashes':hashes,'compatibility':'Only verified equivalent scanner, compact archive, and first-hit index performance changes. No signal or exit policy changes permitted.','proofs':['public/reports/scalping-labs/backtest/fast-scanner-validation.json','public/reports/scalping-labs/backtest/fast-scanner-full-detector-validation.json','scripts/test_scalping_backtest_compact.py']}
        if not any(p['fingerprint']==digest for p in previous['policies']):previous['policies'].append(record)
    json_write(OUT/'performance-compatible-policies.json',previous)
    print(f'Recorded {len(previous["policies"])} explicit prior policy fingerprints')
