"""Real native host + local deterministic model; no real profile or model credentials."""
import argparse, base64, http.server, json, os, pathlib, secrets, selectors, sqlite3, subprocess, tempfile, threading, time, urllib.parse, urllib.request, urllib.error

parser=argparse.ArgumentParser()
parser.add_argument('--cli',required=True)
parser.add_argument('--package',default=str(pathlib.Path(__file__).parent.resolve()/'dist'))
args=parser.parse_args()
requests=[]
events=[]
edit_checks=[]
phase='idle'
phase_calls=0
class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_POST(self):
        global phase_calls
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append({'path':self.path,'body':body,'phase':phase})
        phase_calls+=1
        tool=None
        tool_names=[t.get('name',t.get('function',{}).get('name')) for t in body.get('tools',[])]
        if phase=='memory' and phase_calls==1:
            tool=('memory',{'command':'create','reason':'User explicitly asked to remember the project convention','file_path':'system/project.md','description':'Project QA convention','file_text':'The project marker is LING_MEMORY_PROOF_42.'})
        elif phase=='complete' and phase_calls==2: tool=('update_goal',{'status':'complete'})
        elif phase=='create' and phase_calls==1: tool=('create_goal',{'objective':'QA_TOOL_GOAL'})
        elif phase=='create' and phase_calls==2: tool=('get_goal',{})
        elif phase=='create' and phase_calls==3: tool=('update_goal',{'status':'paused'})
        if phase=='hold': time.sleep(2)
        if tool:
            match=[n for n in tool_names if n==tool[0] or n.endswith('_'+tool[0]) or n.endswith('.'+tool[0])]
            if not match and 'execute' in tool_names:
                assert 'tools.'+tool[0]+'(' in body.get('instructions',''),tool[0]
                tool=('execute',{'code':'return await tools.'+tool[0]+'('+json.dumps(tool[1])+')'})
            else:
                assert len(match)==1,(tool[0],tool_names)
                tool=(match[0],tool[1])
        text='QA local response'
        call='call_'+str(len(requests))
        if '/responses' in self.path:
            item={'type':'function_call','id':'fc_'+call,'call_id':call,'name':tool[0],'arguments':json.dumps(tool[1]),'status':'completed'} if tool else {'type':'message','id':'msg_'+call,'role':'assistant','content':[{'type':'output_text','text':text,'annotations':[]}],'status':'completed'}
            result={'id':'resp_'+call,'object':'response','created_at':int(time.time()),'model':'gpt-fake','status':'completed','output':[item],'usage':{'input_tokens':10,'output_tokens':5,'input_tokens_details':{'cached_tokens':0},'output_tokens_details':{'reasoning_tokens':0}}}
            events=[{'type':'response.created','response':dict(result,status='in_progress',output=[])}, {'type':'response.output_item.added','output_index':0,'item':dict(item,arguments='') if tool else dict(item,content=[])}]
            if tool: events.append({'type':'response.function_call_arguments.delta','item_id':item['id'],'output_index':0,'delta':item['arguments']})
            else: events.append({'type':'response.output_text.delta','item_id':item['id'],'output_index':0,'content_index':0,'delta':text})
            events += [{'type':'response.output_item.done','output_index':0,'item':item},{'type':'response.completed','response':result}]
        else:
            delta={'role':'assistant','tool_calls':[{'index':0,'id':call,'type':'function','function':{'name':tool[0],'arguments':json.dumps(tool[1])}}]} if tool else {'role':'assistant','content':text}
            events=[{'id':call,'object':'chat.completion.chunk','model':'gpt-fake','created':int(time.time()),'choices':[{'index':0,'delta':delta,'finish_reason':None}]}, {'id':call,'object':'chat.completion.chunk','model':'gpt-fake','created':int(time.time()),'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls' if tool else 'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':5,'total_tokens':15}}]
        try:
            self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
            for event in events:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError,ConnectionResetError):pass
model=http.server.ThreadingHTTPServer(('127.0.0.1',0),Model)
threading.Thread(target=model.serve_forever,daemon=True).start()
real_db=pathlib.Path.home()/'.local/share/opencode/opencode.db'
def count_real():
    if not real_db.exists():return None
    with sqlite3.connect(real_db.as_uri()+'?mode=ro',uri=True) as db:return db.execute('select count(*) from session').fetchone()[0]
before=count_real()
def wait(check, label, timeout=20):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        value=check()
        if value:return value
        time.sleep(.05)
    raise AssertionError('Timed out: '+label)
def set_phase(value):
    global phase,phase_calls
    phase=value;phase_calls=0
with tempfile.TemporaryDirectory(prefix='omo-goal-memory-') as tmp:
    root=pathlib.Path(tmp)
    for name in ['home','config/opencode','data','cache','state','workspace']:(root/name).mkdir(parents=True,exist_ok=True)
    config={'plugins':[{'package':str(pathlib.Path(args.package).resolve()),'options':{'goal':{'default_max_iterations':2},'memory':{'graph':False}}}], 'model':'fixture/gpt-fake','update':'disable','instructions':[], 'permissions':[{'action':'*','resource':'*','effect':'allow'}],
      'providers':{'fixture':{'canonical':'openai','settings':{'baseURL':f'http://127.0.0.1:{model.server_port}/v1','apiKey':'isolated-fake-key','transport':'http','encoding':'none'},'models':{'gpt-fake':{'capabilities':{'tools':True},'limit':{'context':200000,'output':8192}}}}}}
    (root/'config/opencode/opencode.json').write_text(json.dumps(config))
    password=secrets.token_hex(24)
    env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(root/'home'),'OPENCODE_TEST_HOME':str(root/'home'),'OPENCODE_CONFIG_DIR':str(root/'config/opencode'),'OPENCODE_SERVER_PASSWORD':password,'OPENCODE_DISABLE_AUTOUPDATE':'1','OMO_LING_MEMORY_HOME':str(root/'memory')}
    for name in ['CONFIG','DATA','CACHE','STATE']:env['XDG_'+name+'_HOME']=str(root/name.lower())
    proc=None
    log=(root/'host.log').open('w+')
    def start():
        global proc,url
        proc=subprocess.Popen([args.cli,'serve','--stdio','--hostname','127.0.0.1','--port','0'],cwd=root/'workspace',env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
        ready=selectors.DefaultSelector();ready.register(proc.stdout,selectors.EVENT_READ)
        assert ready.select(20),'host startup timeout'
        url=json.loads(proc.stdout.readline())['url'].rstrip('/')
        wait(lambda:any(p.get('id')=='omo-ling' and p.get('state',{}).get('status')=='active' for p in api('/api/plugin')['data']), 'plugin active')
        connected=threading.Event()
        def watch():
            req=urllib.request.Request(url+'/api/event',headers={'Authorization':'Basic '+base64.b64encode(('opencode:'+password).encode()).decode()})
            try:
                with urllib.request.urlopen(req,timeout=25) as stream:
                    connected.set()
                    for line in stream:
                        if line.startswith(b'data:'):
                            event=json.loads(line[5:]);events.append({'type':event.get('type'),'sessionID':event.get('data',{}).get('sessionID')})
            except (OSError,ValueError):pass
        threading.Thread(target=watch,daemon=True).start()
        assert connected.wait(5),'SSE did not connect'
    def stop():
        if proc and proc.poll() is None:
            proc.stdin.close()
            try:proc.wait(timeout=8)
            except subprocess.TimeoutExpired:proc.terminate();proc.wait(timeout=5)
    def api(path,data=None,allow_error=False):
        query=urllib.parse.urlencode({'location[directory]':str(root/'workspace')})
        req=urllib.request.Request(url+path+'?'+query,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json','Authorization':'Basic '+base64.b64encode(('opencode:'+password).encode()).decode()})
        try:
            with urllib.request.urlopen(req,timeout=25) as response:
                raw=response.read();return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            body=e.read().decode()
            if allow_error:return {'status':e.code,'body':body}
            raise AssertionError((path,e.code,body)) from e
    def rpc(group,method,input):
        out=api('/api/rpc/'+group+'/'+method,{'input':input});out=out.get('data',out)
        return out.get('output',out)
    def new():return api('/api/session',{'title':'QA no title generation','location':{'directory':str(root/'workspace')}})['data']['id']
    def command(sid,name,text):return api('/api/session/'+sid+'/command',{'name':name,'text':text})
    def goal(sid):return rpc('omo.goal','get',{'sessionID':sid})['goal']
    def edit(sid,snapshot,objective):return rpc('omo.goal','edit',{'sessionID':sid,'objective':objective,'expectedObjective':snapshot['objective'],'expectedCreatedAt':snapshot['createdAt']})['goal']
    def rejected_edit(sid,snapshot,objective,label,error_type):
        response=api('/api/rpc/omo.goal/edit',{'input':{'sessionID':sid,'objective':objective,'expectedObjective':snapshot['objective'],'expectedCreatedAt':snapshot['createdAt']}},allow_error=True)
        assert isinstance(response,dict) and response.get('status',0)>=400,(label,response)
        assert json.loads(response['body'])['type']==error_type,(label,response)
        edit_checks.append({'case':label,'response':response})
    def terminal(sid):return api('/api/experimental/session/'+sid+'/wait',{})
    try:
        start()
        commands=api('/api/command')['data']; assert {'goal','memory'}<={c['name'] for c in commands},commands
        sid=new()
        command(sid,'memory','status'); command(sid,'goal','status')
        assert len(requests)==0,'status commands started a model'
        set_phase('memory')
        api('/api/session/'+sid+'/prompt',{'text':'Remember this project convention for future sessions.'})
        terminal(sid)
        saved=rpc('omo.memory','read',{'command':'read','file_path':'system/project.md'})
        assert 'LING_MEMORY_PROOF_42' in saved['text'],saved
        assert any('tools.memory(' in r['body'].get('instructions','') for r in requests),'memory tool not exposed'
        set_phase('recall'); sid2=new()
        api('/api/session/'+sid2+'/prompt',{'text':'Read the project convention.'});terminal(sid2)
        assert any('LING_MEMORY_PROOF_42' in json.dumps(r['body'].get('instructions',r['body'].get('messages',r['body'].get('input')))) for r in requests if r['phase']=='recall'),'committed memory not injected'
        set_phase('limit'); goal_sid=new(); command(goal_sid,'goal','QA_BOUNDED_GOAL')
        wait(lambda:goal(goal_sid)['status']=='paused','goal iteration cap')
        assert goal(goal_sid)['reason']=='iteration_limit' and goal(goal_sid)['iterations']==2,goal(goal_sid)
        assert phase_calls==2,phase_calls
        snapshot=goal(goal_sid); count=len(requests)
        edited=edit(goal_sid,snapshot,'QA_EDITED_GOAL')
        assert edited['objective']=='QA_EDITED_GOAL',edited
        for key in ['createdAt','status','reason','iterations','maxIterations','tokensUsed','timeUsedSeconds','lastEvent']:
            assert edited[key]==snapshot[key],(key,edited,snapshot)
        assert 'runningSince' not in edited,edited
        rejected_edit(goal_sid,snapshot,'QA_STALE_GOAL','stale_objective','goal.conflict')
        rejected_edit(goal_sid,edited,'  ','empty_objective','rpc.invalid_input')
        rejected_edit(sid2,edited,'QA_WRONG_SESSION','missing_goal_other_session','goal.not_found')
        rejected_edit('ses_missing_qa',edited,'QA_MISSING_SESSION','missing_native_session','rpc.internal')
        assert goal(sid2) is None and goal(goal_sid)==edited,'failed edits mutated goal'
        assert len(requests)==count,'editing paused goal started model work'
        edit_checks.append({'case':'paused_edit','goal':edited,'extra_model_requests':len(requests)-count})
        set_phase('complete'); command(goal_sid,'goal','resume')
        wait(lambda:goal(goal_sid)['status']=='complete','tool completes goal')
        terminal(goal_sid)
        finished=goal(goal_sid);assert finished['tokensUsed']>0,finished
        assert any('QA_EDITED_GOAL' in json.dumps(r['body'].get('instructions',r['body'].get('messages',r['body'].get('input')))) for r in requests if r['phase']=='complete'),'edited goal not injected into subsequent context'
        count=len(requests);complete_edit=edit(goal_sid,finished,'QA_COMPLETED_EDIT')
        assert complete_edit['status']=='complete' and len(requests)==count,complete_edit
        set_phase('hold'); edit_sid=new(); command(edit_sid,'goal','QA_ACTIVE_EDIT')
        wait(lambda:phase_calls==1,'request before active edit')
        active=wait(lambda:goal(edit_sid) if goal(edit_sid).get('runningSince') else None,'running snapshot')
        active_edit=edit(edit_sid,active,'QA_ACTIVE_EDITED')
        assert active_edit['status']=='active' and active_edit['runningSince']==active['runningSince'],active_edit
        assert active_edit['timeUsedSeconds']==active['timeUsedSeconds'] and phase_calls==1,'edit changed live accounting or started model work'
        wait(lambda:goal(edit_sid)['status']=='paused','edited goal reaches original limit')
        assert phase_calls==2,'edit added an execution round'
        assert 'runningSince' not in goal(edit_sid),goal(edit_sid)
        assert any('QA_ACTIVE_EDITED' in json.dumps(r['body'].get('instructions',r['body'].get('messages',r['body'].get('input')))) for r in requests if r['phase']=='hold'),'active edit missing from later context'
        edit_checks.append({'case':'active_edit','goal':goal(edit_sid),'rounds_after_edit':phase_calls,'running_snapshot':active_edit})
        command(edit_sid,'goal','clear');set_phase('hold');command(edit_sid,'goal','QA_ACTIVE_EDIT')
        wait(lambda:phase_calls==1,'recreated goal execution')
        rejected_edit(edit_sid,active,'QA_OLD_EDITOR','deleted_and_recreated_goal','goal.conflict')
        command(edit_sid,'goal','pause');terminal(edit_sid)
        time.sleep(2.1)
        set_phase('create'); tools_sid=new()
        api('/api/session/'+tools_sid+'/prompt',{'text':'Explicitly create a goal QA_TOOL_GOAL and pause it.'});terminal(tools_sid)
        assert goal(tools_sid)['status']=='paused',goal(tools_sid)
        set_phase('hold'); stop_sid=new(); command(stop_sid,'goal','QA_INTERRUPTED_GOAL')
        wait(lambda:phase_calls>0,'request before interruption')
        command(stop_sid,'goal','pause'); assert goal(stop_sid)['status']=='paused'
        terminal(stop_sid)
        time.sleep(2.1)
        assert phase_calls==1,'paused goal resumed or left a queued model request'
        set_phase('hold'); crash_sid=new(); command(crash_sid,'goal','QA_RESTART_ACTIVE')
        wait(lambda:phase_calls>0,'active request before crash')
        proc.kill();proc.wait(timeout=5);time.sleep(2.1)
        count=len(requests);set_phase('idle');start()
        assert goal(crash_sid)['status']=='paused',goal(crash_sid)
        assert goal(goal_sid)['status']=='complete' and goal(stop_sid)['status']=='paused'
        assert 'LING_MEMORY_PROOF_42' in rpc('omo.memory','read',{'command':'read','file_path':'system/project.md'})['text']
        command(stop_sid,'goal','status');command(stop_sid,'memory','search LING_MEMORY_PROOF_42')
        assert len(requests)==count,'restart or status silently resumed work'
        command(tools_sid,'goal','clear');assert goal(tools_sid) is None
        assert count_real()==before,'real profile was modified'
        observed={e['type'] for e in events}
        assert {'session.execution.started','session.execution.succeeded','session.execution.interrupted'} <= observed,observed
        print(json.dumps({'host':'2.0.32','goal_commands':True,'memory_commands':True,'memory_tool_write':True,'cross_session_injection':True,'goal_continuation_and_limit':True,'goal_tools_create_get_update':True,'goal_edit_checks':edit_checks,'goal_edit_context_injection':True,'goal_interrupt':True,'goal_complete_tokens':finished['tokensUsed'],'restart_persistence_no_autorun':True,'native_sse_execution_events':sorted(e for e in observed if e.startswith('session.execution.')),'local_model_requests':len(requests),'real_model_requests':0,'real_session_count_before':before,'real_session_count_after':count_real()},indent=2))
    except Exception:
        log.flush();log.seek(0)
        print('DIAGNOSTIC',json.dumps({'requests':[(r['path'],r['phase'],r['body'].get('input')) for r in requests], 'host_tail':log.read()[-7000:]}))
        raise
    finally:stop();log.close();model.shutdown()
