"""Run the locked/latest Pi functional checks in one ephemeral Modal App."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

import modal


ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = Path("/workspace")
HOSTS = ("locked", "latest")
UPLOAD_FILES = (
    "package.json", "package-lock.json", "tsconfig.json", "README.md",
    "COMPATIBILITY.md", "CHANGELOG.md", "LICENSE", "ci/modal_ci.py",
    "ci/test_modal_ci.py", "ci/requirements.txt",
)
UPLOAD_DIRS = ("src", "test")
PI_PACKAGES = tuple(f"@earendil-works/{name}" for name in (
    "pi-coding-agent", "pi-agent-core", "pi-ai", "pi-codemode",
    "pi-tui", "pi-mcp", "pi-telemetry", "chord",
))
EXACT_VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", re.ASCII)
PI_PATH = re.compile(r"(?:^|/)node_modules/@earendil-works/(pi-[^/]+|chord)$")
app = modal.App("pi-escalate-ci")


def make_image():
    image = (
        modal.Image.from_registry("node:22-trixie-slim", add_python="3.11")
        .apt_install("ripgrep", "fd-find")
        .env({"CI": "true", "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/"})
        .workdir(str(WORKSPACE))
    )
    # Modal imports this module remotely too, where the dispatcher's paths do not exist.
    if not modal.is_local():
        return image
    # Upload explicit inputs, never the whole checkout or personal settings/credentials.
    for path in UPLOAD_FILES:
        image = image.add_local_file(ROOT / path, f"{WORKSPACE}/{path}")
    for path in UPLOAD_DIRS:
        image = image.add_local_dir(ROOT / path, f"{WORKSPACE}/{path}")
    return image


image = make_image()


def command(args, workspace, **kwargs):
    print(f"+ {' '.join(args)}", flush=True)
    return subprocess.run(args, cwd=workspace, check=True, **kwargs)


def prepare_latest(workspace):
    result = command([
        "npm", "view", "@earendil-works/pi-coding-agent@latest", "version", "--json",
        "--registry=https://registry.npmjs.org/", "--prefer-online",
    ], workspace, capture_output=True, text=True)
    version = json.loads(result.stdout)
    if not isinstance(version, str) or not EXACT_VERSION.fullmatch(version):
        raise ValueError(f"npm returned an invalid exact Pi version: {version!r}")
    print(f"Testing npm latest Pi {version}", flush=True)
    manifest = workspace / "package.json"
    package = json.loads(manifest.read_text())
    package["private"] = True
    for name in PI_PACKAGES:
        package.setdefault("devDependencies", {})[name] = version
        package.setdefault("overrides", {})[name] = version
    manifest.write_text(json.dumps(package, indent=2) + "\n")
    command(["npm", "install", "--ignore-scripts"], workspace)
    verify_pi_family(workspace, version)
    return version


def verify_pi_family(workspace, version):
    lock = json.loads((workspace / "package-lock.json").read_text())
    for name in PI_PACKAGES:
        if f"node_modules/{name}" not in lock["packages"]:
            raise ValueError(f"Missing required Pi package: {name}")
    for path, package in lock["packages"].items():
        if not PI_PATH.search(path):
            continue
        installed = json.loads((workspace / path / "package.json").read_text())
        if package["version"] != version or installed["version"] != version:
            raise ValueError(f"Mixed Pi versions at {path}: expected {version}")


def run_checks(host, workspace):
    if host not in HOSTS:
        raise ValueError(f"Unsupported host: {host}")
    command(["node", "--version"], workspace)
    command(["rg", "--version"], workspace)
    command(["fdfind", "--version"], workspace)
    command(["python", "-m", "unittest", "discover", "-s", "ci", "-p", "test_*.py"], workspace)
    if host == "latest":
        version = prepare_latest(workspace)
    else:
        command(["npm", "ci", "--ignore-scripts"], workspace)
        version = json.loads((workspace / "node_modules/@earendil-works/pi-coding-agent/package.json").read_text())["version"]
    print(f"Running {host} checks with Pi {version}", flush=True)
    for args in (
        ["npm", "ls", "--all"],
        ["npm", "run", "check"],
        ["npm", "test"],
        ["npm", "pack", "--dry-run", "--json"],
    ):
        command(args, workspace)
    return {"host": host, "pi": version}


@app.function(image=image, cpu=1, memory=2048, timeout=900, retries=0, max_containers=2)
def test_host(host: str):
    if host not in HOSTS:
        raise ValueError(f"Unsupported host: {host}")
    print(f"Running {host} in Modal task {os.environ.get('MODAL_TASK_ID', 'unknown')}", flush=True)
    # A warm container may be reused; every input still gets a clean checkout.
    with tempfile.TemporaryDirectory(prefix="pi-escalate-ci-") as directory:
        workspace = Path(directory) / "checkout"
        shutil.copytree(WORKSPACE, workspace)
        return run_checks(host, workspace)


@app.local_entrypoint()
def matrix():
    """One App, two parallel container inputs; collect all failures before exiting."""
    results = list(test_host.map(HOSTS, return_exceptions=True))
    failures = []
    lines = ["## Pi compatibility on Modal\n"]
    for host, result in zip(HOSTS, results, strict=True):
        if isinstance(result, BaseException):
            failures.append(host)
            print(f"FAIL {host}: {result}", flush=True)
            lines.append(f"- FAIL: {host}\n")
        else:
            print(f"PASS {host}: Pi {result['pi']}", flush=True)
            lines.append(f"- PASS: {host} / Pi {result['pi']}\n")
    if path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(path, "a") as stream:
            stream.writelines(lines)
    if failures:
        raise RuntimeError(f"Modal compatibility failures: {failures}")
