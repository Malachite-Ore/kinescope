import sys
import os
import shutil
import tempfile

# Add project root to path so build_exe is importable from anywhere
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import build_exe
    print("[TEST] Successfully imported build_exe.")
except Exception as e:
    print(f"[TEST ERROR] Failed to import build_exe: {e}")
    sys.exit(1)

# Deliberately awkward payloads: non-ASCII and emoji in the history, backslashes
# in the settings path. Both files are copied as raw bytes, so a text-mode
# regression would corrupt these rather than fail loudly.
HISTORY = '[{"title": "\u00e9 unicode \U0001F3AC", "url": "https://x/y"}]'.encode('utf-8')
SETTINGS = b'{"download_dir": "C:\\\\Users\\\\HP\\\\Downloads"}'

failures = []


def check(name, passed):
    print(f"[TEST RESULT] {'PASS' if passed else 'FAIL'} - {name}")
    if not passed:
        failures.append(name)


def seed_dist(dist_dir, history=True, settings=True):
    """Creates a dist/ holding the user data a previous build would have left."""
    os.makedirs(dist_dir, exist_ok=True)
    if history:
        with open(os.path.join(dist_dir, 'history.json'), 'wb') as f:
            f.write(HISTORY)
    if settings:
        with open(os.path.join(dist_dir, 'settings.json'), 'wb') as f:
            f.write(SETTINGS)


def read_bytes(path):
    """Returns None for a missing file rather than raising, so a restore that
    silently drops a file reports a readable FAIL instead of a traceback."""
    try:
        with open(path, 'rb') as f:
            return f.read()
    except FileNotFoundError:
        return None


def test_successful_build():
    """User data survives the rmtree that clears dist/ before a build."""
    print("[TEST] Successful build preserves both files...")
    with tempfile.TemporaryDirectory() as root:
        dist_dir = os.path.join(root, 'dist')
        seed_dist(dist_dir)

        saved = build_exe.read_user_data(dist_dir)
        shutil.rmtree(dist_dir)
        try:
            pass  # stands in for a PyInstaller run that succeeds
        finally:
            build_exe.restore_user_data(dist_dir, saved)

        check("history.json survives byte-identical",
              read_bytes(os.path.join(dist_dir, 'history.json')) == HISTORY)
        check("settings.json survives byte-identical",
              read_bytes(os.path.join(dist_dir, 'settings.json')) == SETTINGS)


def test_failed_build():
    """A compile that raises must not cost the user their history either."""
    print("[TEST] Failed build still restores (the finally path)...")
    with tempfile.TemporaryDirectory() as root:
        dist_dir = os.path.join(root, 'dist')
        seed_dist(dist_dir)

        saved = build_exe.read_user_data(dist_dir)
        shutil.rmtree(dist_dir)
        raised = False
        try:
            try:
                raise RuntimeError("simulated PyInstaller failure")
            finally:
                build_exe.restore_user_data(dist_dir, saved)
        except RuntimeError:
            raised = True

        check("build error still propagates", raised)
        check("dist/ recreated after failure", os.path.isdir(dist_dir))
        check("history.json survives a failed build",
              read_bytes(os.path.join(dist_dir, 'history.json')) == HISTORY)
        check("settings.json survives a failed build",
              read_bytes(os.path.join(dist_dir, 'settings.json')) == SETTINGS)


def test_first_ever_build():
    """No user data yet: collect nothing, and don't leave an empty dist/."""
    print("[TEST] First-ever build with no user data...")
    with tempfile.TemporaryDirectory() as root:
        dist_dir = os.path.join(root, 'dist')
        os.makedirs(dist_dir)

        saved = build_exe.read_user_data(dist_dir)
        check("nothing collected", saved == {})

        shutil.rmtree(dist_dir)
        build_exe.restore_user_data(dist_dir, saved)
        check("no empty dist/ conjured up", not os.path.exists(dist_dir))


def test_partial_user_data():
    """Only one of the two files present: restore it, invent nothing."""
    print("[TEST] Only settings.json present...")
    with tempfile.TemporaryDirectory() as root:
        dist_dir = os.path.join(root, 'dist')
        seed_dist(dist_dir, history=False)

        saved = build_exe.read_user_data(dist_dir)
        check("collected just the one", sorted(saved) == ['settings.json'])

        shutil.rmtree(dist_dir)
        build_exe.restore_user_data(dist_dir, saved)
        check("settings.json restored",
              read_bytes(os.path.join(dist_dir, 'settings.json')) == SETTINGS)
        check("no phantom history.json",
              not os.path.exists(os.path.join(dist_dir, 'history.json')))


if __name__ == '__main__':
    test_successful_build()
    test_failed_build()
    test_first_ever_build()
    test_partial_user_data()

    print()
    if failures:
        print(f"[TEST ERROR] {len(failures)} check(s) failed: {', '.join(failures)}")
        sys.exit(1)
    print("[TEST RESULT] All checks passed.")
