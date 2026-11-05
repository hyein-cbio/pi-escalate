"""Offline tests of Modal dispatch, dependency preparation, and failure propagation."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import modal_ci as ci


class ModalCITests(unittest.TestCase):
    def setUp(self):
        output = patch("builtins.print")
        output.start()
        self.addCleanup(output.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.workspace = Path(directory.name)
        self.package = {
            "version": "0.2.1", "peerDependencies": {name: "*" for name in ci.PI_PACKAGES},
            "devDependencies": {}, "overrides": {"existing": "1.0.0"},
        }
        (self.workspace / "package.json").write_text(json.dumps(self.package))
        self.write_family("1.0.3")

    def write_family(self, version):
        packages = {"": {}}
        for name in (*ci.PI_PACKAGES, "@earendil-works/pi-schema"):
            path = f"node_modules/{name}"
            packages[path] = {"version": version}
            installed = self.workspace / path / "package.json"
            installed.parent.mkdir(parents=True, exist_ok=True)
            installed.write_text(json.dumps({"version": version}))
        (self.workspace / "package-lock.json").write_text(json.dumps({"packages": packages}))

    def test_matrix_dispatches_two_inputs_in_one_map(self):
        results = [{"host": host, "pi": "1.5.0"} for host in ci.HOSTS]
        with patch.object(ci, "test_host") as function, patch.dict(os.environ, {}, clear=True):
            function.map.return_value = iter(results)
            ci.matrix()
            function.map.assert_called_once_with(ci.HOSTS, return_exceptions=True)

    def test_matrix_collects_all_results_before_failing(self):
        consumed = []

        def results():
            consumed.append("locked")
            yield RuntimeError("broken locked check")
            consumed.append("latest")
            yield {"host": "latest", "pi": "1.5.0"}

        with patch.object(ci, "test_host") as function, patch.dict(os.environ, {}, clear=True):
            function.map.return_value = results()
            with self.assertRaisesRegex(RuntimeError, "locked"):
                ci.matrix()
        self.assertEqual(consumed, ["locked", "latest"])

    def test_dispatch_error_fails_instead_of_silently_running_locally(self):
        with patch.object(ci, "test_host") as function:
            function.map.side_effect = RuntimeError("remote dispatch failed")
            with self.assertRaisesRegex(RuntimeError, "remote dispatch failed"):
                ci.matrix()

    def test_summary_records_pass_and_failure(self):
        summary = self.workspace / "summary"
        summary.write_text("Earlier summary\n")
        with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}):
            with patch.object(ci, "test_host") as function:
                function.map.return_value = [
                    {"host": "locked", "pi": "1.0.3"}, RuntimeError("latest failed"),
                ]
                with self.assertRaises(RuntimeError):
                    ci.matrix()
        text = summary.read_text()
        self.assertTrue(text.startswith("Earlier summary\n"))
        self.assertIn("PASS: locked / Pi 1.0.3", text)
        self.assertIn("FAIL: latest", text)

    def test_locked_suite_installs_checks_and_packs_with_fail_fast_commands(self):
        with patch.object(ci, "command") as command, patch.object(ci, "prepare_latest") as latest:
            self.assertEqual(ci.run_checks("locked", self.workspace), {"host": "locked", "pi": "1.0.3"})
        latest.assert_not_called()
        self.assertEqual([call.args[0] for call in command.call_args_list], [
            ["node", "--version"], ["rg", "--version"], ["fdfind", "--version"],
            ["python", "-m", "unittest", "discover", "-s", "ci", "-p", "test_*.py"],
            ["npm", "ci", "--ignore-scripts"], ["npm", "ls", "--all"],
            ["npm", "run", "check"], ["npm", "test"], ["npm", "pack", "--dry-run", "--json"],
        ])
        self.assertTrue(all(call.args[1] == self.workspace for call in command.call_args_list))

    def test_latest_suite_does_not_fall_back_to_locked_install(self):
        with patch.object(ci, "command") as command, patch.object(ci, "prepare_latest", return_value="1.5.0") as latest:
            self.assertEqual(ci.run_checks("latest", self.workspace), {"host": "latest", "pi": "1.5.0"})
        latest.assert_called_once_with(self.workspace)
        self.assertNotIn(["npm", "ci", "--ignore-scripts"], [call.args[0] for call in command.call_args_list])

    def test_every_command_failure_stops_remaining_checks(self):
        for index in range(9):
            with self.subTest(index=index), patch.object(ci, "command") as command:
                command.side_effect = [None] * index + [subprocess.CalledProcessError(1, "check")]
                with self.assertRaises(subprocess.CalledProcessError):
                    ci.run_checks("locked", self.workspace)
                self.assertEqual(command.call_count, index + 1)

    def test_command_helper_propagates_subprocess_failures(self):
        failure = subprocess.CalledProcessError(1, "npm test")
        with patch.object(ci.subprocess, "run", side_effect=failure) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                ci.command(["npm", "test"], self.workspace)
        run.assert_called_once_with(["npm", "test"], cwd=self.workspace, check=True)

    def test_latest_pins_exact_family_without_changing_release_or_peer_policy(self):
        with patch.object(ci, "command", return_value=MagicMock(stdout='"1.5.0"')) as command:
            with patch.object(ci, "verify_pi_family") as verify:
                self.assertEqual(ci.prepare_latest(self.workspace), "1.5.0")
        package = json.loads((self.workspace / "package.json").read_text())
        self.assertEqual(package["version"], self.package["version"])
        self.assertEqual(package["peerDependencies"], self.package["peerDependencies"])
        self.assertEqual(package["overrides"]["existing"], "1.0.0")
        self.assertTrue(package["private"])
        for name in ci.PI_PACKAGES:
            self.assertEqual(package["devDependencies"][name], "1.5.0")
            self.assertEqual(package["overrides"][name], "1.5.0")
        verify.assert_called_once_with(self.workspace, "1.5.0")
        args = command.call_args_list[0].args[0]
        self.assertIn("--registry=https://registry.npmjs.org/", args)
        self.assertIn("--prefer-online", args)
        self.assertEqual(command.call_args_list[1].args[0], ["npm", "install", "--ignore-scripts"])

    def test_latest_invalid_lookup_never_installs_or_changes_manifest(self):
        before = (self.workspace / "package.json").read_bytes()
        for value in ('"latest"', '"1.5.0\\n"', '["1.5.0"]', '{}', 'null', 'invalid json'):
            with self.subTest(value=value), patch.object(ci, "command", return_value=MagicMock(stdout=value)) as command:
                with self.assertRaises(ValueError):
                    ci.prepare_latest(self.workspace)
                self.assertEqual(command.call_count, 1)
                self.assertEqual((self.workspace / "package.json").read_bytes(), before)

    def test_latest_lookup_failure_has_no_fallback(self):
        with patch.object(ci, "command", side_effect=subprocess.CalledProcessError(1, "npm view")) as command:
            with self.assertRaises(subprocess.CalledProcessError):
                ci.prepare_latest(self.workspace)
            self.assertEqual(command.call_count, 1)

    def test_verify_checks_lock_and_actual_transitive_versions(self):
        ci.verify_pi_family(self.workspace, "1.0.3")
        for path in ("node_modules/@earendil-works/pi-schema", "node_modules/nested/node_modules/@earendil-works/pi-ai"):
            self.write_family("1.0.3")
            lock_path = self.workspace / "package-lock.json"
            lock = json.loads(lock_path.read_text())
            lock["packages"][path] = {"version": "1.0.3"}
            lock_path.write_text(json.dumps(lock))
            installed = self.workspace / path / "package.json"
            installed.parent.mkdir(parents=True, exist_ok=True)
            installed.write_text('{"version":"1.5.0"}')
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "Mixed Pi versions"):
                ci.verify_pi_family(self.workspace, "1.0.3")
        self.write_family("1.0.3")
        lock = json.loads(lock_path.read_text())
        lock["packages"]["node_modules/@earendil-works/pi-ai"]["version"] = "1.5.0"
        lock_path.write_text(json.dumps(lock))
        with self.assertRaisesRegex(ValueError, "Mixed Pi versions"):
            ci.verify_pi_family(self.workspace, "1.0.3")
        lock["packages"].pop("node_modules/@earendil-works/pi-ai")
        lock_path.write_text(json.dumps(lock))
        with self.assertRaisesRegex(ValueError, "Missing required Pi package"):
            ci.verify_pi_family(self.workspace, "1.0.3")

    def test_each_remote_input_uses_and_cleans_a_disposable_copy(self):
        visited = []
        source = self.workspace / "source"
        source.mkdir()
        (source / "marker").write_text("original")

        def checks(host, workspace):
            self.assertEqual((workspace / "marker").read_text(), "original")
            visited.append(workspace)
            (workspace / "marker").write_text("changed")
            if host == "latest":
                raise RuntimeError("test failed")
            return {"host": host, "pi": "1.0.3"}

        with patch.object(ci, "WORKSPACE", source), patch.object(ci, "run_checks", side_effect=checks):
            ci.test_host.local("locked")
            with self.assertRaisesRegex(RuntimeError, "test failed"):
                ci.test_host.local("latest")
        self.assertNotEqual(visited[0], visited[1])
        self.assertTrue(all(not path.exists() for path in visited))
        self.assertEqual((source / "marker").read_text(), "original")

    def test_invalid_host_is_rejected_before_any_work(self):
        with patch.object(ci, "command") as command, patch.object(ci.shutil, "copytree") as copy:
            for run in (ci.run_checks, lambda host, _: ci.test_host.local(host)):
                with self.assertRaises(ValueError):
                    run("untrusted", self.workspace)
            command.assert_not_called()
            copy.assert_not_called()

    def test_source_upload_is_allowlisted(self):
        image = MagicMock()
        for name in ("apt_install", "env", "workdir", "add_local_file", "add_local_dir"):
            getattr(image, name).return_value = image
        with patch.object(ci.modal, "is_local", return_value=True):
            with patch.object(ci.modal.Image, "from_registry", return_value=image) as registry:
                self.assertIs(ci.make_image(), image)
        registry.assert_called_once_with("node:22-trixie-slim", add_python="3.11")
        image.apt_install.assert_called_once_with("ripgrep", "fd-find")
        self.assertEqual(
            {str(call.args[0].relative_to(ci.ROOT)) for call in image.add_local_file.call_args_list},
            set(ci.UPLOAD_FILES),
        )
        self.assertEqual(
            {str(call.args[0].relative_to(ci.ROOT)) for call in image.add_local_dir.call_args_list},
            {"src", "test"},
        )
        self.assertFalse({".env", ".pi", ".git", "node_modules"} & set(ci.UPLOAD_FILES))

    def test_remote_import_never_inspects_dispatchers_files(self):
        image = MagicMock()
        for name in ("apt_install", "env", "workdir"):
            getattr(image, name).return_value = image
        with patch.object(ci.modal, "is_local", return_value=False):
            with patch.object(ci.modal.Image, "from_registry", return_value=image):
                with patch.object(Path, "read_text", side_effect=AssertionError("local read")):
                    self.assertIs(ci.make_image(), image)
        image.add_local_file.assert_not_called()
        image.add_local_dir.assert_not_called()


if __name__ == "__main__":
    unittest.main()
