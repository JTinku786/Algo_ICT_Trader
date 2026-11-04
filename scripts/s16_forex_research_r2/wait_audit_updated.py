import json,subprocess,sys,time
from pathlib import Path
if __name__=="__main__":
    root=Path(sys.argv[1]).resolve()
    while True:
        try:
            run=json.loads((root/"run_status.json").read_text())
            targets=json.loads((root/"targets_status.json").read_text())
        except (PermissionError,FileNotFoundError,json.JSONDecodeError):
            time.sleep(5);continue
        if run["status"] not in ("running","done"):raise RuntimeError("Replay failed")
        if run["status"]==targets["status"]=="done":break
        time.sleep(20)
    subprocess.run([sys.executable,str(Path(__file__).with_name("audit_updated.py")),str(root)],check=True)
