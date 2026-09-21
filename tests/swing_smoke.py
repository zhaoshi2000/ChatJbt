"""Java desktop integration on Linux with Xvfb; requires JDK and xvfb-run."""
import os,subprocess
from integration import Backend,ROOT
b=Backend('mock')
try:
    subprocess.run(['javac','--release','21','-encoding','UTF-8','-cp',str(ROOT/'out/client.jar'),'-d',str(ROOT/'out/tests'),str(ROOT/'tests/SwingSmoke.java')],check=True)
    env={**os.environ,'PORT':str(b.port),'DATA_DIR':str(b.data),'PROVIDER':'mock'}
    subprocess.run(['xvfb-run','-a','java','-cp',str(ROOT/'out/client.jar')+os.pathsep+str(ROOT/'out/tests'),'SwingSmoke'],cwd=ROOT,env=env,check=True,timeout=30)
    assert b.call('GET','/health',auth=False)[0]==200
    print('PASS: closing native UI did not stop the Java backend',flush=True)
finally:b.close()
