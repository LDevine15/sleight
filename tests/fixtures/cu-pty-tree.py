"""Exercise only owned fake PTY children, with an eight-second leaf lifetime."""
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time


def main():
    mode, marker = sys.argv[1:3]
    if mode == 'leaf':
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        end = time.monotonic() + 8
        while time.monotonic() < end:
            with open(marker, 'a') as out:
                out.write('x')
            time.sleep(0.05)
        return
    if mode in ('parent', 'exit-parent'):
        subprocess.Popen([sys.executable, __file__, 'leaf', marker],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
        while not Path(marker).exists():
            time.sleep(0.01)
        print('READY', flush=True)
        time.sleep(1 if mode == 'exit-parent' else 9)
        return
    bridge = sys.argv[3]
    parent = 'exit-parent' if mode == 'natural' else 'parent'
    child = subprocess.Popen([sys.executable, bridge, '/usr/bin/script', '-q', '/dev/null',
                              sys.executable, __file__, parent, marker],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        end, output = time.monotonic() + 4, b''
        while b'READY' not in output and time.monotonic() < end:
            if selector.select(0.1):
                output += os.read(child.stdout.fileno(), 4096)
        selector.close()
        if b'READY' not in output:
            raise AssertionError('owned fake child did not start')
        if mode == 'cancel':
            child.stdin.close()
            child.stdin = None
        _, errors = child.communicate(timeout=6)
        before = Path(marker).stat().st_size
        time.sleep(0.25)
        if Path(marker).stat().st_size != before:
            raise AssertionError('owned descendant survived bridge exit')
        if b'[sleight-cu-cleanup:ok]' not in errors:
            raise AssertionError('no confirmed cleanup receipt')
    finally:
        if child.poll() is None:
            child.stdin.close()
            child.wait(timeout=10)
        # A regressed bridge leaves a leaf; its own deadline cleans it up.
        if Path(marker).exists():
            size = Path(marker).stat().st_size
            time.sleep(0.1)
            if Path(marker).stat().st_size != size:
                time.sleep(8)


if __name__ == '__main__':
    main()
