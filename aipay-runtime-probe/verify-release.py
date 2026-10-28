import hashlib,json,pathlib
runtime=pathlib.Path.home()/'.local/share/alipay-bot-cli/runtime'
lock=json.loads((pathlib.Path(__file__).parent/'release-lock.json').read_text())
for name,expected in lock['files'].items():
    p=runtime/name
    if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=expected:
        raise SystemExit('Official release content differs from reviewed lock: '+name)
print('Reviewed official CLI release content verified')
