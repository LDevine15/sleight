"""Electron launch primitive, its host adapter and the pipe keeper. No shipped qualified recipes.

The trusted host supplies reviewed registry data. App approval and user-click Quit belong
to the broker host, not this module. There are two entry points. `--adapter` is started by the
resident host with the app's pipe ends on descriptors 3 and 4 and takes its registry path and
temporary root from the host's argv, never from a request. `--keeper` is started by the host with
duplicates of the host's own ends on descriptors 3 and 4 (see keep()).
"""
import base64
import ctypes
import ctypes.util
import errno
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import pwd
import select
import shutil
import socket
import stat
import struct
import sys
import tempfile
import time
import uuid


def recipe_for_build(registry, build):
    if registry.get('version') != 1:
        raise ValueError('unknown recipe format')
    matches = [r for r in registry.get('recipes', []) if r.get('build') == build]
    if len(matches) != 1:
        raise ValueError('isolation-unsupported: no unique reviewed build recipe')
    return matches[0]


MODES = ('temporary', 'user')
PROFILE_SWITCHES = ('--user-data-dir', '--extensions-dir', '--shared-data-dir')


def launch_args(recipe, mode='temporary'):
    """The recipe's arguments for a launch mode. 'temporary' is a separate instance on a temporary {profile} (benchmarks).
    'user' is the same build on the user's own profile (the relaunch flow): the recipe's reviewed userProfile arguments,
    which name no profile at all, so the app opens the profile it always opens."""
    if mode not in MODES:
        raise ValueError('unknown launch mode')
    if mode == 'user':
        profile = recipe.get('userProfile')
        if not isinstance(profile, dict):
            raise ValueError('recipe has no user profile')
        args = profile.get('args')
    else:
        args = recipe.get('args')
    if not isinstance(args, list) or not all(isinstance(arg, str) and '\0' not in arg for arg in args):
        raise ValueError('invalid recipe arguments')
    # Recipe review must establish complete isolation. This filter only catches
    # known dangerous switches; it does not claim a universal isolation sandbox.
    forbidden = ('--inspect', '--remote-debugging', '--no-sandbox', '--disable-web-security', '--ignore-certificate')
    if any(arg.lower().startswith(forbidden) for arg in args):
        raise ValueError('forbidden launch switch')
    if mode == 'user':
        if any('{' in arg or '}' in arg for arg in args) or any(arg.lower().startswith(PROFILE_SWITCHES) for arg in args):
            raise ValueError('a user-profile launch names no profile')
        return list(args)
    if not any('{profile}' in arg for arg in args):
        raise ValueError('recipe lacks isolated profile')
    if any('{' in arg.replace('{profile}', '') or '}' in arg.replace('{profile}', '') for arg in args):
        raise ValueError('unknown recipe substitution')
    return list(args)


def recipe_for(registry, build, mode='temporary'):
    if registry.get('version') != 1:
        raise ValueError('unknown recipe format')
    matches = [r for r in registry.get('recipes', []) if r.get('build') == build]
    if len(matches) != 1:
        raise ValueError('isolation-unsupported: no unique reviewed build recipe')
    recipe = matches[0]
    executable = Path(recipe['executable'])
    if not executable.is_absolute() or executable.is_symlink() or not executable.is_file():
        raise ValueError('executable identity changed')
    if hashlib.sha256(executable.read_bytes()).hexdigest() != recipe.get('sha256'):
        raise ValueError('build hash changed')
    launch_args(recipe, mode)
    return dict(recipe)


def high_fd(fd):
    try:
        return fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10)
    finally:
        os.close(fd)


# Process incarnation and census readers. A PID alone never names a process: the
# birth time separates a recycled PID from the app that was launched.
class _ProcTaskBsdInfo(ctypes.Structure):
    _fields_ = [('pbi_flags', ctypes.c_uint32), ('pbi_status', ctypes.c_uint32), ('pbi_xstatus', ctypes.c_uint32),
                ('pbi_pid', ctypes.c_uint32), ('pbi_ppid', ctypes.c_uint32), ('pbi_uid', ctypes.c_uint32),
                ('pbi_gid', ctypes.c_uint32), ('pbi_ruid', ctypes.c_uint32), ('pbi_rgid', ctypes.c_uint32),
                ('pbi_svuid', ctypes.c_uint32), ('pbi_svgid', ctypes.c_uint32), ('rfu_1', ctypes.c_uint32),
                ('pbi_comm', ctypes.c_char * 16), ('pbi_name', ctypes.c_char * 32), ('pbi_nfiles', ctypes.c_uint32),
                ('pbi_pgid', ctypes.c_uint32), ('pbi_pjobc', ctypes.c_uint32), ('e_tdev', ctypes.c_uint32),
                ('e_tpgid', ctypes.c_uint32), ('pbi_nice', ctypes.c_int32), ('pbi_start_tvsec', ctypes.c_uint64),
                ('pbi_start_tvusec', ctypes.c_uint64)]


class ProcessTable:
    """Birth and child readers. birth() returns a string, None for a process that does not
    exist, and raises OSError when the answer cannot be trusted (permission, unsupported OS)."""

    def __init__(self):
        self.libproc = None
        if sys.platform == 'darwin':
            name = ctypes.util.find_library('proc')
            if name:
                self.libproc = ctypes.CDLL(name, use_errno=True)

    @property
    def available(self):
        return self.libproc is not None or sys.platform.startswith('linux')

    def birth(self, pid):
        if not isinstance(pid, int) or pid <= 0:
            raise ValueError('invalid pid')
        if self.libproc is not None:
            info = _ProcTaskBsdInfo()
            ctypes.set_errno(0)
            size = self.libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
            if size == ctypes.sizeof(info) and info.pbi_pid == pid:
                if info.pbi_status == 5:  # SZOMB: the process is gone but not yet reaped.
                    return None
                return '%d.%06d' % (info.pbi_start_tvsec, info.pbi_start_tvusec)
            if ctypes.get_errno() in (errno.ESRCH, 0) and size == 0:
                return None
            raise OSError(ctypes.get_errno() or errno.EIO, 'process birth unreadable')
        if sys.platform.startswith('linux'):
            try:
                text = Path('/proc/%d/stat' % pid).read_text()
            except FileNotFoundError:
                return None
            fields = text[text.rindex(')') + 2:].split()
            if fields[0] == 'Z':
                return None
            return 'l' + fields[19]
        raise OSError(errno.ENOSYS, 'no process table reader on this platform')

    def children(self, pid):
        if self.libproc is not None:
            capacity = 1024
            buffer = (ctypes.c_int * capacity)()
            ctypes.set_errno(0)
            count = self.libproc.proc_listchildpids(pid, buffer, ctypes.sizeof(buffer))
            if count < 0:
                raise OSError(ctypes.get_errno() or errno.EIO, 'child list unreadable')
            if count >= capacity:
                raise OSError(errno.E2BIG, 'child list truncated')
            return [buffer[index] for index in range(count) if buffer[index] > 0]
        if sys.platform.startswith('linux'):
            found = []
            for entry in Path('/proc').iterdir():
                if entry.name.isdecimal():
                    try:
                        text = (entry / 'stat').read_text()
                    except OSError:
                        continue
                    fields = text[text.rindex(')') + 2:].split()
                    if int(fields[1]) == pid:
                        found.append(int(entry.name))
            return found
        raise OSError(errno.ENOSYS, 'no process table reader on this platform')


PROCESSES = ProcessTable()


def process_birth(pid):
    value = PROCESSES.birth(pid)
    if value is None:
        raise RuntimeError('process disappeared before its incarnation was read')
    return value


def live_descendants(roots, table=None, limit=512):
    """Every live descendant of the given live (pid, birth) pairs, as sorted (pid, birth) pairs.
    Raises OSError when the walk cannot be completed, so the census is never silently partial."""
    table = table or PROCESSES
    found, queue, seen = set(), [pid for pid, _ in roots], set(pid for pid, _ in roots)
    while queue:
        for child in table.children(queue.pop()):
            if child in seen:
                continue
            seen.add(child)
            birth = table.birth(child)
            if birth is not None:
                found.add((child, birth))
                queue.append(child)
            if len(seen) > limit:
                raise OSError(errno.E2BIG, 'process census too large')
    return sorted(found)


def census_absent(identities, table=None):
    """True only when every listed (pid, birth) is provably not running (the PID is free or
    belongs to a different incarnation) and no descendant of a live one remains."""
    table = table or PROCESSES
    live = []
    try:
        for pid, birth in identities:
            current = table.birth(pid)
            if current is not None and current == birth:
                live.append((pid, birth))
        if live:
            return False
        return True
    except (OSError, ValueError, RuntimeError):
        return False


class OwnedLaunch:
    # mode 'user': the root below is sleight's own launch record (owner marker only). The app gets no path inside it,
    # writes no log there, and keeps its own profile, which nothing here opens, copies or removes.
    def __init__(self, temporary_root, registry, build, mode='temporary'):
        self.recipe = recipe_for(registry, build, mode)
        self.mode = mode
        lock_key = hashlib.sha256(build.encode()).hexdigest()
        self.lock = Path(temporary_root).resolve() / ('sleight-ep2-lock-' + lock_key)
        self.lock.mkdir(mode=0o700)  # Existing ownership is never stolen.
        self.root = Path(tempfile.mkdtemp(prefix='sleight-ep2-', dir=temporary_root)).resolve()
        os.chmod(self.root, 0o700)
        self.nonce = uuid.uuid4().hex
        (self.lock / 'OWNER.json').write_text(json.dumps({'owner': self.nonce, 'profile': str(self.root)}))
        lock_status = self.lock.lstat()
        self.lock_identity = lock_status.st_dev, lock_status.st_ino
        owner_status = (self.lock / 'OWNER.json').lstat()
        self.lock_owner_identity = owner_status.st_dev, owner_status.st_ino
        self.marker = self.root / 'OWNER.json'
        self.root_identity = self.root.stat().st_dev, self.root.stat().st_ino
        self.pid = None
        self.identity = None
        self.reader = None
        self.writer = None
        self.launched = False
        self.wait_status = None
        self.observed = set()
        # These phases prove successful syscalls on this exact instance only.
        # A host crash still requires the host's durable ownership reconciliation.
        self.profile_removal_started = False
        self.profile_removed = False
        self.lock_owner_removed = False
        self.cleanup_result = None
        self.recovered = False
        self.record('reserved')

    @classmethod
    def recover(cls, temporary_root, registry, build, nonce):
        """Rebuild ownership after the process that created it is gone.

        Nothing here is trusted from a journal alone. The build lock directory, its owner
        file and the profile root must still be the same inodes the original launch wrote
        into the profile marker, and all three must name this nonce. Any mismatch raises,
        and the ownership stays unresolved. collect() then still needs a complete census."""
        recipe = dict(recipe_for_build(registry, build))
        self = object.__new__(cls)
        self.recipe = recipe
        self.mode = 'temporary'
        lock_key = hashlib.sha256(build.encode()).hexdigest()
        self.lock = Path(temporary_root).resolve() / ('sleight-ep2-lock-' + lock_key)
        lock_status = self.lock.lstat()
        if not stat.S_ISDIR(lock_status.st_mode):
            raise RuntimeError('lock directory identity changed')
        owner_path = self.lock / 'OWNER.json'
        owner_status = owner_path.lstat()
        if not stat.S_ISREG(owner_status.st_mode):
            raise RuntimeError('lock owner changed')
        owner = json.loads(owner_path.read_text())
        if not isinstance(owner, dict) or owner.get('owner') != nonce or not isinstance(owner.get('profile'), str):
            raise RuntimeError('lock owner changed')
        root = Path(owner['profile'])
        if root.parent != Path(temporary_root).resolve() or not root.name.startswith('sleight-ep2-'):
            raise RuntimeError('profile root outside the reserved temporary directory')
        root_status = root.lstat()
        if not stat.S_ISDIR(root_status.st_mode):
            raise RuntimeError('profile root identity changed')
        marker = root / 'OWNER.json'
        marker_status = marker.lstat()
        if not stat.S_ISREG(marker_status.st_mode):
            raise RuntimeError('profile owner changed')
        data = json.loads(marker.read_text())
        if not isinstance(data, dict) or data.get('owner') != nonce or data.get('build') != build or \
                data.get('lock') != str(self.lock) or data.get('root') != str(root):
            raise RuntimeError('profile owner changed')
        if data.get('lockIdentity') != [lock_status.st_dev, lock_status.st_ino] or \
                data.get('rootIdentity') != [root_status.st_dev, root_status.st_ino] or \
                data.get('lockOwnerIdentity') != [owner_status.st_dev, owner_status.st_ino]:
            raise RuntimeError('recorded inode identity does not match the directories found')
        self.root = root
        self.marker = marker
        self.nonce = nonce
        self.mode = data.get('mode') if data.get('mode') in MODES else 'temporary'
        self.lock_identity = lock_status.st_dev, lock_status.st_ino
        self.lock_owner_identity = owner_status.st_dev, owner_status.st_ino
        self.root_identity = root_status.st_dev, root_status.st_ino
        self.pid = data.get('pid') if isinstance(data.get('pid'), int) else None
        self.identity = data.get('identity') if isinstance(data.get('identity'), str) else None
        self.reader = None
        self.writer = None
        self.launched = True
        self.wait_status = None
        observed = set()
        for item in data.get('observed') or []:
            if isinstance(item, list) and len(item) == 2 and isinstance(item[0], int) and isinstance(item[1], str):
                observed.add((item[0], item[1]))
        self.observed = observed
        self.profile_removal_started = False
        self.profile_removed = False
        self.lock_owner_removed = False
        self.cleanup_result = None
        self.recovered = True
        return self

    def record(self, phase):
        if self.cleanup_result is not None:
            raise RuntimeError('collected ownership is terminal')
        # The inode bindings let a restarted host prove that the directories it finds
        # are the ones this launch created, not look-alikes (see recover()).
        data = {'owner': self.nonce, 'phase': phase, 'pid': self.pid, 'identity': self.identity,
                'observed': sorted(self.observed), 'build': self.recipe['build'], 'lock': str(self.lock),
                'root': str(self.root), 'lockIdentity': list(self.lock_identity), 'rootIdentity': list(self.root_identity),
                'lockOwnerIdentity': list(self.lock_owner_identity), 'mode': self.mode}
        # The exact private root is owned before any process can start.
        temporary = self.root / '.owner-next'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.marker)

    def spawn(self, identity_reader, adopted=None):
        # adopted=(read_fd, write_fd) are the child's end of two pipes that the resident
        # host created. The host keeps the parent ends, so no worker, adapter or
        # restart of this process closes the app's last writer.
        if self.launched or self.cleanup_result is not None:
            raise RuntimeError('retained or collected ownership prevents another spawn')
        if self.recovered:
            raise RuntimeError('recovered ownership never spawns')
        # Recheck executable immediately before spawn, not only at reservation.
        recipe_for({'version': 1, 'recipes': [self.recipe]}, self.recipe['build'], self.mode)
        user = self.mode == 'user'
        self.launched = True
        self.record('spawning')
        descriptors = []
        try:
            if adopted is not None:
                if len(adopted) != 2 or any(not isinstance(fd, int) or fd < 3 for fd in adopted):
                    raise ValueError('invalid adopted pipe descriptors')
                child_read, child_write = [high_fd(fd) for fd in adopted]
                descriptors.extend([child_read, child_write])
            else:
                for _ in range(2):
                    a, b = os.pipe()
                    descriptors.extend([high_fd(a), high_fd(b)])
                child_read, self.writer, self.reader, child_write = descriptors
            devnull = high_fd(os.open(os.devnull, os.O_RDWR))
            descriptors.append(devnull)
            # The user's own app logs nothing into sleight's folder: what it prints may name the user's files.
            log = high_fd(os.open(os.devnull, os.O_WRONLY) if user else os.open(self.root / 'child.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
            descriptors.append(log)
            actions = [(os.POSIX_SPAWN_DUP2, child_read, 3),
                       (os.POSIX_SPAWN_DUP2, child_write, 4)]
            actions += [(os.POSIX_SPAWN_DUP2, devnull, 0)]
            actions += [(os.POSIX_SPAWN_DUP2, log, fd) for fd in (1, 2)]
            # Close inherited host descriptors too, including non-CLOEXEC ones.
            # /dev/fd enumerates this process's own descriptors, not other apps.
            opened = set(descriptors)
            for name in os.listdir('/dev/fd'):
                if name.isdecimal() and int(name) > 4:
                    try:
                        os.fstat(int(name))
                        opened.add(int(name))
                    except OSError:
                        pass
            actions += [(os.POSIX_SPAWN_CLOSE, fd) for fd in sorted(opened)]
            args = [str(self.recipe['executable'])]
            if user:
                args += launch_args(self.recipe, 'user')
            else:
                args += [arg.replace('{profile}', str(self.root)) for arg in self.recipe['args']]
            args.append('--remote-debugging-pipe')
            # No HOME rewrite, NODE_OPTIONS, CLAUDE env or live-profile copy.
            environment = {'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8'}
            if user:
                # The account's own home and names, as a normal launch has them, so the app finds its own profile.
                account = pwd.getpwuid(os.getuid())
                environment.update({'HOME': account.pw_dir, 'USER': account.pw_name, 'LOGNAME': account.pw_name, 'SHELL': account.pw_shell})
            if user:
                # The user's own app gets a session of its own, as a normal launch has, so a signal to sleight's process
                # group never reaches it.
                try:
                    self.pid = os.posix_spawn(args[0], args, environment, file_actions=actions, setsid=True)
                except NotImplementedError:
                    self.pid = os.posix_spawn(args[0], args, environment, file_actions=actions, setpgroup=0)
            else:
                self.pid = os.posix_spawn(args[0], args, environment, file_actions=actions)
            os.close(child_read); descriptors.remove(child_read)
            os.close(child_write); descriptors.remove(child_write)
            os.close(devnull); descriptors.remove(devnull)
            os.close(log); descriptors.remove(log)
            self.identity = identity_reader(self.pid)
            if not isinstance(self.identity, str) or not self.identity:
                raise RuntimeError('PID incarnation unavailable; retain ownership')
            self.record('spawned')
            return self.pid, self.reader, self.writer
        except BaseException:
            # Once spawn may have happened, the app's writer must survive errors.
            for fd in descriptors:
                if self.pid is None or fd not in (self.reader, self.writer):
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            self.record('launch-uncertain')
            raise

    def poll(self):
        if self.pid is None or self.wait_status is not None or self.recovered:
            return self.wait_status
        pid, status = os.waitpid(self.pid, os.WNOHANG)
        if pid:
            self.wait_status = status
            self.record('parent-collected')
        return self.wait_status

    def observe(self, identities):
        if self.cleanup_result is not None:
            raise RuntimeError('collected ownership is terminal')
        # Reader must report PID incarnations, including previously seen orphans.
        for pid, birth in identities:
            if not isinstance(pid, int) or pid <= 0 or not isinstance(birth, str) or not birth:
                raise ValueError('invalid observed identity')
            self.observed.add((pid, birth))
        self.record('observed')

    def collect(self, census):
        # No signals: the host uses the app's own Quit on the user's click.
        if self.cleanup_result is not None:
            return dict(self.cleanup_result)
        if self.pid is not None and not self.recovered and self.poll() is None:
            return {'cleanup': 'retained', 'reason': 'owned parent has not exited'}
        identities = set(self.observed)
        if self.pid is not None:
            if self.identity is None:
                return {'cleanup': 'retained', 'reason': 'parent identity missing'}
            identities.add((self.pid, self.identity))
        if census(identities) is not True:
            return {'cleanup': 'retained', 'reason': 'descendant census incomplete or processes remain'}
        try:
            lock_owner = self.lock / 'OWNER.json'

            def check_lock():
                status = self.lock.lstat()
                if not stat.S_ISDIR(status.st_mode) or (status.st_dev, status.st_ino) != self.lock_identity:
                    raise RuntimeError('lock directory identity changed')
                if self.lock_owner_removed:
                    if os.path.lexists(lock_owner):
                        raise RuntimeError('removed lock owner was replaced')
                else:
                    status = lock_owner.lstat()
                    if not stat.S_ISREG(status.st_mode) or (status.st_dev, status.st_ino) != self.lock_owner_identity or \
                            json.loads(lock_owner.read_text()) != {'owner': self.nonce, 'profile': str(self.root)}:
                        raise RuntimeError('lock owner changed')

            check_lock()
            if not self.profile_removed:
                status = self.root.lstat()
                if not stat.S_ISDIR(status.st_mode) or (status.st_dev, status.st_ino) != self.root_identity:
                    raise RuntimeError('profile root identity changed')
                if os.path.lexists(self.marker):
                    if not stat.S_ISREG(self.marker.lstat().st_mode) or json.loads(self.marker.read_text())['owner'] != self.nonce:
                        raise RuntimeError('profile owner changed')
                elif not self.profile_removal_started:
                    raise RuntimeError('profile owner missing before removal')
                # A partial rmtree may remove its marker. The same root inode,
                # original lock and this instance's prior verification still
                # permit a retry; only a successful rmtree proves removal.
                self.profile_removal_started = True
                shutil.rmtree(self.root)
                self.profile_removed = True
            if os.path.lexists(self.root):
                raise RuntimeError('removed profile root was replaced')
            check_lock()
            # Keep the build lock until every owned descriptor is closed too.
            for attribute in ('reader', 'writer'):
                fd = getattr(self, attribute)
                if fd is not None:
                    os.close(fd)
                    setattr(self, attribute, None)
            check_lock()
            if not self.lock_owner_removed:
                lock_owner.unlink()
                self.lock_owner_removed = True
            check_lock()
            self.lock.rmdir()
        except (OSError, ValueError, KeyError, RuntimeError) as error:
            return {'cleanup': 'retained', 'reason': str(error)}
        self.cleanup_result = {'cleanup': 'removed', 'parentStatus': self.wait_status}
        return dict(self.cleanup_result)


MAX_REQUEST = 1024 * 1024


def _identity_list(value):
    if not isinstance(value, list) or len(value) > 512:
        raise ValueError('invalid identity list')
    result = []
    for item in value:
        if not isinstance(item, list) or len(item) != 2 or not isinstance(item[0], int) or isinstance(item[0], bool) \
                or item[0] <= 0 or not isinstance(item[1], str) or not item[1] or len(item[1]) > 64:
            raise ValueError('invalid observed identity')
        result.append((item[0], item[1]))
    return result


class Adapter:
    """Request handler behind `--adapter`. One owned launch at a time; never launches by itself."""

    def __init__(self, registry, temporary_root, table=None):
        self.registry = registry
        self.temporary_root = temporary_root
        self.table = table or PROCESSES
        self.launch = None
        self.exit_reported = False

    def census(self, identities):
        return census_absent(identities, self.table)

    def inspect(self):
        launch = self.launch
        if launch is None or launch.pid is None or launch.identity is None:
            raise RuntimeError('no launched parent to inspect')
        if not launch.recovered:
            launch.poll()
        current = self.table.birth(launch.pid)
        parent = {'pid': launch.pid, 'birth': launch.identity} if current == launch.identity else None
        roots = [(launch.pid, launch.identity)] if parent else []
        roots += [(pid, birth) for pid, birth in launch.observed if self.table.birth(pid) == birth]
        descendants = live_descendants(roots, self.table)
        fresh = [item for item in descendants if item not in launch.observed]
        if fresh:
            launch.observe(fresh)
        return {'parent': parent, 'descendants': [{'pid': pid, 'birth': birth} for pid, birth in descendants], 'complete': True}

    def handle(self, request):
        command = request.get('cmd')
        if command == 'reserve':
            if self.launch is not None and self.launch.cleanup_result is None:
                raise RuntimeError('retained ownership prevents another reservation')
            self.exit_reported = False
            build, mode = request.get('build'), request.get('mode', 'temporary')
            if not isinstance(build, str) or not build or len(build) > 256:
                raise ValueError('invalid build')
            if mode not in MODES:
                raise ValueError('unknown launch mode')
            self.launch = OwnedLaunch(self.temporary_root, self.registry, build, mode)
            return {'nonce': self.launch.nonce, 'root': str(self.launch.root), 'lock': str(self.launch.lock)}
        if command == 'lockstate':
            build = request.get('build')
            if not isinstance(build, str) or not build or len(build) > 256:
                raise ValueError('invalid build')
            return lock_state(self.temporary_root, build)
        if command == 'recover':
            # A recovered launch may be recovered again, so each reconciliation checks the disk evidence afresh.
            if self.launch is not None and self.launch.cleanup_result is None and not self.launch.recovered:
                raise RuntimeError('an ownership is already held')
            nonce, build = request.get('nonce'), request.get('build')
            if not isinstance(nonce, str) or not nonce or len(nonce) > 128 or not isinstance(build, str) or not build or len(build) > 256:
                raise ValueError('invalid recovery request')
            self.launch = OwnedLaunch.recover(self.temporary_root, self.registry, build, nonce)
            launch = self.launch
            return {'nonce': launch.nonce, 'pid': launch.pid, 'identity': launch.identity,
                    'observed': [list(item) for item in sorted(launch.observed)]}
        launch = self.launch
        if launch is None:
            raise RuntimeError('no reserved ownership')
        if command == 'spawn':
            for fd in (3, 4):
                os.fstat(fd)
            pid, _, _ = launch.spawn(process_birth, adopted=(3, 4))
            return {'pid': pid, 'birth': launch.identity}
        if command == 'observe':
            launch.observe(_identity_list(request.get('identities')))
            return {}
        if command == 'inspect':
            return self.inspect()
        if command == 'confirmAbsent':
            return {'absent': self.census(_identity_list(request.get('identities')))}
        if command == 'collect':
            return launch.collect(self.census)
        raise ValueError('unknown command')

    def exit_event(self):
        launch = self.launch
        if launch is None or self.exit_reported or launch.recovered or launch.pid is None:
            return None
        if launch.poll() is None:
            return None
        self.exit_reported = True
        return {'event': 'exit', 'status': launch.wait_status}


def lock_state(temporary_root, build):
    """Read-only look at the build lock and its profile, for the host's reconciliation."""
    lock = Path(temporary_root).resolve() / ('sleight-ep2-lock-' + hashlib.sha256(build.encode()).hexdigest())
    try:
        status = lock.lstat()
    except FileNotFoundError:
        return {'exists': False}
    result = {'exists': True, 'directory': stat.S_ISDIR(status.st_mode), 'nonce': None, 'profile': None, 'phase': None}
    try:
        owner = json.loads((lock / 'OWNER.json').read_text())
        result['nonce'] = owner.get('owner') if isinstance(owner.get('owner'), str) else None
        result['profile'] = owner.get('profile') if isinstance(owner.get('profile'), str) else None
        if result['profile']:
            marker = json.loads((Path(result['profile']) / 'OWNER.json').read_text())
            result['phase'] = marker.get('phase') if isinstance(marker.get('phase'), str) else None
            result['markerNonce'] = marker.get('owner') if isinstance(marker.get('owner'), str) else None
    except (OSError, ValueError, AttributeError):
        pass
    return result


def _read_frame(buffer):
    index = buffer.find(b'\0')
    if index < 0:
        if len(buffer) > MAX_REQUEST:
            raise ValueError('request too large')
        return None, buffer
    if index > MAX_REQUEST:
        raise ValueError('request too large')
    return buffer[:index], buffer[index + 1:]


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def serve(argv, adapter_factory=Adapter):
    options = dict(zip(argv[0::2], argv[1::2]))
    if set(options) != {'--registry', '--temp-root'}:
        raise SystemExit('adapter requires exactly --registry and --temp-root')
    registry = json.loads(Path(options['--registry']).read_text())
    adapter = adapter_factory(registry, options['--temp-root'])
    buffer = b''
    while True:
        ready = select.select([0], [], [], 0.2)[0]
        event = adapter.exit_event()
        if event is not None:
            _write_all(1, json.dumps(event).encode() + b'\0')
        if not ready:
            continue
        chunk = os.read(0, 65536)
        if not chunk:
            return 0  # The host is gone. Ownership stays on disk; nothing is closed or killed here.
        buffer += chunk
        while True:
            try:
                raw, buffer = _read_frame(buffer)
            except ValueError:
                return 1
            if raw is None:
                break
            request_id = None
            try:
                request = json.loads(raw.decode('utf-8'))
                if not isinstance(request, dict) or not isinstance(request.get('id'), int):
                    raise ValueError('invalid request')
                request_id = request['id']
                reply = {'id': request_id, 'ok': True, 'result': adapter.handle(request)}
            except BaseException as error:
                if isinstance(error, (KeyboardInterrupt, SystemExit)):
                    raise
                reply = {'id': request_id, 'ok': False, 'error': type(error).__name__ + ': ' + str(error)[:200]}
            _write_all(1, json.dumps(reply).encode() + b'\0')


# --- The pipe keeper ---------------------------------------------------------------------------
# Electron quits when its debugging pipe reads EOF, and on the user's own profile that can skip its unsaved-work prompt.
# The keeper holds duplicates of the host's ends (descriptor 3 writes to the app, 4 reads from it), so the app's pipe
# stays open when the host dies. While the host lives (descriptor 0 open) the keeper reads nothing. After that it drains
# what the app sends, and one restarted host that proves the launch's key attaches through the socket: the keeper then
# relays the stream both ways. It never passes a descriptor, and it exits once the app is gone.
KEEPER_VERSION = 1
KEEPER_BARRIER = 2147483646  # the keeper's own command ids; a host's ids stay below 2**30
KEEPER_TARGETS = 2147483645
KEEPER_DETACH = 2147483644
KEEPER_BUFFER = 16 * 1024 * 1024
KEEPER_FRAME = 256 * 1024 * 1024
TOKEN = set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_')


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _token_ok(value, low=22, high=128):
    return isinstance(value, str) and low <= len(value) <= high and set(value) <= TOKEN


def keeper_proof(key, role, nonce, challenge, client_nonce):
    return _b64(hmac.new(key, '\0'.join(['sleight-keeper-v1', role, nonce, challenge, client_nonce]).encode(), hashlib.sha256).digest())


def peer_uid(connection):
    if hasattr(socket, 'SO_PEERCRED'):
        return struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))[1]
    if hasattr(socket, 'LOCAL_PEERCRED'):
        # struct xucred: cr_version, then cr_uid.
        return struct.unpack_from('I', connection.getsockopt(0, socket.LOCAL_PEERCRED, 76), 4)[0]
    raise OSError(errno.ENOSYS, 'peer credentials unavailable')


def keeper_listener(path):
    """The keeper's socket, in the host's private state directory and readable only by this user."""
    if not os.path.isabs(path) or os.path.normpath(path) != path or len(path.encode()) > 100:
        raise ValueError('keeper socket path unsafe')
    parent = os.lstat(os.path.dirname(path))
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError('keeper directory unsafe')
    try:
        existing = os.lstat(path)
    except FileNotFoundError:
        existing = None
    if existing is not None:
        if not stat.S_ISSOCK(existing.st_mode):
            raise ValueError('keeper socket path unsafe')
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(path)
            raise RuntimeError('another keeper holds this socket')
        except (ConnectionRefusedError, FileNotFoundError):
            os.unlink(path)  # a keeper that was killed left it
        finally:
            probe.close()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    mask = os.umask(0o177)
    try:
        listener.bind(path)
    finally:
        os.umask(mask)
    os.chmod(path, 0o600)
    listener.listen(4)
    listener.setblocking(False)
    status = os.lstat(path)
    return listener, (status.st_dev, status.st_ino)


class AppGone(Exception):
    pass


class Keeper:
    def __init__(self, key, nonce, listener, table=None):
        self.key, self.nonce, self.listener = key, nonce, listener
        self.table = table or PROCESSES
        self.host = True          # descriptor 0, the spawning host's link, is open
        self.control = b''
        self.app = None           # (pid, birth), from the host after the spawn
        self.attached = None
        self.to_app = bytearray()     # complete frames only
        self.partial = b''            # the start of an attached host's next frame
        self.to_host = bytearray()

    def read_app(self):
        try:
            chunk = os.read(4, 65536)
        except BlockingIOError:
            return b''
        if not chunk:
            raise AppGone()
        return chunk

    def write_app(self):
        try:
            del self.to_app[:os.write(3, self.to_app)]
        except BlockingIOError:
            pass
        except (BrokenPipeError, ConnectionResetError):
            raise AppGone()

    def host_lost(self):
        self.host = False
        for fd in (3, 4):  # only this process uses these ends now
            fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)
        self.release_sessions()

    def release_sessions(self):
        """Detaches the sessions the dead host left. A page it was attached to would otherwise keep new frames waiting for a
        debugger that is gone (auto-attach waits for one). Only this pipe's own sessions can be named: a detach by target
        that finds none, or several, is refused by the app and changes nothing."""
        deadline = time.monotonic() + 5
        if self.barrier(deadline) is None:
            return
        answer = self.ask({'id': KEEPER_TARGETS, 'method': 'Target.getTargets'}, deadline)
        targets = answer[0].get('result', {}).get('targetInfos', []) if answer else []
        for info in targets if isinstance(targets, list) else []:
            if isinstance(info, dict) and info.get('attached') is True and isinstance(info.get('targetId'), str):
                self.to_app += json.dumps({'id': KEEPER_DETACH, 'method': 'Target.detachFromTarget', 'params': {'targetId': info['targetId']}}).encode() + b'\0'

    def control_line(self):
        try:
            chunk = os.read(0, 4096)
        except BlockingIOError:
            return
        if not chunk:
            self.host_lost()
            return
        self.consume(chunk)

    def consume(self, chunk):
        self.control = (self.control + chunk)[-8192:]
        while b'\n' in self.control:
            line, self.control = self.control.split(b'\n', 1)
            try:
                app = json.loads(line).get('app')
                if isinstance(app, dict) and isinstance(app.get('pid'), int) and isinstance(app.get('birth'), str):
                    self.app = (app['pid'], app['birth'])
            except (ValueError, AttributeError):
                pass

    def app_alive(self):
        if self.app is None:
            return True
        try:
            return self.table.birth(self.app[0]) == self.app[1]
        except (OSError, ValueError):
            return True  # an unreadable answer is not proof the app is gone

    def detach(self):
        try:
            self.attached.close()
        except OSError:
            pass
        self.attached, self.partial, self.to_host = None, b'', bytearray()

    def attached_lost(self):
        self.detach()
        self.release_sessions()  # that host's sessions went with it, as the first host's did

    def barrier(self, deadline):
        """Resynchronises the app's stream. A dead host may have left half a frame in either direction: the keeper's own
        command ends any half frame in the app's input (it is sent again after a second), and everything the app sends up to
        its reply is discarded. Returns what followed the reply, or None."""
        answer = self.ask({'id': KEEPER_BARRIER, 'method': 'Browser.getVersion'}, deadline, resend=True)
        return answer[1] if answer else None

    def ask(self, message, deadline, resend=False):
        """Sends one of the keeper's own commands and discards the app's output up to its reply. Returns (reply, rest)."""
        command = json.dumps(message).encode() + b'\0'
        self.to_app += command
        resent, marker = time.monotonic() + 1 if resend else deadline, str(message['id']).encode()
        buffer, scanned = bytearray(), 0
        while time.monotonic() < deadline:
            if time.monotonic() >= resent and len(self.to_app) == 0:
                self.to_app, resent = bytearray(command), deadline
            readable, writable, _ = select.select([4], [3] if self.to_app else [], [], 0.1)
            if writable:
                self.write_app()
            if not readable:
                continue
            buffer += self.read_app()
            while True:
                end = buffer.find(0, scanned)
                if end < 0:
                    scanned = len(buffer)
                    break
                raw = bytes(buffer[:end])
                del buffer[:end + 1]
                scanned = 0
                if marker in raw:
                    try:
                        reply = json.loads(raw)
                    except ValueError:
                        continue
                    if isinstance(reply, dict) and reply.get('id') == message['id'] and 'result' in reply:
                        return reply, bytes(buffer)
            if len(buffer) > KEEPER_FRAME:
                buffer, scanned = bytearray(), 0
        return None

    def accept(self):
        try:
            connection, _ = self.listener.accept()
        except BlockingIOError:
            return
        try:
            # One host at a time, never beside the host that started this keeper, and only this user.
            if self.host or self.attached is not None or peer_uid(connection) != os.getuid():
                connection.close()
                return
            connection.setblocking(True)
            connection.settimeout(2)
            challenge = _b64(os.urandom(32))
            connection.sendall(json.dumps({'t': 'keeper', 'v': KEEPER_VERSION, 'nonce': self.nonce, 'challenge': challenge}).encode() + b'\0')
            frame = b''
            while b'\0' not in frame:
                chunk = connection.recv(4096)
                if not chunk or len(frame) > 4096:
                    raise ValueError('no attach frame')
                frame += chunk
            message = json.loads(frame.split(b'\0', 1)[0])
            if not isinstance(message, dict) or sorted(message) != ['cn', 'proof', 't'] or message['t'] != 'attach' or \
                    not _token_ok(message['cn']) or not isinstance(message['proof'], str) or \
                    not hmac.compare_digest(message['proof'].encode(), keeper_proof(self.key, 'attach', self.nonce, challenge, message['cn']).encode()):
                raise ValueError('attach refused')
            rest = self.barrier(time.monotonic() + 5)
            if rest is None:
                raise ValueError('the app did not answer')
            connection.sendall(json.dumps({'t': 'ready', 'pid': os.getpid(),
                                           'proof': keeper_proof(self.key, 'keeper', self.nonce, challenge, message['cn'])}).encode() + b'\0')
            connection.setblocking(False)
            self.attached, self.to_host = connection, bytearray(rest)
        except AppGone:
            raise
        except Exception:  # whatever a caller sends ends only its own connection
            connection.close()

    def step(self):
        reads, writes = [self.listener], []
        if self.host:
            reads.append(0)
        else:
            if len(self.to_host) < KEEPER_BUFFER:
                reads.append(4)
            if self.attached is not None:
                if len(self.to_app) < KEEPER_BUFFER:
                    reads.append(self.attached)
                if self.to_host:
                    writes.append(self.attached)
            if self.to_app:
                writes.append(3)
        readable, writable, _ = select.select(reads, writes, [], 1.0)
        if 0 in readable:
            self.control_line()
        if 4 in readable:
            chunk = self.read_app()
            if self.attached is not None:
                self.to_host += chunk  # without a host, drained and dropped
        if 3 in writable:
            self.write_app()
        if self.attached is not None and self.attached in readable:
            try:
                chunk = self.attached.recv(65536)
            except BlockingIOError:
                chunk = None
            except OSError:
                chunk = b''
            if chunk == b'':
                self.attached_lost()
            elif chunk:
                # Only whole frames reach the app, so a host that dies mid-frame leaves nothing half-written.
                self.partial += chunk
                end = self.partial.rfind(b'\0')
                if end >= 0:
                    self.to_app += self.partial[:end + 1]
                    self.partial = self.partial[end + 1:]
                if len(self.partial) > KEEPER_FRAME:
                    self.attached_lost()
        if self.attached is not None and self.attached in writable:
            try:
                del self.to_host[:self.attached.send(self.to_host)]
            except BlockingIOError:
                pass
            except OSError:
                self.attached_lost()
        if self.listener in readable:
            self.accept()
        if not self.app_alive():
            raise AppGone()

    def run(self):
        # Only the app's end closing ends the keeper. Anything else that goes wrong drops the attached host, if any, and the
        # keeper goes on holding the pipe: exiting would close it under the app.
        try:
            while True:
                try:
                    self.step()
                except AppGone:
                    raise
                except Exception:
                    if self.attached is not None:
                        self.detach()
                    time.sleep(0.05)
        except AppGone:
            return 0
        finally:
            if self.attached is not None:
                self.detach()


def keep(argv, table=None):
    """`launch.py --keeper --socket PATH`. Descriptor 0: the host's link; its first line is {"key", "nonce"} (the key in
    base64url, at least 32 bytes) and later lines may name the app, {"app": {"pid", "birth"}}. 1: one ready line, then
    closed. 3 and 4: duplicates of the host's ends of the app's pipe."""
    options = dict(zip(argv[0::2], argv[1::2]))
    if len(argv) != 2 or set(options) != {'--socket'}:
        raise SystemExit('keeper requires exactly --socket')
    for fd in (3, 4):
        os.fstat(fd)
    line, deadline = b'', time.monotonic() + 10
    while b'\n' not in line:
        if not select.select([0], [], [], max(0.0, deadline - time.monotonic()))[0]:
            return 1
        chunk = os.read(0, 4096)
        if not chunk or len(line) > 4096:
            return 1
        line += chunk
    first, rest = line.split(b'\n', 1)
    setup = json.loads(first)
    key = base64.urlsafe_b64decode(setup['key'] + '=' * (-len(setup['key']) % 4))
    if len(key) < 32 or not _token_ok(setup.get('nonce'), 8):
        return 1
    listener, identity = keeper_listener(options['--socket'])
    keeper = Keeper(key, setup['nonce'], listener, table)
    keeper.consume(rest)
    try:
        _write_all(1, json.dumps({'ready': True, 'pid': os.getpid()}).encode() + b'\n')
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, 1)
        os.close(devnull)
        return keeper.run()
    finally:
        listener.close()
        try:
            status = os.lstat(options['--socket'])
            if (status.st_dev, status.st_ino) == identity:
                os.unlink(options['--socket'])
        except OSError:
            pass


if __name__ == '__main__' and sys.argv[1:2] == ['--adapter']:
    raise SystemExit(serve(sys.argv[2:]))
if __name__ == '__main__' and sys.argv[1:2] == ['--keeper']:
    raise SystemExit(keep(sys.argv[2:]))
