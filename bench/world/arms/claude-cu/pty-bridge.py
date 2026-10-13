"""Give macOS script(1) a real terminal instead of Node's stdin socket."""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import tty
import time


def process_rows():
    # Metadata only, used to collect this bridge's own subtree.
    output = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,lstart=,stat='],
                                     text=True, timeout=1)
    rows = {}
    for line in output.splitlines():
        parts = line.split()
        if len(parts) == 8:
            rows[int(parts[0])] = (int(parts[1]), tuple(parts[2:7]), parts[7])
    return rows


class OwnedTree:
    def __init__(self, root):
        self.root = root
        self.known = {}
        self.refresh()

    def refresh(self):
        rows = process_rows()
        owned = {pid for pid, identity in self.known.items()
                 if pid in rows and rows[pid][1] == identity}
        if self.root in rows and (self.root not in self.known or self.root in owned):
            owned.add(self.root)
        while True:
            children = {pid for pid, row in rows.items() if row[0] in owned}
            if children <= owned:
                break
            owned |= children
        for pid in owned:
            self.known[pid] = rows[pid][1]
        return {pid for pid in owned if not rows[pid][2].startswith('Z')}

    def signal(self, value):
        for pid in self.refresh():
            try:
                os.kill(pid, value)
            except ProcessLookupError:
                pass

    def collect(self, child):
        self.signal(signal.SIGTERM)
        deadline = time.monotonic() + 0.5
        while self.refresh() and time.monotonic() < deadline:
            child.poll()
            time.sleep(0.05)
        self.signal(signal.SIGKILL)
        child.wait(timeout=1)
        deadline = time.monotonic() + 1
        while self.refresh() and time.monotonic() < deadline:
            time.sleep(0.05)
        return not self.refresh()


def write_all(fd, data):
    remaining = memoryview(data)
    while remaining:
        count = os.write(fd, remaining)
        if count <= 0:
            raise OSError('PTY write made no progress')
        remaining = remaining[count:]


def main():
    process_rows()
    master, slave = pty.openpty()
    tty.setraw(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 60, 180, 0, 0))
    child = None
    tree = None
    stopping = False

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        tree = OwnedTree(child.pid)
        os.close(slave)
        slave = None
        while not stopping and child.poll() is None:
            tree.refresh()
            ready, _, _ = select.select([master, 0], [], [], 0.05)
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                write_all(1, data)
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:
                    stopping = True
                    break
                write_all(master, data)
        if not stopping:
            return child.wait(timeout=2)
        return 130
    finally:
        os.close(master)
        if slave is not None:
            os.close(slave)
        if child is not None:
            try:
                if tree is None:
                    tree = OwnedTree(child.pid)
                if tree.collect(child):
                    print('[sleight-cu-cleanup:ok]', file=sys.stderr, flush=True)
                else:
                    raise RuntimeError('owned PTY descendants remain')
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=1)


if __name__ == '__main__':
    sys.exit(main())
