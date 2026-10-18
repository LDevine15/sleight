"""A pipe-only fake, never imports or launches Electron or an app."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import stat
import sys
import tempfile
import time
from unittest.mock import patch

# The launch adapter ships in the plugin package; this fake lives in tests/fixtures.
LAUNCH = Path(__file__).resolve().parents[2] / 'plugins/sleight/lib/direct-browser/electron/launch.py'


def fake():
    # A deliberately inheritable parent file must be absent. The platform
    # runtime can open character devices after exec; no file/pipe/socket may leak.
    for fd in range(5, 256):
        try:
            os.fstat(fd)
        except OSError:
            continue
        value = os.fstat(fd)
        if fd == 199 or not stat.S_ISCHR(value.st_mode):
            raise RuntimeError('unexpected inherited descriptor ' + str(fd))
    buffer = b''
    while True:
        chunk = os.read(3, 1024)
        if not chunk:
            return
        buffer += chunk
        while b'\0' in buffer:
            raw, buffer = buffer.split(b'\0', 1)
            request = json.loads(raw)
            result = {'id': request['id'], 'result': {'pid': os.getpid(), 'fds': [3, 4]}}
            os.write(4, json.dumps(result).encode() + b'\0')


def fake_host():
    """Stands in for Electron under the resident host's adapter: the pipe is descriptors 3 and 4,
    it exits when the pipe closes (as Electron does), and it reports what it inherited."""
    for fd in range(5, 256):
        try:
            value = os.fstat(fd)
        except OSError:
            continue
        if not stat.S_ISCHR(value.st_mode):
            raise RuntimeError('unexpected inherited descriptor ' + str(fd))
    for fd in (0, 1, 2):
        value = os.fstat(fd)
        if stat.S_ISFIFO(value.st_mode) or stat.S_ISSOCK(value.st_mode):
            raise RuntimeError('adapter control channel leaked into the app on descriptor ' + str(fd))
    import subprocess
    buffer = b''
    while True:
        chunk = os.read(3, 65536)
        if not chunk:
            return
        buffer += chunk
        while b'\0' in buffer:
            raw, buffer = buffer.split(b'\0', 1)
            request = json.loads(raw)
            method = request['method']
            if method == 'Fake.quit':
                sys.exit(0)
            if method == 'Browser.getVersion':
                result = {'protocolVersion': '1.3', 'product': 'Chrome/130.0.6723.0', 'revision': '@1', 'jsVersion': '13.0',
                          'userAgent': 'Mozilla/5.0 Chrome/130.0.6723.0 Electron/33.0.0', 'pid': os.getpid()}
            elif method == 'Fake.fds':
                kinds = {}
                for fd in range(0, 256):
                    try:
                        value = os.fstat(fd)
                    except OSError:
                        continue
                    kinds[str(fd)] = 'chr' if stat.S_ISCHR(value.st_mode) else 'fifo' if stat.S_ISFIFO(value.st_mode) else \
                        'sock' if stat.S_ISSOCK(value.st_mode) else 'reg' if stat.S_ISREG(value.st_mode) else 'other'
                result = {'fds': kinds}
            elif method == 'Fake.argv':
                result = {'argv': sys.argv, 'env': dict(os.environ)}
            elif method == 'Fake.spawnChild':
                child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], close_fds=True,
                                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                result = {'pid': child.pid}
            else:
                result = {'ok': True}
            reply = {'id': request['id'], 'result': result}
            if 'sessionId' in request:
                reply['sessionId'] = request['sessionId']
            os.write(4, json.dumps(reply).encode() + b'\0')


def census_test():
    spec = importlib.util.spec_from_file_location('ep2_census', LAUNCH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not module.PROCESSES.available:
        raise SystemExit('SKIP: no process table reader on this platform')
    me = os.getpid()
    birth = module.process_birth(me)
    assert module.census_absent([(me, birth)]) is False, 'a live incarnation is present'
    assert module.census_absent([(me, 'recycled-' + birth)]) is True, 'a recycled PID with another birth is a different process'
    assert module.census_absent([(2 ** 22 + 12345, birth)]) is True, 'a free PID is absent'
    assert module.census_absent([(me, birth), (2 ** 22 + 12345, 'x')]) is False
    class Broken(module.ProcessTable):
        def birth(self, pid):
            raise OSError(1, 'denied')
    assert module.census_absent([(me, birth)], Broken()) is False, 'an unreadable table is never absence'
    assert module.live_descendants([(os.getppid(), module.process_birth(os.getppid()))]) is not None
    try:
        module.process_birth(2 ** 22 + 12345)
        raise AssertionError('a missing process has no incarnation')
    except RuntimeError:
        pass
    adapter = module.Adapter({'version': 1, 'recipes': []}, tempfile.gettempdir())
    for bad in ({'cmd': 'nope'}, {'cmd': 'spawn'}, {'cmd': 'collect'}, {'cmd': 'reserve', 'build': 5}):
        try:
            adapter.handle(bad)
            raise AssertionError('accepted ' + repr(bad))
        except (ValueError, RuntimeError):
            pass
    print('census checks passed')


def recover_test(mode):
    spec = importlib.util.spec_from_file_location('ep2_recover', LAUNCH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    executable = Path(sys.executable).resolve()
    build = 'recover-fixture-no-spawn'
    registry = {'version': 1, 'recipes': [{'build': build, 'executable': str(executable),
                'sha256': hashlib.sha256(executable.read_bytes()).hexdigest(), 'args': ['{profile}']}]}
    with tempfile.TemporaryDirectory(prefix='ep2-recover-test-') as parent:
        first = module.OwnedLaunch(parent, registry, build)
        nonce, root, lock = first.nonce, first.root, first.lock
        state = module.lock_state(parent, build)
        assert state['exists'] and state['nonce'] == nonce and state['markerNonce'] == nonce and state['phase'] == 'reserved', state
        assert module.lock_state(parent, 'other-build') == {'exists': False}
        if mode == 'exact':
            # The creating process is gone: a new object proves ownership from the recorded inodes.
            again = module.OwnedLaunch.recover(parent, registry, build, nonce)
            assert again.recovered and again.root == root
            try:
                again.spawn(lambda pid: 'x')
                raise AssertionError('a recovered ownership must never spawn')
            except RuntimeError:
                pass
            assert again.collect(lambda _: False)['cleanup'] == 'retained'
            assert root.exists()
            assert again.collect(lambda _: True)['cleanup'] == 'removed'
            assert not root.exists() and not lock.exists()
        elif mode == 'wrong-nonce':
            try:
                module.OwnedLaunch.recover(parent, registry, build, 'not-the-nonce')
                raise AssertionError('wrong nonce accepted')
            except RuntimeError:
                pass
            assert root.exists() and lock.exists()
        elif mode == 'replaced-directories':
            # Same names and same marker text, different inodes: not the launch's directories.
            marker = root.joinpath('OWNER.json').read_text()
            moved = root.with_name(root.name + '-moved')
            root.rename(moved)
            root.mkdir()
            root.joinpath('OWNER.json').write_text(marker)
            try:
                module.OwnedLaunch.recover(parent, registry, build, nonce)
                raise AssertionError('lookalike profile accepted')
            except RuntimeError as error:
                assert 'inode' in str(error), error
            module.shutil.rmtree(root)
            moved.rename(root)
            lock_moved = lock.with_name(lock.name + '-moved')
            lock.rename(lock_moved)
            lock.mkdir()
            lock.joinpath('OWNER.json').write_text(lock_moved.joinpath('OWNER.json').read_text())
            try:
                module.OwnedLaunch.recover(parent, registry, build, nonce)
                raise AssertionError('lookalike lock accepted')
            except RuntimeError as error:
                assert 'inode' in str(error), error
            assert root.exists() and lock_moved.exists()
        elif mode == 'profile-outside-root':
            owner = lock / 'OWNER.json'
            owner.write_text(json.dumps({'owner': nonce, 'profile': '/etc'}))
            try:
                module.OwnedLaunch.recover(parent, registry, build, nonce)
                raise AssertionError('profile outside the reserved directory accepted')
            except (RuntimeError, OSError):
                pass
        elif mode == 'missing-marker':
            root.joinpath('OWNER.json').unlink()
            try:
                module.OwnedLaunch.recover(parent, registry, build, nonce)
                raise AssertionError('missing marker accepted')
            except (RuntimeError, OSError):
                pass
        else:
            raise SystemExit('unknown recover mode')
    print('recover checks passed: ' + mode)


def adapter_test(mode):
    """Drives launch.py --adapter as a subprocess, the way the resident host does."""
    import subprocess
    launch = LAUNCH
    executable = Path(sys.executable).resolve()
    build = 'adapter-fixture'
    with tempfile.TemporaryDirectory(prefix='ep2-adapter-test-') as parent:
        registry = Path(parent) / 'registry.json'
        registry.write_text(json.dumps({'version': 1, 'recipes': [{'build': build, 'executable': str(executable),
            'sha256': hashlib.sha256(executable.read_bytes()).hexdigest(), 'args': [str(Path(__file__).resolve()), '--fake-host', '{profile}']}]}))
        temporary = Path(parent) / 'tmp'
        temporary.mkdir()
        def start(extra=()):
            return subprocess.Popen([sys.executable, '-I', '-B', str(launch), '--adapter', '--registry', str(registry), '--temp-root', str(temporary), *extra],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def ask(process, request):
            process.stdin.write(json.dumps(request).encode() + b'\0')
            process.stdin.flush()
            buffer = b''
            while not buffer.endswith(b'\0'):
                buffer += os.read(process.stdout.fileno(), 65536)
            return json.loads(buffer.rstrip(b'\0'))
        if mode == 'arguments':
            for extra in ([], ['--registry', 'x']):
                process = subprocess.Popen([sys.executable, '-I', '-B', str(launch), '--adapter', *extra], stdin=subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                assert process.wait(10) != 0, 'the adapter needs exactly its two host-supplied arguments'
            process = subprocess.run([sys.executable, '-I', '-B', str(launch)], stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
            assert process.returncode == 0 and not process.stdout, 'without --adapter importing or running the module does nothing'
        elif mode == 'protocol':
            process = start()
            try:
                assert ask(process, {'id': 1, 'cmd': 'bogus'})['ok'] is False
                assert ask(process, {'id': 2, 'cmd': 'spawn'})['ok'] is False
                assert ask(process, {'id': 3, 'cmd': 'lockstate', 'build': build})['result'] == {'exists': False}
                reply = ask(process, {'id': 4, 'cmd': 'reserve', 'build': 'unreviewed-build'})
                assert reply['ok'] is False and 'isolation-unsupported' in reply['error'], reply
                reply = ask(process, {'id': 5, 'cmd': 'reserve', 'build': build})
                assert reply['ok'] and reply['result']['root'].startswith(str(temporary.resolve())), reply
                assert ask(process, {'id': 6, 'cmd': 'reserve', 'build': build})['ok'] is False, 'a held reservation is not replaced'
                assert ask(process, {'id': 'x', 'cmd': 'lockstate', 'build': build})['ok'] is False
                process.stdin.write(b'not json\0')
                process.stdin.flush()
                bad = b''
                while not bad.endswith(b'\0'):
                    bad += os.read(process.stdout.fileno(), 65536)
                assert json.loads(bad.rstrip(b'\0'))['ok'] is False
                assert ask(process, {'id': 7, 'cmd': 'lockstate', 'build': build})['ok'] is True, 'a bad frame is an error reply, not a crash'
                big = process.stdin.write(b'x' * (1024 * 1024 + 10))
                process.stdin.flush()
                assert process.wait(10) == 1, 'an oversized request ends the adapter'
                assert (temporary / ('sleight-ep2-lock-' + hashlib.sha256(build.encode()).hexdigest())).exists(), 'ownership stays on disk'
            finally:
                if process.poll() is None:
                    process.kill()
        elif mode == 'host-gone':
            process = start()
            assert ask(process, {'id': 1, 'cmd': 'reserve', 'build': build})['ok']
            process.stdin.close()
            assert process.wait(10) == 0, 'EOF from the host ends the adapter without touching ownership'
            state = module_lock_state(launch, temporary, build)
            assert state['exists'] and state['phase'] == 'reserved', state
        else:
            raise SystemExit('unknown adapter mode')
    print('adapter checks passed: ' + mode)


def module_lock_state(launch, temporary, build):
    spec = importlib.util.spec_from_file_location('ep2_lockstate', launch)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.lock_state(str(temporary), build)


def self_test():
    spec = importlib.util.spec_from_file_location('ep2_launch', LAUNCH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    executable = str(Path(sys.executable).resolve())
    recipe = {'build': 'fake-python-only', 'executable': executable,
              'sha256': hashlib.sha256(Path(executable).read_bytes()).hexdigest(),
              'args': [str(Path(__file__).resolve()), '--fake', '{profile}']}
    registry = {'version': 1, 'recipes': [recipe]}
    for build in ('unknown',):
        try:
            module.recipe_for(registry, build)
            raise AssertionError('unknown recipe accepted')
        except ValueError:
            pass
    for flag in ('--inspect=0', '--remote-debugging-port=0', '--no-sandbox'):
        try:
            module.recipe_for({'version': 1, 'recipes': [{**recipe, 'args': ['{profile}', flag]}]}, recipe['build'])
            raise AssertionError('unsafe switch accepted')
        except ValueError:
            pass
    with tempfile.TemporaryDirectory(prefix='ep2-launch-test-') as parent:
        launch = module.OwnedLaunch(parent, registry, recipe['build'])
        assert json.loads(launch.marker.read_text())['phase'] == 'reserved'
        try:
            module.OwnedLaunch(parent, registry, recipe['build'])
            raise AssertionError('unresolved ownership lock ignored')
        except FileExistsError:
            pass
        with open(Path(parent) / 'unrelated-parent-file', 'w') as sentinel:
            os.dup2(sentinel.fileno(), 199, inheritable=True)
            try:
                pid, reader, writer = launch.spawn(lambda pid: 'fake-birth-' + str(pid))
            finally:
                os.close(199)
        try:
            try:
                launch.spawn(lambda pid: 'second')
                raise AssertionError('second launch accepted')
            except RuntimeError:
                pass
            os.write(writer, b'{"id":1,"method":"Browser.getVersion"}\0')
            assert select.select([reader], [], [], 3)[0], 'fake did not answer'
            data = os.read(reader, 4096)
            assert data, (launch.root / 'child.log').read_text()
            reply = json.loads(data.rstrip(b'\0'))
            assert reply['result'] == {'pid': pid, 'fds': [3, 4]}
            assert launch.collect(lambda _: True)['cleanup'] == 'retained'
        finally:
            # Fixture-only EOF tests Electron's documented controller-exit risk.
            os.close(writer)
            launch.writer = None
            deadline = time.monotonic() + 3
            while launch.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            assert launch.poll() == 0, (launch.root / 'child.log').read_text()
        launch.observe([(pid + 1, 'observed-child')])
        assert launch.collect(lambda _: False)['cleanup'] == 'retained'
        (launch.root / 'cache').mkdir()
        (launch.root / 'cache').rmdir()
        assert launch.collect(lambda union: (pid + 1, 'observed-child') in union)['cleanup'] == 'removed'
        assert not launch.root.exists()
    print('launcher checks passed')


def cleanup_test(mode):
    spec = importlib.util.spec_from_file_location('ep2_cleanup', LAUNCH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    executable = Path(sys.executable).resolve()
    build = 'cleanup-fixture-no-spawn'
    registry = {'version': 1, 'recipes': [{'build': build, 'executable': str(executable),
                'sha256': hashlib.sha256(executable.read_bytes()).hexdigest(), 'args': ['{profile}']}]}
    with tempfile.TemporaryDirectory(prefix='ep2-cleanup-test-') as parent:
        launch = module.OwnedLaunch(parent, registry, build)
        owner = launch.lock / 'OWNER.json'
        original_unlink = Path.unlink

        def fail_owner_unlink(path, *args, **kwargs):
            if path == owner:
                raise PermissionError('fixture interruption before lock-owner removal')
            return original_unlink(path, *args, **kwargs)

        if mode == 'missing-evidence':
            launch.marker.unlink()
            assert launch.collect(lambda _: True)['cleanup'] == 'retained', 'missing marker is not removal proof'
            assert launch.root.exists() and owner.exists()
            separate = Path(parent) / 'missing-lock-owner'
            separate.mkdir()
            launch = module.OwnedLaunch(separate, registry, build)
            owner = launch.lock / 'OWNER.json'
            owner.unlink()
            assert launch.collect(lambda _: True)['cleanup'] == 'retained', 'missing lock owner is not removal proof'
            assert launch.root.exists()
            separate = Path(parent) / 'missing-root'
            separate.mkdir()
            launch = module.OwnedLaunch(separate, registry, build)
            owner = launch.lock / 'OWNER.json'
            module.shutil.rmtree(launch.root)
            assert launch.collect(lambda _: True)['cleanup'] == 'retained', 'arbitrary missing root is not removal proof'
            assert owner.exists()
        elif mode == 'partial-profile':
            def partial_removal(path, *args, **kwargs):
                assert Path(path) == launch.root
                launch.marker.unlink()
                raise PermissionError('fixture partial removal after marker unlink')

            with patch.object(module.shutil, 'rmtree', partial_removal):
                first = launch.collect(lambda _: True)
            assert first['cleanup'] == 'retained' and launch.root.exists() and not launch.marker.exists()
            assert owner.exists(), 'the surviving lock must retain exact ownership proof'
            original_root = launch.root.with_name(launch.root.name + '-original')
            launch.root.rename(original_root)
            launch.root.mkdir()
            launch.marker.write_text(json.dumps({'owner': launch.nonce}))
            assert launch.collect(lambda _: True)['cleanup'] == 'retained', 'same marker text cannot authorize a replacement inode'
            assert launch.marker.exists() and original_root.exists()
            module.shutil.rmtree(launch.root)
            original_root.rename(launch.root)
            assert launch.collect(lambda _: True)['cleanup'] == 'removed', 'partly removed owned root must remain resumable'
        elif mode == 'descriptor':
            reader, writer = os.pipe()
            launch.reader, launch.writer = reader, writer
            original_close = os.close

            def fail_close(fd):
                if fd == reader:
                    raise PermissionError('fixture descriptor close interruption')
                return original_close(fd)

            try:
                with patch.object(module.os, 'close', fail_close):
                    first = launch.collect(lambda _: True)
                assert first['cleanup'] == 'retained' and launch.lock.exists(), 'descriptor uncertainty must retain the build lock'
                assert launch.collect(lambda _: True)['cleanup'] == 'removed'
                assert not launch.lock.exists() and not launch.root.exists()
            finally:
                for fd in (reader, writer):
                    try:
                        original_close(fd)
                    except OSError:
                        pass
        elif mode == 'idempotent':
            reader, writer = os.pipe()
            launch.reader, launch.writer = reader, writer
            first = launch.collect(lambda _: True)
            assert first['cleanup'] == 'removed'
            assert launch.reader is None and launch.writer is None
            for fd in (reader, writer):
                try:
                    os.fstat(fd)
                    raise AssertionError('owned descriptor remained open')
                except OSError:
                    pass
            other = module.OwnedLaunch(parent, registry, build)
            assert launch.collect(lambda _: True) == first, 'completed cleanup is idempotent'
            assert other.root.exists() and (other.lock / 'OWNER.json').exists(), 'old receipt must not collect a later owner'
            launch.root.mkdir()
            launch.marker.write_text('replacement fixture')
            with patch.object(module.os, 'posix_spawn', side_effect=AssertionError('collected instance reached spawn')):
                for operation in (lambda: launch.spawn(lambda _: 'late'),
                                  lambda: launch.observe([(123, 'late')]), lambda: launch.record('late')):
                    try:
                        operation()
                        raise AssertionError('collected instance accepted a new ownership operation')
                    except RuntimeError:
                        pass
                    assert launch.marker.read_text() == 'replacement fixture', 'collected instance wrote into a replacement root'
            assert other.collect(lambda _: True)['cleanup'] == 'removed'
        else:
            if mode in ('after-profile', 'replaced-lock-owner'):
                with patch.object(Path, 'unlink', fail_owner_unlink):
                    first = launch.collect(lambda _: True)
                assert first['cleanup'] == 'retained' and not launch.root.exists() and owner.exists()
            else:
                blocker = launch.lock / 'fixture-obstruction'
                blocker.write_text('owned fixture')
                first = launch.collect(lambda _: True)
                assert first['cleanup'] == 'retained' and not launch.root.exists() and not owner.exists()
                blocker.unlink()
            if mode == 'replaced-profile':
                launch.root.mkdir()
                marker = launch.root / 'OWNER.json'
                marker.write_text('replacement fixture')
                assert launch.collect(lambda _: True)['cleanup'] == 'retained'
                assert marker.read_text() == 'replacement fixture' and launch.lock.exists()
            elif mode == 'replaced-profile-link':
                launch.root.symlink_to(Path(parent) / 'absent-fixture')
                assert launch.collect(lambda _: True)['cleanup'] == 'retained'
                assert launch.root.is_symlink() and launch.lock.exists(), 'a dangling replacement is not absence proof'
            elif mode == 'replaced-lock':
                moved = launch.lock.with_name(launch.lock.name + '-original')
                launch.lock.rename(moved)
                launch.lock.mkdir()
                assert launch.collect(lambda _: True)['cleanup'] == 'retained'
                assert launch.lock.exists() and moved.exists(), 'replacement empty lock must not be removed'
            elif mode == 'replaced-lock-owner':
                owner.rename(owner.with_name('saved-owner'))
                owner.write_text(json.dumps({'owner': launch.nonce, 'profile': str(launch.root)}))
                assert launch.collect(lambda _: True)['cleanup'] == 'retained'
                assert owner.exists() and launch.lock.exists()
            else:
                if mode == 'census':
                    assert launch.collect(lambda _: False)['cleanup'] == 'retained'
                    assert launch.lock.exists(), 'retry still requires absence proof'
                retry = launch.collect(lambda _: True)
                assert retry['cleanup'] == 'removed', 'owned cleanup must resume after the interruption clears'
                assert not launch.root.exists() and not launch.lock.exists()
                assert launch.collect(lambda _: True) == retry, 'repeated collection must return the proven receipt'
    print('cleanup checks passed: ' + mode)


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        self_test()
    elif '--fake' in sys.argv:
        fake()
    elif '--fake-host' in sys.argv:
        fake_host()
    elif '--census-test' in sys.argv:
        census_test()
    elif '--recover-test' in sys.argv:
        recover_test(sys.argv[sys.argv.index('--recover-test') + 1])
    elif '--adapter-test' in sys.argv:
        adapter_test(sys.argv[sys.argv.index('--adapter-test') + 1])
    elif '--cleanup-test' in sys.argv:
        cleanup_test(sys.argv[sys.argv.index('--cleanup-test') + 1])
    else:
        raise SystemExit('fixture modes only')
