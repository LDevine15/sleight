import os
import sys

# Keep our exited child unreaped in its own process group until the test releases it.
pid = os.fork()
if pid == 0:
    os.setpgid(0, 0)
    os._exit(0)
try:
    print(pid, flush=True)
    sys.stdin.readline()
finally:
    os.waitpid(pid, 0)
