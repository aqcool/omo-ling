"""No-inference smoke test against an explicit OpenCode binary and package directory."""
import argparse, base64, json, os, pathlib, secrets, selectors, sqlite3, subprocess, tempfile, time, urllib.parse, urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--cli', required=True)
parser.add_argument('--package', default=str(pathlib.Path(__file__).resolve().parent))
args = parser.parse_args()
real_db = pathlib.Path.home()/'.local/share/opencode/opencode.db'
def count_real():
    if not real_db.exists(): return None
    with sqlite3.connect(real_db.as_uri()+'?mode=ro', uri=True) as db:
        return db.execute('select count(*) from session').fetchone()[0]
before = count_real()
with tempfile.TemporaryDirectory(prefix='omo-ling-qa-') as temporary:
    root = pathlib.Path(temporary)
    for name in ['home','config/opencode','data','state','cache','workspace']:
        (root/name).mkdir(parents=True, exist_ok=True)
    (root/'workspace/proof.txt').write_text('omo-ling local fixture\n')
    config = {'plugins':[str(pathlib.Path(args.package).resolve())], 'update':'disable','instructions':[]}
    (root/'config/opencode/opencode.json').write_text(json.dumps(config))
    password = secrets.token_hex(24)
    env = {'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(root/'home'),
           'OPENCODE_TEST_HOME':str(root/'home'),'OPENCODE_CONFIG_DIR':str(root/'config/opencode'),
           'OPENCODE_SERVER_PASSWORD':password,'OPENCODE_DISABLE_AUTOUPDATE':'1',
           'OPENCODE_LOG_LEVEL':'debug'}
    for name in ['CONFIG','DATA','STATE','CACHE']: env[f'XDG_{name}_HOME']=str(root/name.lower())
    with (root/'stderr.log').open('w+') as log:
        proc = subprocess.Popen([args.cli,'serve','--stdio','--hostname','127.0.0.1','--port','0'],
            env=env,cwd=root/'workspace',stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
        try:
            ready=selectors.DefaultSelector();ready.register(proc.stdout,selectors.EVENT_READ)
            assert ready.select(20), 'host startup timed out'
            url=json.loads(proc.stdout.readline())['url']
            def api(path, data=None):
                path+='?'+urllib.parse.urlencode({'location[directory]':str(root/'workspace')})
                req=urllib.request.Request(url.rstrip('/')+path, data=None if data is None else json.dumps(data).encode(),
                    headers={'Content-Type':'application/json','Authorization':'Basic '+base64.b64encode(('opencode:'+password).encode()).decode()})
                with urllib.request.urlopen(req,timeout=25) as result:return json.load(result)
            def rpc(group,method,value={}):
                out=api('/api/rpc/'+group+'/'+method,{'input':value})
                return out.get('data',out).get('output',out.get('data',out))
            deadline=time.monotonic()+20
            while True:
                plugins=api('/api/plugin')
                active=[p for p in plugins['data'] if p.get('id')=='omo-ling' and p.get('state',{}).get('status')=='active']
                failed=[p for p in plugins['data'] if p.get('state',{}).get('status')=='failed']
                if active or failed or time.monotonic()>=deadline: break
                time.sleep(0.1)
            assert len(active)==1, plugins
            agents=rpc('omo.agents','list')
            expected={'sisyphus','hephaestus','oracle','librarian','explore','multimodal-looker','metis','momus','atlas','sisyphus-junior'}
            assert expected <= {a['id'] for a in agents['agents'] if a['hasSystem']},agents
            session=api('/api/session',{'title':'omo-ling isolated QA','location':{'directory':str(root/'workspace')}})
            sid=session['data']['id']
            todos=[{'id':'qa','content':'isolated metadata roundtrip','status':'pending'}]
            written=rpc('omo.orch','todoWrite',{'sessionID':sid,'todos':todos})
            assert written['ok'] and written['count']==1, written
            read=rpc('omo.orch','todoRead',{'sessionID':sid})
            assert read['ok'] and read['todos']==todos,read
            missing=rpc('omo.orch','todoRead',{'sessionID':'ses_missing_qa'})
            assert missing['ok'] is False,missing
            glob=rpc('omo.tools','invoke',{'tool':'glob','input':{'pattern':'*.txt'}})
            assert glob['ok'] and 'proof.txt' in glob['content'],glob
            activity=rpc('omo.orch','activity')
            assert any(e['detail']=='hosting-context' for e in activity['activity']),activity
            assert not list((root/'state').rglob('service.json')), 'unexpected global service discovery'
            assert not list((root/'config').rglob('service.json')), 'unexpected global daemon'
            print(json.dumps({'plugin':'omo-ling','state':'active','host':subprocess.check_output([args.cli,'--version'],env=env,text=True).strip(),
                'plugin_agents':len(expected),
                'todo_roundtrip':True,'missing_session_reports_error':True,'glob':True,
                'private_host_without_global_service':True,'real_model_requests':0,
                'real_session_count_before':before,'real_session_count_after':count_real()},indent=2))
            assert count_real()==before,'real profile changed during QA'
        finally:
            proc.stdin.close()
            try:proc.wait(timeout=10)
            except subprocess.TimeoutExpired:proc.terminate();proc.wait(timeout=5)
