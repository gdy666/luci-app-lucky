"""Destructive core maintenance tests, disposable localhost VM only."""
import argparse,io,json,tarfile,hashlib,time,shlex
from pathlib import Path
import paramiko
p=argparse.ArgumentParser();p.add_argument('--vm-port',type=int,required=True);p.add_argument('--archive',type=Path);args=p.parse_args()
c=paramiko.SSHClient();c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:c.connect('127.0.0.1',port=args.vm_port,username='root',password='',allow_agent=False,look_for_keys=False)
except paramiko.AuthenticationException:c.get_transport().auth_none('root')
def cmd(s,check=True):
 i,o,e=c.exec_command(s);v=o.read();err=e.read();code=o.channel.recv_exit_status();i.close();o.close();e.close()
 if check:assert code==0,(s,err)
 return v
def put(path,b):
 i,o,e=c.exec_command('cat > '+shlex.quote(path));i.write(b);i.flush();i.channel.shutdown_write();assert o.channel.recv_exit_status()==0;i.close();o.close();e.close()
def call(op,t=None,ok=True):
 r=json.loads(cmd('/usr/libexec/lucky-backup '+op+(' '+t if t else '')));assert r['ok']==ok,r;return r
root=Path(__file__).resolve().parent.parent
for name in ['root/usr/libexec/lucky-backup','root/usr/lib/lua/luci/lucky_core.lua']:
 put('/'+name.removeprefix('root/'),(root/'luci-app-lucky'/name).read_bytes())
cmd('chmod 755 /usr/libexec/lucky-backup')
core=cmd('cat /usr/bin/lucky');original_uci=cmd('cat /etc/config/lucky');was_running=bool(cmd('pidof lucky',False).strip());tokens=[]
def prepare():
 t=call('core-prepare')['token'];tokens.append(t);return t
def archive(binary,extra=None):
 b=io.BytesIO()
 with tarfile.open(fileobj=b,mode='w:gz',format=tarfile.PAX_FORMAT) as t:
  h=tarfile.TarInfo('lucky');h.size=len(binary);h.mode=0o755;h.pax_headers={'mtime':'1700000000.123'};t.addfile(h,io.BytesIO(binary))
  if extra:
   h=tarfile.TarInfo(extra);h.size=8;t.addfile(h,io.BytesIO(b'ignored!'))
 return b.getvalue()
def upload(t,data):put('/tmp/lucky-luci-backup/'+t+'/core.tar.gz',data)
try:
 # Test the private version probe independently of ELF validation.
 put('/tmp/lucky-core-probe-test.lua',b'local c=require "luci.lucky_core"; for i=1,20 do local k,v=debug.getupvalue(c.install,i); if k=="probe" then local ok,r=pcall(v,arg[1],"/tmp"); print(require("luci.jsonc").stringify({ok=ok,result=tostring(r)})); return end end; error("probe not found")')
 for body,expected in [(b'echo \'{"Version":"test"}\'',True),(b'head -c 20000 /dev/zero',False),(b'exit 42',False),(b'sleep 20',False)]:
  put('/tmp/lucky-core-probe-test.sh',b'#!/bin/sh\n'+body+b'\n');cmd('chmod 700 /tmp/lucky-core-probe-test.sh')
  result=json.loads(cmd('lua /tmp/lucky-core-probe-test.lua /tmp/lucky-core-probe-test.sh'))
  assert result['ok']==expected,result
 print('PASS: version pipe accepts JSON, rejects oversized output, exit failure and timeout',flush=True)
 assert call('core-status')['status']=='ready'
 cmd('chmod 644 /usr/bin/lucky');assert call('core-status')['status']=='permissions'
 assert call('core-fix')['status']=='ready';assert cmd('cat /usr/bin/lucky')==core
 print('PASS: detect and repair execute permission without changing core bytes',flush=True)
 t=prepare();upload(t,archive(core,'scripts/ignored-service'))
 info=call('core-check',t);assert info['bytes'] and 'version' not in info;call('core-install',t)
 assert cmd('cat /usr/bin/lucky')==core and cmd('cat /etc/config/lucky')==original_uci
 assert bool(cmd('pidof lucky',False).strip())==was_running
 print('PASS: real Lucky ELF PAX tar.gz validates, installs, preserves config and service state',flush=True)
 before=cmd('pidof lucky',False).strip()
 wrong=bytearray(core);wrong[18:20]=b'\xb7\x00'
 for data in [archive(bytes(wrong)),archive(b'#!/bin/sh\nexit 0\n'),archive(core,'../outside'),archive(core)[:-5],b'not gzip']:
  x=prepare();upload(x,data);call('core-check',x,False);call('core-install',x,False)
  assert cmd('cat /usr/bin/lucky')==core and cmd('pidof lucky',False).strip()==before
  call('cleanup',x);tokens.remove(x)
 print('PASS: wrong architecture, scripts, unsafe paths, damaged gzip rejected before stop',flush=True)
 # A runtime probe failure must happen after stop and restore the old service.
 wrapper='/tmp/lucky-core-rename-test.lua'
 put(wrapper,b'local c=require "luci.lucky_core"; for i=1,30 do local k=debug.getupvalue(c.install,i); if k=="probe" then debug.setupvalue(c.install,i,function() assert(os.execute("pidof lucky >/dev/null")~=0,"probe ran before stop"); error("injected probe failure") end); break end end; dofile("/usr/libexec/lucky-backup")')
 r=json.loads(cmd('lua '+wrapper+' core-install '+t));assert not r['ok'] and 'injected probe failure' in r['error'],r
 assert cmd('cat /usr/bin/lucky')==core and bool(cmd('pidof lucky',False).strip())==was_running
 print('PASS: runtime validation happens after stop; failed probe restores old service',flush=True)
 # Force the second rename to fail to prove old binary is restored.
 wrapper='/tmp/lucky-core-rename-test.lua'
 put(wrapper,b'local f=require "nixio.fs"; local r=f.rename; f.rename=function(a,b) if a:find("/.lucky-new-",1,true) then return nil end return r(a,b) end; dofile("/usr/libexec/lucky-backup")')
 r=json.loads(cmd('lua '+wrapper+' core-install '+t));assert not r['ok'],r
 assert cmd('cat /usr/bin/lucky')==core
 assert bool(cmd('pidof lucky',False).strip())==was_running
 print('PASS: failed binary rename rolls back old executable',flush=True)
 # Simulate a new core failing its service start, then allow rollback startup.
 put(wrapper,b'local core=require "luci.lucky_core"; local count=0; local ok,err=pcall(core.install,arg[1],arg[2],function() os.execute("/etc/init.d/lucky stop"); for i=1,100 do if os.execute("pidof lucky >/dev/null")~=0 then return true end; require("nixio").nanosleep(0,100000000) end; error("stop timed out") end,function() count=count+1; if count==1 then return false end; return os.execute("/etc/init.d/lucky start")==0 end,function() return os.execute("pidof lucky >/dev/null")==0 end); print(require("luci.jsonc").stringify({ok=ok,error=tostring(err)}))')
 r=json.loads(cmd('lua '+wrapper+' /tmp/lucky-luci-backup/'+t+' '+t));assert not r['ok'] and 'failed to start' in r['error'],r
 assert cmd('cat /usr/bin/lucky')==core
 print('PASS: service-start failure restores previous core',flush=True)
 cmd('/etc/init.d/lucky stop');cmd('rm /usr/bin/lucky')
 assert call('core-status')['status']=='missing';call('core-fix',ok=False)
 # Start a fresh upload with no existing core; preparing/checking must not
 # depend on information from the executable that the upload is repairing.
 t=prepare();upload(t,archive(core));info=call('core-check',t)
 assert info['bytes']==len(core) and not cmd('pidof lucky',False).strip()
 call('core-install',t);assert cmd('cat /usr/bin/lucky')==core;assert not cmd('pidof lucky',False).strip()
 print('PASS: fresh upload prepares, checks and repairs a missing core; stopped service remains stopped',flush=True)
 cmd('rm /usr/bin/lucky; ln -s /bin/busybox /usr/bin/lucky')
 assert call('core-status')['status']=='unsafe';call('core-fix',ok=False);call('core-install',t,False)
 print('PASS: symlink core rejected',flush=True)
 if args.archive:
  for expired in list(tokens):call('cleanup',expired);tokens.remove(expired)
  # Give the newer core its own empty configuration directory, preserving fixtures.
  cmd('rm /usr/bin/lucky');put('/usr/bin/lucky',core);cmd('chmod 755 /usr/bin/lucky')
  isolated=cmd('mktemp -d /tmp/lucky-core-config.XXXXXX').decode().strip()
  cmd('uci set lucky.@lucky[0].configdir='+shlex.quote(isolated)+'; uci commit lucky')
  cmd('/etc/init.d/lucky start');assert cmd('pidof lucky',False).strip()
  payload=args.archive.read_bytes()
  with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as package:
   member=next(m for m in package.getmembers() if m.name.removeprefix('./')=='lucky')
   expected=hashlib.sha256(package.extractfile(member).read()).hexdigest()
  for attempt in range(2):
   t=prepare();upload(t,payload);before=cmd('pidof lucky',False).strip();call('core-check',t)
   assert cmd('pidof lucky',False).strip()==before
   info=call('core-install',t)
   assert hashlib.sha256(cmd('cat /usr/bin/lucky')).hexdigest()==expected
   assert info['running'] and cmd('pidof lucky',False).strip()
   print('PASS: supplied release archive installed byte-for-byte and restarted: '+info['version'],flush=True)
   call('cleanup',t);tokens.remove(t)
finally:
 cmd('/etc/init.d/lucky stop',False);cmd('rm -f /usr/bin/lucky');put('/usr/bin/lucky',core);cmd('chmod 755 /usr/bin/lucky');put('/etc/config/lucky',original_uci)
 if was_running:cmd('/etc/init.d/lucky start')
 for t in tokens:call('cleanup',t)
 cmd('rm -f /tmp/lucky-core-rename-test.lua /tmp/lucky-core-probe-test.lua /tmp/lucky-core-probe-test.sh');c.close()
