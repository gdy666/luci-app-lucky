"""Rules file integration tests, disposable localhost VM only."""
import argparse,io,json,tarfile,hashlib,time,shlex
from pathlib import Path
import paramiko
p=argparse.ArgumentParser();p.add_argument('--vm-port',type=int,required=True);args=p.parse_args()
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
for name in ['lucky_core.lua','lucky_rules.lua']:
 put('/usr/lib/lua/luci/'+name,(root/'luci-app-lucky/root/usr/lib/lua/luci'/name).read_bytes())
put('/usr/libexec/lucky-backup',(root/'luci-app-lucky/root/usr/libexec/lucky-backup').read_bytes())
cmd('chmod 755 /usr/libexec/lucky-backup')
original=cmd('cat /etc/config/lucky'); tokens=[]
directory=cmd('mktemp -d /tmp/lucky-rules-test.XXXXXX').decode().strip()
def opening(kind):
 r=call('rules-'+kind);tokens.append(r['token']);return r['token']
def saving(token,content,ok=True):
 put('/tmp/lucky-luci-backup/'+token+'/rules.json',json.dumps({'content':content}).encode());return call('rules-save',token,ok)
try:
 cmd('uci set lucky.@lucky[0].configdir='+shlex.quote(directory)+'; uci commit lucky')
 t=opening('localips');saving(t,'10.0.0.0/8\n2001:db8::/32\n192.168.2.1\n')
 assert cmd('cat '+directory+'/localips')==b'10.0.0.0/8\n2001:db8::/32\n192.168.2.1\n'
 for bad in ['example.com','1.2.3.999','192.168.001.1','10.0.0.0/33','::1/129','# unsupported comment','1.2.3.4:80']:
  t=opening('localips');saving(t,bad,False)
 t=opening('localips');put(directory+'/localips',b'external edit');saving(t,'10.0.0.0/8',False)
 cmd('rm '+directory+'/localips; ln -s /etc/passwd '+directory+'/localips');call('rules-localips',ok=False);cmd('rm '+directory+'/localips')
 t=opening('localips');cmd('uci set lucky.@lucky[0].configdir=/etc/config; uci commit lucky');saving(t,'10.0.0.0/8',False)
 cmd('uci set lucky.@lucky[0].configdir='+shlex.quote(directory)+'; uci commit lucky')
 # The VM retains a real 2.27.2 core: reject the unsupported allowlist version.
 call('rules-allowlist',ok=False)
 # Explicit version-boundary fixture; normal saves still verify actual binary identity.
 wrapper='/tmp/lucky-rules-version-test.lua'
 for version,allowed in [('3.0.9',False),('3.1.0',True),('3.10.0',True),('unknown',False)]:
  put(wrapper,('local c=require "luci.lucky_core"; c.version=function() return "'+version+'",c.fingerprint() end; dofile("/usr/libexec/lucky-backup")').encode())
  r=json.loads(cmd('lua '+wrapper+' rules-allowlist'));assert r['ok']==allowed,r
  if allowed:
   t=r['token'];tokens.append(t)
   saving(t,'# trusted peer\n192.0.2.1\n2001:db8::1\n')
   for invalid in ['192.0.2.0/24','example.com','fe80::1%eth0','192.0.2.1 # inline']:
    # fresh snapshot for each rejected write
    r=json.loads(cmd('lua '+wrapper+' rules-allowlist'));tokens.append(r['token']);saving(r['token'],invalid,False)
 print('PASS: rule files, IPv4/IPv6/CIDR validation, conflicts, symlinks, directory changes and version boundaries',flush=True)
finally:
 put('/etc/config/lucky',original)
 for t in tokens:call('cleanup',t)
 cmd('rm -f /tmp/lucky-rules-version-test.lua');c.close()
