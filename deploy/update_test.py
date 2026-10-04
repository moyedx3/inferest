import importlib.util
import json
import tempfile
import subprocess
import sys
import time
import signal
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('update', Path(__file__).with_name('update.py'))
update = importlib.util.module_from_spec(SPEC)
if SPEC.loader and Path(SPEC.origin).exists():
    SPEC.loader.exec_module(update)

SHA = 'a' * 40
NEW = 'b' * 40
IMAGE = 'sha256:' + 'c' * 64
NEXT_IMAGE = 'sha256:' + 'd' * 64


def ci_run(**changes):
    run = dict(id=42, run_number=10, run_attempt=1, head_sha=NEW,
               head_branch='main', event='push', status='completed', conclusion='success',
               path='.github/workflows/ci.yml', repository={'full_name': 'owner/repo'},
               head_repository={'full_name': 'owner/repo'})
    return run | changes


class RulesTests(unittest.TestCase):
    def test_runtime_paths_and_deletions(self):
        for name in ['app/server.ts', 'app/dashboard/src/dynamic.js', 'engine/ledger.ts',
                     'agent/run.ts', 'Dockerfile', '.dockerignore', '.node-version', 'package-lock.json']:
            self.assertTrue(update.runtime_path(name), name)
        for name in ['README.md', 'docs/a.md', 'app/test/server.test.ts', 'engine/ledger.test.ts',
                     'contracts/src/X.sol', 'deploy/update.py', 'config/arbitrum-one.json']:
            self.assertFalse(update.runtime_path(name), name)

    def test_latest_ci_attempt_must_succeed(self):
        self.assertTrue(update.ci_success({'workflow_runs': [ci_run()], 'total_count': 1}, NEW, 'owner/repo'))
        for changes in [{'conclusion': 'failure'}, {'status': 'in_progress'}, {'head_sha': SHA},
                        {'event': 'pull_request'}, {'head_branch': 'feature'}, {'run_attempt': 0},
                        {'path': '.github/workflows/other.yml'}, {'repository': {'full_name': 'fork/repo'}}]:
            self.assertFalse(update.ci_success({'workflow_runs': [ci_run(**changes)]}, NEW, 'owner/repo'))
        self.assertFalse(update.ci_success({'workflow_runs': [ci_run(), ci_run(run_attempt=2, conclusion='failure')]}, NEW, 'owner/repo'))
        self.assertFalse(update.ci_success({'workflow_runs': [ci_run(), ci_run(id=43, run_number=11, status='queued')]}, NEW, 'owner/repo'))
        self.assertFalse(update.ci_success({}, NEW, 'owner/repo'))
        self.assertFalse(update.ci_success({'workflow_runs': [ci_run()], 'total_count': 101}, NEW, 'owner/repo'))


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'repo'
        self.root.mkdir()
        self.state_dir = self.base / 'state'
        self.config = dict(root=str(self.root), githubRepo='owner/repo', composeEnv=str(self.base / 'compose.env'),
                           project='fixture', stateDir=str(self.state_dir), healthUrl='http://127.0.0.1:8787')
        self.u = update.Updater(self.config)
        self.state = dict(revision=SHA, image=IMAGE, baseline={'fixture': True}, failed=[], pending=None)
        self.u.save(self.state)
        self.calls = []
        for name, value in [('check_drift', None), ('clean', None), ('fetch', NEW), ('ci', True),
                            ('changes', ['app/server.ts']), ('build', NEXT_IMAGE), ('health', {'chainId': 42161})]:
            p = patch.object(self.u, name, return_value=value)
            p.start()
            self.addCleanup(p.stop)
        self.switch = patch.object(self.u, 'switch', side_effect=lambda image: self.calls.append(image)).start()
        self.addCleanup(patch.stopall)

    def state_on_disk(self):
        return json.loads((self.state_dir / 'state.json').read_text())

    def test_success_saves_only_after_switch_and_health(self):
        def switching(image):
            pending = self.state_on_disk()['pending']
            self.assertEqual(pending, {'revision': NEW, 'image': NEXT_IMAGE})
            self.assertEqual(self.state_on_disk()['image'], IMAGE)
            self.calls.append(image)
        self.switch.side_effect = switching
        self.u.run()
        self.assertEqual(self.calls, [NEXT_IMAGE])
        self.assertEqual(self.state_on_disk()['revision'], NEW)
        self.assertIsNone(self.state_on_disk()['pending'])

    def test_health_failure_rolls_back_and_remembers_failed_sha(self):
        self.u.health.side_effect = [update.DeployError('health failed'), {'chainId': 42161}]
        with self.assertRaises(update.DeployError):
            self.u.run()
        self.assertEqual(self.calls, [NEXT_IMAGE, IMAGE])
        self.assertEqual(self.state_on_disk()['revision'], SHA)
        self.assertEqual(self.state_on_disk()['failed'], [NEW])
        self.assertIsNone(self.state_on_disk()['pending'])
        self.u.run()
        self.assertEqual(self.calls, [NEXT_IMAGE, IMAGE])

    def test_retry_is_explicit(self):
        self.state['failed'] = [NEW]
        self.u.save(self.state)
        self.u.run(retry=True)
        self.assertEqual(self.calls, [NEXT_IMAGE])

    def test_failed_rollback_keeps_pending_and_halts_next_poll(self):
        self.switch.side_effect = update.DeployError('recreate failed')
        with self.assertRaises(update.DeployError):
            self.u.run()
        self.assertEqual(self.state_on_disk()['pending']['revision'], NEW)
        self.u.fetch.reset_mock()
        with self.assertRaises(update.DeployError):
            self.u.run()
        self.u.fetch.assert_not_called()

    def test_interruption_after_switch_recovers_previous_image(self):
        self.u.health.side_effect = KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            self.u.run()
        self.assertIsNotNone(self.state_on_disk()['pending'])
        self.u.health.side_effect = None
        self.u.run()
        self.assertEqual(self.calls, [NEXT_IMAGE, IMAGE])
        self.assertEqual(self.state_on_disk()['revision'], SHA)
        self.assertEqual(self.state_on_disk()['failed'], [NEW])

    def test_manual_gates_and_docs_do_not_switch(self):
        for paths in [['docs/one.md'], ['app/store.ts', 'app/server.ts'],
                      ['agent/log.ts'], ['compose.yaml', 'app/dashboard/home.js']]:
            self.u.changes.return_value = paths
            self.u.run()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.state_on_disk()['revision'], SHA)

    def test_ci_failure_and_stale_main_do_not_switch(self):
        self.u.ci.return_value = False
        self.u.run()
        self.assertEqual(self.calls, [])
        self.u.ci.return_value = True
        self.u.fetch.side_effect = [NEW, 'e' * 40]
        self.u.run()
        self.assertEqual(self.calls, [])

    def test_drift_halts_before_build_or_fetch(self):
        self.u.check_drift.side_effect = update.DeployError('runtime drift')
        with self.assertRaises(update.DeployError):
            self.u.run()
        self.u.fetch.assert_not_called()
        self.u.build.assert_not_called()

    def test_lock_contends(self):
        with self.u.lock():
            with self.assertRaises(update.DeployError):
                with update.Updater(self.config).lock():
                    self.fail('second updater entered')

    def test_snapshot_or_private_input_drift_is_rejected(self):
        self.u.check_drift = update.Updater.check_drift.__get__(self.u)
        with patch.object(self.u, 'baseline', return_value={'fixture': False}):
            with self.assertRaises(update.DeployError):
                self.u.check_drift(self.state)


    def test_dirty_checkout_is_rejected_and_ignored_inputs_are_allowed(self):
        self.u.clean = update.Updater.clean.__get__(self.u)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / '.gitignore').write_text('private/\n')
        subprocess.run(['git', '-C', str(self.root), 'add', '.gitignore'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c',
                        'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], check=True)
        private = self.root / 'private'
        private.mkdir()
        (private / 'operational').write_text('synthetic')
        self.u.clean()
        (self.root / 'unexpected.ts').write_text('local edit')
        with self.assertRaises(update.DeployError):
            self.u.clean()

    def test_git_diff_includes_deleted_and_renamed_runtime_paths(self):
        self.u.changes = update.Updater.changes.__get__(self.u)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'app').mkdir()
        (self.root / 'app' / 'server.ts').write_text('runtime')
        subprocess.run(['git', '-C', str(self.root), 'add', 'app'], check=True)
        commit = ['git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm']
        subprocess.run(commit + ['initial'], check=True)
        old = self.u.git('rev-parse', 'HEAD')
        (self.root / 'app' / 'server.ts').rename(self.root / 'archive.md')
        subprocess.run(['git', '-C', str(self.root), 'add', '-A'], check=True)
        subprocess.run(commit + ['move'], check=True)
        self.assertEqual(set(self.u.changes(old, 'HEAD')), {'app/server.ts', 'archive.md'})

    def test_commands_suppress_output_on_failure_and_have_timeouts(self):
        with self.assertRaisesRegex(update.DeployError, '^command failed or timed out; output suppressed$'):
            self.u.cmd(['python3', '-c', 'import sys; print("synthetic-secret"); sys.exit(1)'])
        with self.assertRaises(update.DeployError):
            self.u.cmd(['python3', '-c', 'import time; time.sleep(5)'], timeout=0.01)

    def test_server_switch_preserves_compose_scope(self):
        self.u.switch = update.Updater.switch.__get__(self.u)
        with patch.object(self.u, 'cmd', return_value='') as command:
            self.u.switch(IMAGE)
        argv = command.call_args.args[0]
        self.assertEqual(argv[-1], 'server')
        for flag in ['--no-deps', '--no-build', '--pull', 'never', '--wait', '--project-name']:
            self.assertIn(flag, argv)
        self.assertEqual(command.call_args.kwargs['image'], IMAGE)
        self.assertEqual(command.call_args.kwargs['timeout'], 180)

    def test_adoption_rejects_live_and_configured_environment_or_mount_mismatch(self):
        resolved = {'services': {'server': {'environment': {'DB_PATH': '/data/inferest.db'},
                    'volumes': [{'type': 'volume', 'source': 'data', 'target': '/data'}]}},
                    'volumes': {'data': {'name': 'fixture_data'}}}
        info = {'Config': {'Env': ['DB_PATH=/wrong']},
                'State': {'Running': True, 'Health': {'Status': 'healthy'}}, 'HostConfig': {'PortBindings': {}},
                'Mounts': [{'Type': 'volume', 'Name': 'fixture_data', 'Destination': '/data', 'RW': True}]}
        with patch.object(self.u, 'compose', return_value=json.dumps(resolved)):
            with self.assertRaises(update.DeployError):
                self.u.verify_adoption(info)
            info['Config']['Env'] = ['DB_PATH=/data/inferest.db']
            self.u.verify_adoption(info)
            info['Mounts'][0]['Name'] = 'other_data'
            with self.assertRaises(update.DeployError):
                self.u.verify_adoption(info)


    def test_candidate_build_uses_its_pinned_node_version(self):
        self.u.build = update.Updater.build.__get__(self.u)
        def git(*args, **kwargs):
            if args[:2] == ('worktree', 'add'):
                directory = Path(args[3])
                directory.mkdir()
                (directory / '.node-version').write_text('24.22.0\n')
        image = {'Id': NEXT_IMAGE, 'Config': {'Labels': {'org.opencontainers.image.revision': NEW}}}
        with patch.object(self.u, 'git', side_effect=git), patch.object(self.u, 'cmd', return_value=json.dumps([image])) as cmd:
            self.u.build(NEW)
        argv = cmd.call_args_list[0].args[0]
        self.assertIn('--build-arg', argv)
        self.assertIn('NODE_VERSION=24.22.0', argv)

    def test_runtime_accepts_new_image_defaults_but_rejects_unreviewed_env(self):
        configured = {'ADMIN_TOKEN': 'synthetic', 'DB_PATH': '/data/inferest.db'}
        info = {'Image': IMAGE, 'Config': {'Env': ['NODE_VERSION=24.22.0', 'ADMIN_TOKEN=synthetic', 'DB_PATH=/data/inferest.db'],
                'Labels': {'com.docker.compose.project': 'fixture'}},
                'Mounts': [{'Type': 'volume', 'Name': 'fixture_data', 'Source': '/data/path', 'Destination': '/data', 'RW': True}],
                'HostConfig': {'PortBindings': {}}}
        with patch.object(self.u, 'inspect', return_value=info), \
             patch.object(self.u, 'compose', return_value=json.dumps({'services': {'server': {'environment': configured}}})), \
             patch.object(self.u, 'cmd', return_value=json.dumps([{'Config': {'Env': ['NODE_VERSION=24.22.0']}}])):
            runtime, _ = self.u.runtime()
            self.assertEqual(runtime['environment'], update.digest(configured))
            info['Config']['Env'].append('UNREVIEWED=value')
            with self.assertRaises(update.DeployError):
                self.u.runtime()


    def test_init_creates_snapshot_before_inspection_and_restores_it_on_failure(self):
        (self.root / 'compose.yaml').write_text('new reviewed compose')
        old = b'old reviewed compose'
        self.u.snapshot.write_bytes(old)
        def runtime():
            self.assertEqual(self.u.snapshot.read_text(), 'new reviewed compose')
            return {}, {'Image': IMAGE, 'Config': {'Labels': {'org.opencontainers.image.revision': SHA}}}
        with patch.object(self.u, 'runtime', side_effect=runtime), patch.object(self.u, 'git'), \
             patch.object(self.u, 'verify_adoption'), patch.object(self.u, 'baseline', side_effect=update.DeployError('fixture rejection')):
            with self.assertRaises(update.DeployError):
                self.u.init(replace=True)
        self.assertEqual(self.u.snapshot.read_bytes(), old)
        self.assertEqual(self.state_on_disk(), self.state)


    def test_actual_input_fingerprints_detect_each_file_change(self):
        server_env = self.base / 'server.env'
        chain = self.base / 'chain.json'
        files = [self.u.env_file, server_env, chain, self.root / 'compose.yaml', self.u.snapshot]
        for file in files:
            file.write_text('synthetic fixture')
        plain = {'services': {'server': {'env_file': [{'path': str(server_env)}]}}}
        resolved = {'services': {'server': {'image': IMAGE, 'build': {}, 'environment': {'KEY': 'synthetic'},
                    'volumes': [{'type': 'bind', 'source': str(chain), 'target': '/run/chain.json'}]}}}
        def compose(*args, **kwargs):
            return json.dumps(plain if '--no-env-resolution' in args else resolved)
        with patch.object(self.u, 'compose', side_effect=compose):
            baseline = self.u.baseline(IMAGE)
            for file in files:
                file.write_text('modified synthetic fixture')
                self.assertNotEqual(self.u.baseline(IMAGE), baseline, file.name)
                file.write_text('synthetic fixture')
            self.assertEqual(self.u.baseline(IMAGE), baseline)
            self.assertEqual(self.u.baseline(NEXT_IMAGE), baseline)
        self.assertNotIn('synthetic', json.dumps(baseline))

    def test_latest_run_details_are_checked_for_rerun(self):
        self.u.ci = update.Updater.ci.__get__(self.u)
        with patch.object(self.u, 'api', side_effect=[{'workflow_runs': [ci_run()]}, ci_run(run_attempt=2, status='in_progress')]):
            self.assertFalse(self.u.ci(NEW))

    def test_relative_paths_are_rejected(self):
        for field in ('root', 'stateDir', 'composeEnv'):
            with self.assertRaises(update.DeployError):
                update.Updater(self.config | {field: 'relative'})


    def test_failed_build_is_remembered_without_switch_and_requires_retry(self):
        self.u.build.side_effect = update.DeployError('image build failed or timed out; output suppressed')
        with self.assertRaisesRegex(update.DeployError, '^image build failed'):
            self.u.run()
        saved = self.state_on_disk()
        self.assertEqual(saved['revision'], SHA)
        self.assertEqual(saved['image'], IMAGE)
        self.assertIsNone(saved['pending'])
        self.assertEqual(saved['failed'], [NEW])
        self.assertEqual(self.calls, [])
        self.u.build.reset_mock()
        self.u.run()
        self.u.build.assert_not_called()
        self.u.build.side_effect = None
        self.u.run(retry=True)
        self.assertEqual(self.calls, [NEXT_IMAGE])
        self.assertEqual(self.state_on_disk()['revision'], NEW)

    def test_ci_unavailability_does_not_mark_candidate_failed(self):
        self.u.ci.side_effect = update.DeployError('public CI verification unavailable')
        with self.assertRaises(update.DeployError):
            self.u.run()
        self.assertEqual(self.state_on_disk()['failed'], [])
        self.u.ci.side_effect = None
        self.u.run()
        self.assertEqual(self.calls, [NEXT_IMAGE])


    def test_timeout_kills_descendants_before_releasing_control(self):
        marker = self.base / 'child-effect'
        child = ('import signal,time; from pathlib import Path; '
                 'signal.signal(signal.SIGTERM, signal.SIG_IGN); '
                 f'time.sleep(0.5); Path({str(marker)!r}).write_text("orphan")')
        parent = ('import subprocess,sys,time; '
                  f'subprocess.Popen([sys.executable,"-c",{child!r}], '
                  'stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(5)')
        with self.assertRaises(update.DeployError):
            self.u.cmd([sys.executable, '-c', parent], timeout=0.1)
        time.sleep(0.6)
        self.assertFalse(marker.exists(), 'descendant survived the command timeout')

    def test_failed_command_kills_descendants_before_releasing_control(self):
        marker = self.base / 'failed-child-effect'
        child = f'from pathlib import Path; import time; time.sleep(0.4); Path({str(marker)!r}).write_text("orphan")'
        parent = ('import subprocess,sys; '
                  f'subprocess.Popen([sys.executable,"-c",{child!r}], '
                  'stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); sys.exit(1)')
        with self.assertRaises(update.DeployError):
            self.u.cmd([sys.executable, '-c', parent])
        time.sleep(0.5)
        self.assertFalse(marker.exists(), 'descendant survived a failed command')

    def test_sigterm_cleans_command_group_before_cli_exits(self):
        marker = self.base / 'sigterm-child-effect'
        ready = self.base / 'ready'
        config_file = self.base / 'update.json'
        config_file.write_text(json.dumps(self.config))
        child = f'from pathlib import Path; import time; time.sleep(0.7); Path({str(marker)!r}).write_text("orphan")'
        command = ('import subprocess,sys,time; from pathlib import Path; '
                   f'subprocess.Popen([sys.executable,"-c",{child!r}], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); '
                   f'Path({str(ready)!r}).write_text("ready"); time.sleep(5)')
        wrapper = ('import importlib.util,sys; '
                   f'spec=importlib.util.spec_from_file_location("update",{str(SPEC.origin)!r}); '
                   'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); '
                   f'module.Updater.run=lambda self,retry: self.cmd([sys.executable,"-c",{command!r}]); '
                   f'sys.argv=["update","--config",{str(config_file)!r},"run"]; sys.exit(module.main())')
        process = subprocess.Popen([sys.executable, '-c', wrapper], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(ready.exists())
            process.send_signal(signal.SIGTERM)
            process.communicate(timeout=5)
            time.sleep(0.8)
            self.assertFalse(marker.exists(), 'descendant survived CLI SIGTERM')
            self.assertEqual(process.returncode, 1)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()


if __name__ == '__main__':
    unittest.main()
