from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json,sys,time,os,threading,urllib.request,urllib.error
root=Path(__file__).resolve().parent
ports=json.loads((root/'ports.json').read_text())
model='deepseek-v4-flash'
endpoint='https://api.deepseek.com/v1/chat/completions'
def serve(name,port):
    state=dict(first=None,count=0,charged=0,body=0)
    lock=threading.Lock()
    record=root/name/'proxy.jsonl'
    def emit(**kw):
        with lock,record.open('a',encoding='utf8') as f: print(json.dumps(dict(t=time.time(),**kw),ensure_ascii=False),file=f)
    class Proxy(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def result(self,n,d):
            data=json.dumps(d).encode()
            self.send_response(n);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        def do_GET(self):
            self.result(200,dict(object='list',data=[dict(id=model,object='model')]))
        def do_POST(self):
            if self.path.split('?')[0].rstrip('/') not in ('/chat/completions','/v1/chat/completions'):
                return self.result(404,dict(error='Use chat/completions'))
            b=self.rfile.read(int(self.headers.get('Content-Length',0)))
            try: d=json.loads(b)
            except Exception: return self.result(400,dict(error='invalid json'))
            if d.get('model')!=model: return self.result(400,dict(error='benchmark model mismatch'))
            with lock:
                if state['first'] is None: state['first']=time.time()
                limit=min(4096,int(d.get('max_tokens') or d.get('max_completion_tokens') or 4096),24576-state['charged'])
                denied=limit<1 or state['count']>=24 or state['body']+len(b)>2500000 or time.time()-state['first']>=480
                if not denied:
                    state['count']+=1; n=state['count'];state['charged']+=limit;state['body']+=len(b)
            if denied:
                emit(kind='budget_stop');return self.result(429,dict(error=dict(message='benchmark budget exhausted')))
            d.pop('max_completion_tokens',None);d['max_tokens']=limit;d['thinking']={'type':'disabled'}
            if d.get('stream'): d['stream_options']={'include_usage':True}
            msgs=d.get('messages',[]);emit(kind='request',n=n,model=model,msgs=len(msgs),input_bytes=len(b),tools=[x.get('function',{}).get('name') for x in d.get('tools',[])],last_role=msgs[-1].get('role') if msgs else None)
            usage=None;calls={};reported=None;err=None
            def observe(obj):
                nonlocal usage,reported
                if obj.get('usage'): usage=obj['usage']
                if obj.get('model'): reported=obj['model']
                for choice in obj.get('choices',[]):
                    for idx,call in enumerate((choice.get('delta') or choice.get('message') or {}).get('tool_calls',[])):
                        c=calls.setdefault(call.get('index',idx),{'name':'','args':''});fn=call.get('function',{});c['name']+=fn.get('name') or '';c['args']=(c['args']+(fn.get('arguments') or ''))[:750]
            try:
                req=urllib.request.Request(endpoint,data=json.dumps(d).encode(),headers={'Authorization':'Bearer '+os.environ['DEEPSEEK_API_KEY'],'Content-Type':'application/json'})
                with urllib.request.urlopen(req,timeout=90) as resp:
                    self.send_response(200);self.send_header('Content-Type',resp.headers.get('Content-Type','application/json'));self.end_headers()
                    if d.get('stream'):
                        for line in resp:
                            if time.time()-state['first']>=480: break
                            if line.startswith(b'data:'):
                                try: observe(json.loads(line[5:]))
                                except ValueError: pass
                            self.wfile.write(line);self.wfile.flush()
                    else:
                        raw=resp.read();observe(json.loads(raw));self.wfile.write(raw)
            except urllib.error.HTTPError as e:
                err=e.read().decode(errors='replace')[:420];self.result(e.code,dict(error=dict(message=err)))
            except Exception as e:
                err=type(e).__name__
                try:self.result(502,dict(error=dict(message=err)))
                except OSError:pass
            finally:
                if usage and isinstance(usage.get('completion_tokens'),int):
                    with lock: state['charged']-=max(0,limit-usage['completion_tokens'])
                emit(kind='response',n=n,returned_model=reported,usage=usage,tools=list(calls.values()),error=err)
    server=ThreadingHTTPServer(('127.0.0.1',port),Proxy); server.serve_forever()
for name,port in ports.items(): threading.Thread(target=serve,args=(name,port),daemon=True).start()
print('proxy ready',flush=True)
threading.Event().wait()

