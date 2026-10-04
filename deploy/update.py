#!/usr/bin/env python3
"""poll public CI and replace only the reviewed Compose server."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request


class DeployError(Exception):
    pass


def digest(value):
    if not isinstance(value, bytes):
        value = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(value).hexdigest()


def runtime_path(name):
    path = Path(name)
    if path.suffix == '.md' or 'test' in path.parts or '.test.' in path.name or path.name.endswith('_test.py'):
        return False
    return name in {'Dockerfile', '.dockerignore', '.node-version', 'package.json', 'package-lock.json'} or path.parts[0] in {'app', 'engine', 'agent'}


def ci_success(data, sha, repo):
    try:
        runs = data['workflow_runs']
        if not runs or data.get('total_count', len(runs)) > len(runs):
            return False
        run = max(runs, key=lambda r: (int(r['run_number']), int(r['id']), int(r['run_attempt'])))
        return (run['head_sha'] == sha and run['head_branch'] == 'main' and run['event'] == 'push'
                and run['status'] == 'completed' and run['conclusion'] == 'success'
                and run['path'] == '.github/workflows/ci.yml' and int(run['run_attempt']) > 0
                and run['repository']['full_name'] == repo and run['head_repository']['full_name'] == repo)
    except (KeyError, TypeError, ValueError):
        return False


class Updater:
    def __init__(self, config):
        self.config = config
        if any(not Path(config[key]).is_absolute() for key in ('root', 'stateDir', 'composeEnv')):
            raise DeployError('root, stateDir and composeEnv must be absolute paths')
        self.root = Path(config['root']).resolve()
        self.directory = Path(config['stateDir']).resolve()
        self.env_file = Path(config['composeEnv']).resolve()
        self.snapshot = self.directory / 'compose.yaml'
        self.state_file = self.directory / 'state.json'
        if self.directory == self.root or self.root in self.directory.parents:
            raise DeployError('stateDir must be outside the checkout')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', config['githubRepo']):
            raise DeployError('invalid githubRepo')
        url = urllib.parse.urlparse(config['healthUrl'])
        if url.scheme != 'http' or url.hostname not in {'127.0.0.1', 'localhost', '::1'} or url.username or url.query or url.fragment:
            raise DeployError('healthUrl must be a local HTTP URL')
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.directory, 0o700)

    @contextmanager
    def lock(self):
        with (self.directory / 'update.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise DeployError('another updater holds the lock') from None
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def atomic(self, path, content):
        fd, name = tempfile.mkstemp(dir=self.directory, prefix='.update-')
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, path)
            directory_fd = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def save(self, state):
        self.atomic(self.state_file, json.dumps(state, sort_keys=True).encode())

    def load(self):
        return json.loads(self.state_file.read_text())

    def cmd(self, args, timeout=60, cwd=None, image=None, stage='command'):
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR') if key in os.environ}
        env['GIT_TERMINAL_PROMPT'] = '0'
        if image:
            env['INFEREST_IMAGE'] = image
        try:
            process = subprocess.Popen(args, cwd=cwd or self.root, env=env, start_new_session=True,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                output, _ = process.communicate(timeout=timeout)
                if process.returncode:
                    raise DeployError(stage + ' failed or timed out; output suppressed')
            except BaseException:
                blocked = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
                try:
                    for signum in (signal.SIGTERM, signal.SIGKILL):
                        try:
                            os.killpg(process.pid, signum)
                        except ProcessLookupError:
                            pass
                        try:
                            process.communicate(timeout=1)
                        except subprocess.TimeoutExpired:
                            pass
                    process.wait(timeout=1)
                finally:
                    signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
                raise
            return output.strip()
        except (subprocess.SubprocessError, OSError):
            raise DeployError(stage + ' failed or timed out; output suppressed') from None

    def git(self, *args, timeout=60):
        return self.cmd(['git', '-c', 'core.hooksPath=/dev/null', *args], timeout=timeout, stage='git ' + args[0])

    def compose(self, *args, image=None, timeout=60):
        return self.cmd(['docker', 'compose', '--project-name', self.config['project'],
                         '--project-directory', str(self.root), '--env-file', str(self.env_file),
                         '-f', str(self.snapshot), *args], timeout=timeout, image=image, stage='Compose ' + args[0])

    def inspect(self):
        ids = self.cmd(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + self.config['project'],
                        '--filter', 'label=com.docker.compose.service=server']).splitlines()
        if len(ids) != 1:
            raise DeployError('expected exactly one server container')
        return json.loads(self.cmd(['docker', 'inspect', ids[0]]))[0]

    def baseline(self, image):
        plain = json.loads(self.compose('config', '--format', 'json', '--no-env-resolution', 'server', image=image))
        resolved = json.loads(self.compose('config', '--format', 'json', 'server', image=image))
        server = resolved['services']['server']
        server.pop('image', None)
        server.pop('build', None)
        files = {str(self.env_file), str(self.root / 'compose.yaml'), str(self.snapshot)}
        for entry in plain['services']['server'].get('env_file', []):
            files.add(entry['path'] if isinstance(entry, dict) else entry)
        for mount in server.get('volumes', []):
            if mount['type'] == 'bind':
                files.add(mount['source'])
        return {'config': digest(self.config), 'server': digest(server),
                'files': {name: digest(Path(name).read_bytes()) for name in sorted(files)}}

    def runtime(self):
        info = self.inspect()
        if info['Config']['Labels'].get('com.docker.compose.project') != self.config['project']:
            raise DeployError('server project differs')
        mounts = [{key: m.get(key) for key in ('Type', 'Name', 'Source', 'Destination', 'RW')} for m in info['Mounts']]
        if not any(m['Type'] == 'volume' and m['Destination'] == '/data' for m in mounts):
            raise DeployError('server must retain a named data volume')
        image = json.loads(self.cmd(['docker', 'image', 'inspect', info['Image']]))[0]
        configured = json.loads(self.compose('config', '--format', 'json', 'server', image=info['Image']))['services']['server'].get('environment', {})
        expected = dict(entry.split('=', 1) for entry in image['Config'].get('Env', []))
        expected.update({key: str(value) for key, value in configured.items()})
        if dict(entry.split('=', 1) for entry in info['Config']['Env']) != expected:
            raise DeployError('live environment differs from image and reviewed inputs')
        return {'environment': digest(configured), 'mounts': sorted(mounts, key=lambda m: m['Destination']),
                'ports': info['HostConfig']['PortBindings']}, info

    def check_drift(self, state, image=None, recovery=False):
        if self.baseline(image or state['image']) != state['baseline']:
            raise DeployError('reviewed configuration or private input drift; rebaseline required')
        if not recovery:
            runtime, info = self.runtime()
            if runtime != state['runtime'] or info['Image'] != (image or state['image']):
                raise DeployError('running server drift; rebaseline required')

    def health(self, expected=None):
        base = self.config['healthUrl'].rstrip('/')
        try:
            for route in ('/', '/treasury', '/agents'):
                with urllib.request.urlopen(base + route, timeout=10) as response:
                    if response.status != 200 or b'<!doctype html>' not in response.read(2_000_000).lower():
                        raise ValueError()
            with urllib.request.urlopen(base + '/api/state', timeout=10) as response:
                config = json.load(response)['config']
                if response.status != 200 or not isinstance(config, dict) or not config.get('chainId'):
                    raise ValueError()
            if expected and digest(config) != expected:
                raise ValueError()
            return config
        except Exception:
            raise DeployError('local health or public configuration check failed') from None

    def clean(self):
        if self.git('status', '--porcelain', '--untracked-files=normal'):
            raise DeployError('checkout has local changes')

    def fetch(self):
        self.git('fetch', '--no-tags', 'https://github.com/' + self.config['githubRepo'] + '.git',
                 '+refs/heads/main:refs/remotes/inferest-updater/main', timeout=120)
        sha = self.git('rev-parse', 'refs/remotes/inferest-updater/main')
        if not re.fullmatch('[0-9a-f]{40}', sha):
            raise DeployError('invalid fetched revision')
        return sha

    def api(self, path):
        request = urllib.request.Request('https://api.github.com/repos/' + self.config['githubRepo'] + path,
                                         headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'inferest-updater',
                                                  'X-GitHub-Api-Version': '2022-11-28'})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)
        except Exception:
            raise DeployError('public CI verification unavailable') from None

    def ci(self, sha):
        data = self.api('/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100&head_sha=' + sha)
        if not ci_success(data, sha, self.config['githubRepo']):
            return False
        latest = max(data['workflow_runs'], key=lambda run: (int(run['run_number']), int(run['id']), int(run['run_attempt'])))
        run = self.api('/actions/runs/' + str(latest['id']))
        return ci_success({'workflow_runs': [run]}, sha, self.config['githubRepo']) and run['run_attempt'] >= latest['run_attempt']

    def changes(self, old, new):
        return self.git('diff', '--name-only', '--no-renames', '-z', old, new, '--').split('\0')[:-1]

    def build(self, sha):
        tag = 'inferest-update:' + sha
        with tempfile.TemporaryDirectory(prefix='inferest-build-') as directory:
            checkout = str(Path(directory) / 'source')
            self.git('worktree', 'add', '--detach', checkout, sha)
            try:
                node = (Path(checkout) / '.node-version').read_text().strip()
                if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', node):
                    raise DeployError('candidate must pin a Node version')
                self.cmd(['docker', 'build', '--build-arg', 'NODE_VERSION=' + node,
                          '--label', 'org.opencontainers.image.revision=' + sha,
                          '--tag', tag, checkout], timeout=900, stage='image build')
            finally:
                self.git('worktree', 'remove', '--force', checkout)
        info = json.loads(self.cmd(['docker', 'image', 'inspect', tag]))[0]
        if info['Config']['Labels'].get('org.opencontainers.image.revision') != sha:
            raise DeployError('built image revision differs')
        return info['Id']

    def switch(self, image):
        self.compose('up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120',
                     'server', image=image, timeout=180)

    def verify_adoption(self, info):
        resolved = json.loads(self.compose('config', '--format', 'json', 'server'))
        server = resolved['services']['server']
        actual_env = dict(entry.split('=', 1) for entry in info['Config']['Env'])
        if any(actual_env.get(key) != str(value) for key, value in server.get('environment', {}).items()):
            raise DeployError('live environment differs from reviewed Compose inputs')
        if not info['State']['Running'] or info['State'].get('Health', {}).get('Status') != 'healthy':
            raise DeployError('live container must be running and healthy')
        ports = {}
        for port in server.get('ports', []):
            key = str(port['target']) + '/' + port.get('protocol', 'tcp')
            ports.setdefault(key, []).append({'HostIp': port.get('host_ip', ''), 'HostPort': str(port['published'])})
        if ports != (info['HostConfig']['PortBindings'] or {}):
            raise DeployError('live ports differ from reviewed Compose inputs')
        mounts = {mount['Destination']: mount for mount in info['Mounts']}
        if len(mounts) != len(server.get('volumes', [])):
            raise DeployError('live mounts differ from reviewed Compose inputs')
        for mount in server.get('volumes', []):
            actual = mounts.get(mount['target'], {})
            source = mount['source']
            key = 'Source'
            if mount['type'] == 'volume':
                source = resolved['volumes'][source]['name']
                key = 'Name'
            if (actual.get('Type') != mount['type'] or actual.get(key) != source
                    or actual.get('RW') == mount.get('read_only', False)):
                raise DeployError('live mounts differ from reviewed Compose inputs')

    def init(self, replace=False):
        if self.state_file.exists() and (not replace or self.load().get('pending')):
            raise DeployError('baseline exists or recovery is pending')
        self.clean()
        previous = self.snapshot.read_bytes() if self.snapshot.exists() else None
        self.atomic(self.snapshot, (self.root / 'compose.yaml').read_bytes())
        try:
            runtime, info = self.runtime()
            sha = info['Config']['Labels'].get('org.opencontainers.image.revision', '')
            if not re.fullmatch('[0-9a-f]{40}', sha):
                raise DeployError('live image requires a full revision label')
            self.git('cat-file', '-e', sha + '^{commit}')
            self.verify_adoption(info)
            state = dict(revision=sha, image=info['Image'], runtime=runtime, baseline=self.baseline(info['Image']),
                         health=digest(self.health()), pending=None, failed=[])
            self.save(state)
        except BaseException:
            if previous is None:
                self.snapshot.unlink(missing_ok=True)
            else:
                self.atomic(self.snapshot, previous)
            raise
        print('adopted healthy server at ' + sha)

    def recover(self, state):
        candidate = state['pending']['revision']
        self.check_drift(state, recovery=True)
        self.switch(state['image'])
        self.check_drift(state)
        self.health(state.get('health'))
        state['failed'] = sorted(set(state['failed']) | {candidate})
        state['pending'] = None
        self.save(state)
        print('restored previous healthy image')

    def run(self, retry=False):
        state = self.load()
        if state['pending']:
            self.recover(state)
        self.check_drift(state)
        self.clean()
        sha = self.fetch()
        if sha == state['revision'] or (sha in state['failed'] and not retry):
            print('no eligible new revision')
            return
        if not self.ci(sha):
            print('waiting for successful exact-revision CI')
            return
        paths = self.changes(state['revision'], sha)
        if {'app/store.ts', 'agent/log.ts', 'compose.yaml'}.intersection(paths):
            print('manual schema or Compose review required')
            return
        if not any(runtime_path(path) for path in paths):
            print('no runtime changes')
            return
        try:
            image = self.build(sha)
        except DeployError:
            state['failed'] = sorted(set(state['failed']) | {sha})
            self.save(state)
            raise
        if self.fetch() != sha or not self.ci(sha):
            print('main or CI changed during build; skipped')
            return
        self.clean()
        self.check_drift(state)
        state['pending'] = {'revision': sha, 'image': image}
        self.save(state)
        try:
            self.switch(image)
            self.check_drift(state, image=image)
            self.health(state.get('health'))
            state.update(revision=sha, image=image, pending=None)
            self.save(state)
        except Exception:
            self.recover(self.load())
            raise DeployError('candidate failed; restored previous image') from None
        print('deployed ' + sha)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('init').add_argument('--replace', action='store_true')
    commands.add_parser('run').add_argument('--retry', action='store_true')
    commands.add_parser('status')
    args = parser.parse_args()
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        updater = Updater(json.loads(Path(args.config).read_text()))
        with updater.lock():
            if args.command == 'init':
                updater.init(args.replace)
            elif args.command == 'run':
                updater.run(args.retry)
            else:
                state = updater.load()
                print(json.dumps({key: state[key] for key in ('revision', 'image', 'failed', 'pending')}, sort_keys=True))
    except DeployError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (Exception, KeyboardInterrupt):
        print('updater stopped; inspect local configuration and pending status', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
