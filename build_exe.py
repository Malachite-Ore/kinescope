import os
import sys
import subprocess
import shutil

def log(msg):
    print(f"[KINESCOPE COMPILER] {msg}")

# The packaged app writes these next to its own executable, so they live inside
# dist/ and would be destroyed when it's cleared for a rebuild. history.json is
# a user's entire download log; settings.json holds their download directory,
# ffmpeg path, and cookie preferences. Neither is reproducible.
USER_DATA_FILES = ('settings.json', 'history.json')

def read_user_data(dist_dir):
    """Reads any user data sitting in dist/ into memory before it's cleared."""
    saved = {}
    for name in USER_DATA_FILES:
        path = os.path.join(dist_dir, name)
        if not os.path.exists(path):
            continue
        try:
            with open(path, 'rb') as f:
                saved[name] = f.read()
        except Exception as e:
            log(f"Warning: could not read {name} to preserve it: {e}")
    return saved

def restore_user_data(dist_dir, saved):
    """Writes preserved user data back beside the freshly built executable.

    Called from a finally block, so a failed compile doesn't cost the user their
    history either. PyInstaller never emits these names itself, so there is
    nothing here to overwrite.
    """
    if not saved:
        return
    try:
        os.makedirs(dist_dir, exist_ok=True)
    except Exception as e:
        log(f"Warning: could not recreate dist/ to restore user data: {e}")
        return
    for name, blob in saved.items():
        try:
            with open(os.path.join(dist_dir, name), 'wb') as f:
                f.write(blob)
            log(f"Restored {name} alongside the new build.")
        except Exception as e:
            log(f"Warning: could not restore {name}: {e}")

def main():
    root_dir = os.path.dirname(os.path.abspath(__file__))
    
    # 1. Verify paths and executable locations based on Platform
    venv_dir = os.path.join(root_dir, ".venv")
    if sys.platform == "win32":
        pip_exe = os.path.join(venv_dir, "Scripts", "pip.exe")
        python_exe = os.path.join(venv_dir, "Scripts", "python.exe")
        pyinstaller_exe = os.path.join(venv_dir, "Scripts", "pyinstaller.exe")
        npm_cmd = "npm.cmd"
    else:
        pip_exe = os.path.join(venv_dir, "bin", "pip")
        python_exe = os.path.join(venv_dir, "bin", "python")
        pyinstaller_exe = os.path.join(venv_dir, "bin", "pyinstaller")
        npm_cmd = "npm"

    if not os.path.exists(venv_dir):
        log("Virtual environment not found. Please run run.py first to initialize!")
        sys.exit(1)

    # 2. Ensure PyInstaller and Pillow are installed in venv
    log("Verifying PyInstaller and Pillow dependencies...")
    subprocess.run([python_exe, "-m", "pip", "install", "pyinstaller", "pillow"], check=True)

    # 3. Generate Platform-Specific Icon if missing
    icon_ext = "ico" if sys.platform == "win32" else "icns"
    icon_file = f"icon.{icon_ext}"
    icon_path = os.path.join(root_dir, icon_file)
    
    if not os.path.exists(icon_path):
        source_png = os.path.join(root_dir, "backend", "icon.png")
        if os.path.exists(source_png):
            log(f"Generating custom {icon_file} from backend/icon.png...")
            if icon_ext == "ico":
                # Multi-size windows ICO generator
                generator_code = f"""
from PIL import Image
img = Image.open(r"{source_png}")
img.save(r"{icon_path}", format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
"""
            else:
                # macOS ICNS generator
                generator_code = f"""
from PIL import Image
img = Image.open(r"{source_png}")
img.save(r"{icon_path}", format="ICNS")
"""
            subprocess.run([python_exe, "-c", generator_code], check=True)
            log("Icon generated successfully.")
        else:
            log("Warning: backend/icon.png not found. Falling back on default icon.")

    # 4. Compile React assets
    frontend_dir = os.path.join(root_dir, "frontend")
    log("Compiling React static assets...")
    subprocess.run(f"{npm_cmd} run build", cwd=frontend_dir, shell=True, check=True)
    log("React assets compiled successfully.")

    # 5. Clean up old build outputs, rescuing user data from dist/ first
    dist_dir = os.path.join(root_dir, 'dist')
    preserved = read_user_data(dist_dir)
    if preserved:
        log(f"Preserving {', '.join(sorted(preserved))} across the rebuild...")

    for folder in ['build', 'dist']:
        path = os.path.join(root_dir, folder)
        if os.path.exists(path):
            log(f"Clearing old {folder} directory...")
            try:
                shutil.rmtree(path)
            except Exception as e:
                log(f"Warning: Could not clear {folder}: {e}")
            
    spec_file = os.path.join(root_dir, "Kinescope.spec")
    if os.path.exists(spec_file):
        try:
            os.remove(spec_file)
        except Exception as e:
            log(f"Warning: Could not delete spec file: {e}")

    # 6. Run PyInstaller
    log("Invoking PyInstaller to bundle Kinescope...")
    
    # Configure cross-platform data delimiters
    separator = ';' if sys.platform == "win32" else ":"
    add_data_arg = f"frontend/dist{separator}frontend/dist"
    
    cmd = [
        python_exe,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--windowed",
        "--name=Kinescope",
        f"--add-data={add_data_arg}",
        "--collect-all=webview",
        "--collect-all=yt_dlp"
    ]
    
    if sys.platform == "win32":
        cmd.append("--collect-all=clr")
        cmd.append("--collect-all=pythonnet")
        
    # Bundle local bin directory if it exists (e.g. prepared by CI/CD)
    bin_dir_path = os.path.join(root_dir, "bin")
    if os.path.exists(bin_dir_path):
        log("Local bin/ directory detected. Bundling FFmpeg binaries into executable...")
        cmd.append(f"--add-data=bin{separator}bin")
    
    # Append icon argument if generated successfully
    if os.path.exists(icon_path):
        cmd.append(f"--icon={icon_path}")
        
    cmd.append(os.path.join(root_dir, "backend", "main.py"))
    
    log(f"Executing: {' '.join(cmd)}")
    try:
        subprocess.run(cmd, check=True)
    finally:
        restore_user_data(dist_dir, preserved)

    # 7. Report compilation result
    if sys.platform == "win32":
        compiled_path = os.path.join(dist_dir, "Kinescope.exe")
    else:
        compiled_path = os.path.join(dist_dir, "Kinescope.app")
        
    if os.path.exists(compiled_path):
        log("====================================================")
        log("STANDALONE BUNDLE BUILD SUCCESSFUL!")
        log(f"Portable app is located at: {compiled_path}")
        log("====================================================")
    else:
        log("Compilation complete, but output was not found in dist/.")
        sys.exit(1)

if __name__ == "__main__":
    main()
