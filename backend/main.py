import os
import sys
import json
import threading
import subprocess
import urllib.request
import zipfile
import io
import shutil
import time
import webview
from webview import FileDialog
import yt_dlp

try:
    # Raised (and chained onto the surfaced DownloadError) whenever yt-dlp cannot
    # read a cookie store. Lets us tell "your browser is locked" apart from
    # "the site rejected us", which look identical in the error text.
    from yt_dlp.cookies import CookieLoadError
except ImportError:  # yt-dlp older than 2024.12
    CookieLoadError = None


def _browser_cookie_roots():
    """Maps each supported browser to the profile folders that hold its cookie
    store. Insertion order doubles as the auto-detect preference order."""
    home = os.path.expanduser('~')

    if sys.platform == 'win32':
        local = os.environ.get('LOCALAPPDATA') or os.path.join(home, 'AppData', 'Local')
        roaming = os.environ.get('APPDATA') or os.path.join(home, 'AppData', 'Roaming')
        return {
            'chrome':   [os.path.join(local, 'Google', 'Chrome', 'User Data')],
            'edge':     [os.path.join(local, 'Microsoft', 'Edge', 'User Data')],
            'firefox':  [os.path.join(roaming, 'Mozilla', 'Firefox')],
            'brave':    [os.path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
            'vivaldi':  [os.path.join(local, 'Vivaldi', 'User Data')],
            'opera':    [os.path.join(roaming, 'Opera Software', 'Opera Stable')],
            'chromium': [os.path.join(local, 'Chromium', 'User Data')],
        }

    if sys.platform == 'darwin':
        app = os.path.join(home, 'Library', 'Application Support')
        return {
            'chrome':   [os.path.join(app, 'Google', 'Chrome')],
            'safari':   [os.path.join(home, 'Library', 'Cookies'),
                         os.path.join(home, 'Library', 'Containers', 'com.apple.Safari',
                                      'Data', 'Library', 'Cookies')],
            'firefox':  [os.path.join(app, 'Firefox')],
            'edge':     [os.path.join(app, 'Microsoft Edge')],
            'brave':    [os.path.join(app, 'BraveSoftware', 'Brave-Browser')],
            'vivaldi':  [os.path.join(app, 'Vivaldi')],
            'opera':    [os.path.join(app, 'com.operasoftware.Opera')],
            'chromium': [os.path.join(app, 'Chromium')],
        }

    config = os.environ.get('XDG_CONFIG_HOME') or os.path.join(home, '.config')
    return {
        'chrome':   [os.path.join(config, 'google-chrome')],
        'firefox':  [os.path.join(home, '.mozilla', 'firefox'),
                     os.path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox')],
        'edge':     [os.path.join(config, 'microsoft-edge')],
        'brave':    [os.path.join(config, 'BraveSoftware', 'Brave-Browser')],
        'vivaldi':  [os.path.join(config, 'vivaldi')],
        'opera':    [os.path.join(config, 'opera')],
        'chromium': [os.path.join(config, 'chromium'),
                     os.path.join(home, 'snap', 'chromium', 'common', 'chromium')],
    }


def _clean_error(exc):
    """Strips yt-dlp's console prefix so a message reads well in the UI."""
    return str(exc).replace('ERROR: ', '').strip()


class Api:
    def __init__(self):
        self._window = None
        self._custom_ffmpeg_dir = None
        self._custom_ffmpeg_exe = None  # full path to ffmpeg executable
        self._cancelled = set()         # job_ids asked to cancel
        self._active_jobs = set()       # job_ids currently running
        self._emit_lock = threading.Lock()  # serialize evaluate_js across worker threads

    def cancel_download(self, job_id=None):
        """Signals download thread(s) to abort. No job_id => halt every active job."""
        if job_id is None:
            self._cancelled |= set(self._active_jobs)
        else:
            self._cancelled.add(str(job_id))
        return {'success': True}

    def _get_ffmpeg_name(self):
        return 'ffmpeg.exe' if sys.platform == 'win32' else 'ffmpeg'

    def _get_ffprobe_name(self):
        return 'ffprobe.exe' if sys.platform == 'win32' else 'ffprobe'

    def _get_bin_dir(self):
        """Returns the local bin folder path (persisted outside temp folder)."""
        if getattr(sys, 'frozen', False):
            exe_dir = os.path.dirname(sys.executable)
        else:
            exe_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return os.path.join(exe_dir, 'bin')

    def _get_settings_path(self):
        """Returns path to settings.json, next to the exe or at project root."""
        return os.path.join(os.path.dirname(self._get_bin_dir()), 'settings.json')

    def _default_settings(self):
        """Shape returned by load_settings, with out-of-the-box defaults.

        Authentication defaults to ON with auto-detected browser cookies: most
        sources now gate ordinary videos behind a sign-in check, and a missing or
        unreadable cookie store degrades to a signed-out attempt rather than an
        error (see _run_ydl), so leaving it armed costs nothing.
        """
        return {
            'ffmpeg_path': None,
            'download_dir': None,
            'filename_template': '',
            'cookies_mode': 'browser',
            'cookies_browser': 'auto',
            'cookies_file': '',
            'video_codec': '',
        }

    def load_settings(self):
        """Reads settings.json and populates internal ffmpeg state. Never raises."""
        settings = self._default_settings()
        try:
            path = self._get_settings_path()
            if not os.path.exists(path):
                return settings
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            ffmpeg_path = data.get('ffmpeg_path')
            if ffmpeg_path and os.path.exists(ffmpeg_path):
                self._custom_ffmpeg_exe = ffmpeg_path
                self._custom_ffmpeg_dir = os.path.dirname(ffmpeg_path)
            else:
                ffmpeg_path = None
            for key in settings:
                if key in data and data[key] is not None:
                    settings[key] = data[key]
            settings['ffmpeg_path'] = ffmpeg_path
            return settings
        except Exception:
            return self._default_settings()

    def save_setting(self, key, value):
        """Persists a single key to settings.json."""
        valid_keys = {'ffmpeg_path', 'download_dir', 'filename_template', 'cookies_mode',
                      'cookies_browser', 'cookies_file', 'video_codec'}
        if key not in valid_keys:
            return {'success': False, 'error': f'Unknown key: {key}'}
        try:
            path = self._get_settings_path()
            data = {}
            if os.path.exists(path):
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
            data[key] = value
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    # ---- History log ------------------------------------------------------

    def _get_history_path(self):
        """Returns path to history.json, next to settings.json."""
        return os.path.join(os.path.dirname(self._get_bin_dir()), 'history.json')

    def load_history(self):
        """Reads the archival history (newest first). Never raises."""
        try:
            path = self._get_history_path()
            if not os.path.exists(path):
                return {'history': []}
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if not isinstance(data, list):
                data = []
            return {'history': data}
        except Exception:
            return {'history': []}

    def append_history(self, entry):
        """Inserts a completed transmission at the front of the log (unbounded)."""
        try:
            path = self._get_history_path()
            history = self.load_history().get('history', [])
            record = dict(entry or {})
            record['time'] = time.time()
            history.insert(0, record)
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(history, f, indent=2)
            return {'success': True, 'history': history}
        except Exception as e:
            return {'success': False, 'error': str(e), 'history': []}

    def clear_history(self):
        """Wipes the archival history log."""
        try:
            with open(self._get_history_path(), 'w', encoding='utf-8') as f:
                json.dump([], f)
            return {'success': True, 'history': []}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def open_path(self, path):
        """Reveals a file/folder in the system file browser."""
        try:
            if not path:
                return {'success': False, 'error': 'No path provided.'}
            if not os.path.exists(path):
                # Fall back to the parent directory if the exact file is gone.
                path = os.path.dirname(path)
                if not os.path.exists(path):
                    return {'success': False, 'error': 'Path no longer exists.'}
            if sys.platform == 'win32':
                os.startfile(path)  # noqa: SLF / Windows-only
            elif sys.platform == 'darwin':
                subprocess.run(['open', path], check=False)
            else:
                subprocess.run(['xdg-open', path], check=False)
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    # ---- Timestamp helper -------------------------------------------------

    def _parse_timestamp(self, ts):
        """Parses 'HH:MM:SS', 'MM:SS', or plain seconds into float seconds."""
        if ts is None:
            return None
        ts = str(ts).strip()
        if not ts:
            return None
        try:
            parts = [float(p) for p in ts.split(':')]
        except ValueError:
            return None
        seconds = 0.0
        for p in parts:
            seconds = seconds * 60 + p
        return seconds

    # ---- Authentication ---------------------------------------------------

    def detect_browsers(self):
        """Lists browsers that actually have a cookie store on this machine,
        most-preferred first, so the UI can arm authentication without the user
        having to know which browser to name."""
        found = [name for name, roots in _browser_cookie_roots().items()
                 if any(os.path.exists(p) for p in roots)]
        return {'browsers': found, 'default': found[0] if found else ''}

    def _cookie_opts(self, cookies):
        """Maps the UI's authentication choice onto yt-dlp options.
        An empty dict means "run signed out"."""
        if not cookies:
            return {}
        kind = cookies.get('type')
        if kind == 'browser':
            browser = (cookies.get('browser') or 'auto').lower()
            if browser == 'auto':
                browser = self.detect_browsers()['default']
            if browser:
                return {'cookiesfrombrowser': (browser, None, None, None)}
        elif kind == 'file':
            path = cookies.get('file') or ''
            if path and os.path.exists(path):
                return {'cookiefile': path}
        return {}

    @staticmethod
    def _is_cookie_error(exc):
        """True when the failure came from reading the cookie store rather than
        from the site itself. yt-dlp surfaces these as a DownloadError with a
        CookieLoadError chained behind it, so walk the chain."""
        seen = set()
        while exc is not None and id(exc) not in seen:
            seen.add(id(exc))
            if CookieLoadError is not None:
                if isinstance(exc, CookieLoadError):
                    return True
            elif 'failed to load cookies' in str(exc).lower():
                return True
            exc = exc.__cause__ or exc.__context__
        return False

    def _run_ydl(self, base_opts, cookies, action):
        """Runs `action(ydl)` with authentication applied, retrying once signed
        out when the cookie store can't be read — browser not installed, profile
        locked while it's open, or cookies the OS won't hand over.

        Returns (result, warning) where warning is None on a clean run. This is
        what lets browser cookies stay armed by default: an unreadable store
        costs a retry, not a failed download.
        """
        cookie_opts = self._cookie_opts(cookies)
        warning = None
        if cookie_opts:
            try:
                with yt_dlp.YoutubeDL({**base_opts, **cookie_opts}) as ydl:
                    return action(ydl), None
            except Exception as e:
                if not self._is_cookie_error(e):
                    raise
                warning = f"Couldn't read your sign-in cookies ({_clean_error(e)}) — continuing signed out."
        with yt_dlp.YoutubeDL(base_opts) as ydl:
            return action(ydl), warning

    def get_playlist_info(self, url, options=None):
        """Lists the entries of a playlist without resolving each video fully."""
        try:
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'extract_flat': True,
                'nocheckcertificate': True,
            }
            info, cookie_warning = self._run_ydl(
                ydl_opts, (options or {}).get('cookies'),
                lambda ydl: ydl.extract_info(url, download=False)
            )

            entries_raw = info.get('entries')
            if not entries_raw:
                return {'success': False, 'is_playlist': False,
                        'error': 'No playlist entries found at this URL.'}

            entries = []
            for e in entries_raw:
                if not e:
                    continue
                dur = e.get('duration')
                if isinstance(dur, (int, float)) and dur > 0:
                    dur = int(dur)
                    duration_str = f"{dur // 60:02d}:{dur % 60:02d}"
                else:
                    duration_str = '--:--'
                entries.append({
                    'url': e.get('url') or e.get('webpage_url') or e.get('id'),
                    'title': e.get('title') or 'Untitled entry',
                    'uploader': e.get('uploader') or e.get('channel') or '',
                    'duration': duration_str,
                })

            return {
                'success': True,
                'is_playlist': True,
                'title': info.get('title', 'Untitled Playlist'),
                'uploader': info.get('uploader') or info.get('channel') or 'Unknown Source',
                'count': len(entries),
                'entries': entries,
                'cookie_warning': cookie_warning,
            }
        except Exception as e:
            return {'success': False, 'is_playlist': False, 'error': _clean_error(e)}

    def check_dependencies(self):
        """Checks if ffmpeg is available in any known location."""
        ffmpeg_path = None
        ffmpeg_name = self._get_ffmpeg_name()

        # 1. Settings-saved exe (most authoritative)
        if self._custom_ffmpeg_exe and os.path.exists(self._custom_ffmpeg_exe):
            ffmpeg_path = self._custom_ffmpeg_exe

        # 2. System PATH
        if not ffmpeg_path:
            system_ffmpeg = shutil.which('ffmpeg')
            if system_ffmpeg:
                ffmpeg_path = system_ffmpeg

        # 2.5 Bundled PyInstaller temp folder
        if not ffmpeg_path and getattr(sys, 'frozen', False):
            temp_bin = os.path.join(sys._MEIPASS, 'bin', ffmpeg_name)
            if os.path.exists(temp_bin):
                ffmpeg_path = temp_bin

        # 3. Default local bin folder
        if not ffmpeg_path:
            local = os.path.join(self._get_bin_dir(), ffmpeg_name)
            if os.path.exists(local):
                ffmpeg_path = local

        # 4. Custom dir from current session
        if not ffmpeg_path and self._custom_ffmpeg_dir:
            local = os.path.join(self._custom_ffmpeg_dir, ffmpeg_name)
            if os.path.exists(local):
                ffmpeg_path = local

        return {
            'ffmpeg': ffmpeg_path is not None,
            'ffmpeg_path': ffmpeg_path,
            'yt_dlp': True,
        }

    def get_default_ffmpeg_dir(self):
        """Returns the default directory where ffmpeg would be installed locally."""
        return self._get_bin_dir()

    def select_folder(self):
        """Opens native directory selector dialog."""
        if not self._window:
            return None
        result = self._window.create_file_dialog(FileDialog.FOLDER)
        if result and len(result) > 0:
            return result[0]
        return None

    def get_clipboard(self):
        """Returns the current clipboard text (used for URL ghost-text suggestion)."""
        try:
            if sys.platform == 'win32':
                text = subprocess.check_output(
                    ['powershell', '-NoProfile', '-Command', 'Get-Clipboard'],
                    text=True, timeout=2
                ).strip()
            elif sys.platform == 'darwin':
                text = subprocess.check_output(['pbpaste'], text=True, timeout=2).strip()
            else:
                return {'text': ''}
            return {'text': text}
        except Exception:
            return {'text': ''}

    @staticmethod
    def _version_key(version):
        """Turns a yt-dlp version ('2026.07.04', '2026.7.4.123456') into a
        comparable tuple. PyPI and GitHub disagree on zero-padding, so comparing
        the raw strings would call a padded build older than an unpadded one."""
        parts = []
        for chunk in str(version).split('.'):
            try:
                parts.append(int(chunk))
            except ValueError:
                break
        return tuple(parts)

    def check_ytdlp_update(self):
        """Checks GitHub for a newer yt-dlp release than the bundled version."""
        try:
            import yt_dlp.version
            current = yt_dlp.version.__version__
            req = urllib.request.Request(
                'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest',
                headers={'User-Agent': 'Kinescope'}
            )
            with urllib.request.urlopen(req, timeout=5) as r:
                data = json.loads(r.read())
            latest = data.get('tag_name', '').lstrip('v')
            if not latest:
                return {'current': current, 'latest': '', 'up_to_date': True}
            up_to_date = self._version_key(current) >= self._version_key(latest)
            return {'current': current, 'latest': latest, 'up_to_date': up_to_date}
        except Exception:
            return {'current': '', 'latest': '', 'up_to_date': True}

    def select_file(self):
        """Opens native file picker for selecting an existing executable."""
        if not self._window:
            return None
        if sys.platform == 'win32':
            file_types = ('Executable (*.exe)', 'All files (*.*)')
        else:
            file_types = ('All files (*.*)',)
        result = self._window.create_file_dialog(
            FileDialog.OPEN,
            file_types=file_types
        )
        if result and len(result) > 0:
            return result[0]
        return None

    def select_cookie_file(self):
        """Opens native file picker for selecting a Netscape cookies.txt file."""
        if not self._window:
            return None
        file_types = ('Cookie files (*.txt)', 'All files (*.*)')
        result = self._window.create_file_dialog(FileDialog.OPEN, file_types=file_types)
        if result and len(result) > 0:
            return result[0]
        return None

    def validate_ffmpeg_exe(self, path):
        """Validates that the given path is a working ffmpeg executable."""
        try:
            if not os.path.isfile(path):
                return {'valid': False, 'error': 'File does not exist.'}
            result = subprocess.run(
                [path, '-version'],
                capture_output=True,
                text=True,
                timeout=5
            )
            output = (result.stdout + result.stderr).lower()
            if result.returncode == 0 and 'ffmpeg' in output:
                self._custom_ffmpeg_exe = path
                self._custom_ffmpeg_dir = os.path.dirname(path)
                return {'valid': True}
            return {'valid': False, 'error': 'File did not respond as ffmpeg.'}
        except subprocess.TimeoutExpired:
            return {'valid': False, 'error': 'Timed out — not an ffmpeg executable.'}
        except Exception as e:
            return {'valid': False, 'error': str(e)}

    def get_default_download_dir(self):
        """Returns the system default Downloads folder."""
        return os.path.join(os.path.expanduser('~'), 'Downloads')

    def get_video_info(self, url, options=None):
        """Extracts video metadata without downloading."""
        try:
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'extract_flat': False,
                'nocheckcertificate': True
            }
            info, cookie_warning = self._run_ydl(
                ydl_opts, (options or {}).get('cookies'),
                lambda ydl: ydl.extract_info(url, download=False)
            )

            if 'entries' in info:
                return {
                    'success': False,
                    'is_playlist': True,
                    'error': 'This URL is a playlist. Open the playlist browser to pick entries.'
                }

            duration_secs = info.get('duration', 0)
            minutes = duration_secs // 60
            seconds = duration_secs % 60
            duration_str = f"{minutes:02d}:{seconds:02d}"

            # Scan streams: is there video at all, and what real heights exist?
            raw_formats = info.get('formats', []) or []
            has_video = False
            available_heights = set()
            for f in raw_formats:
                if f.get('vcodec') and f.get('vcodec') != 'none':
                    has_video = True
                    h = f.get('height')
                    if isinstance(h, int) and h > 0:
                        available_heights.add(h)

            formats = [{'id': 'bestvideo+bestaudio/best', 'note': 'Best Quality (Default)'}]

            # Quality ladder, ascending. Each rung owns the band (prev, height]; we
            # only offer a rung when a real stream falls inside its band, so the menu
            # mirrors exactly what the source actually serves (no phantom 144p on a
            # video whose floor is 360p). yt-dlp picks the best stream <= the rung.
            ladder = [
                (144,  'bestvideo[height<=144]+bestaudio/best',  '144p'),
                (240,  'bestvideo[height<=240]+bestaudio/best',  '240p'),
                (360,  'bestvideo[height<=360]+bestaudio/best',  '360p SD'),
                (480,  'bestvideo[height<=480]+bestaudio/best',  '480p SD'),
                (720,  'bestvideo[height<=720]+bestaudio/best',  '720p HD'),
                (1080, 'bestvideo[height<=1080]+bestaudio/best', '1080p FHD'),
                (1440, 'bestvideo[height<=1440]+bestaudio/best', '2K QHD (1440p)'),
                (2160, 'bestvideo[height<=2160]+bestaudio/best', '4K UHD (2160p)'),
                (4320, 'bestvideo[height<=4320]+bestaudio/best', '8K UHD (4320p)'),
            ]

            if available_heights:
                prev = 0
                rungs = []
                for h, fmt_id, note in ladder:
                    if any(prev < ah <= h for ah in available_heights):
                        rungs.append({'id': fmt_id, 'note': note})
                    prev = h
                formats.extend(reversed(rungs))  # best -> worst, matching prior order
            else:
                # Fallback for sites where heights don't resolve but video exists.
                # These selectors end in /best, so they degrade gracefully per-video.
                if has_video:
                    formats.extend([
                        {'id': 'bestvideo[height<=1080]+bestaudio/best', 'note': '1080p FHD'},
                        {'id': 'bestvideo[height<=720]+bestaudio/best', 'note': '720p HD'},
                        {'id': 'bestvideo[height<=480]+bestaudio/best', 'note': '480p SD'}
                    ])

            formats.append({'id': 'bestaudio/best', 'note': 'Audio Only (MP3)'})

            # Caption tracks: manual subtitles first, then automatic captions.
            subs_info = info.get('subtitles') or {}
            auto_info = info.get('automatic_captions') or {}
            subtitles = []
            seen_langs = set()
            for code in subs_info.keys():
                seen_langs.add(code)
                subtitles.append({'code': code, 'name': code, 'auto': False})
            for code in auto_info.keys():
                if code in seen_langs:
                    continue
                subtitles.append({'code': code, 'name': f'{code} (auto)', 'auto': True})

            return {
                'success': True,
                'title': info.get('title', 'Unknown Title'),
                'uploader': info.get('uploader', 'Unknown Creator'),
                'duration': duration_str,
                'thumbnail': info.get('thumbnail', ''),
                'id': info.get('id', ''),
                'upload_date': info.get('upload_date', ''),  # yt-dlp format: YYYYMMDD
                'formats': formats,
                'subtitles': subtitles,
                'cookie_warning': cookie_warning,
            }
        except Exception as e:
            return {'success': False, 'error': _clean_error(e)}

    def start_download(self, url, download_dir, format_id, options=None, job_id=None):
        """Launches a video download in its own thread, tagged with a job_id."""
        job_id = str(job_id) if job_id is not None else 'single'
        self._cancelled.discard(job_id)
        self._active_jobs.add(job_id)
        thread = threading.Thread(
            target=self._download_worker,
            args=(url, download_dir, format_id, options or {}, job_id)
        )
        thread.daemon = True
        thread.start()
        return {'status': 'started', 'job_id': job_id}

    def install_ffmpeg(self, target_dir=''):
        """Launches automatic local FFmpeg downloader in a separate thread."""
        install_dir = target_dir.strip() if target_dir and target_dir.strip() else self._get_bin_dir()
        self._custom_ffmpeg_dir = install_dir
        thread = threading.Thread(target=self._ffmpeg_downloader_worker, args=(install_dir,))
        thread.daemon = True
        thread.start()
        return {'status': 'started'}

    def _download_direct_binary(self, url, dest_path, name, progress_range):
        start_pct, end_pct = progress_range
        import ssl
        context = ssl._create_unverified_context()
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, context=context) as response:
            total_size = int(response.headers.get('content-length', 0))
            downloaded = 0
            block_size = 512 * 1024
            start_time = time.time()
            
            with open(dest_path, 'wb') as target:
                while True:
                    buffer = response.read(block_size)
                    if not buffer:
                        break
                    downloaded += len(buffer)
                    target.write(buffer)
                    
                    elapsed = time.time() - start_time
                    speed_val = downloaded / elapsed if elapsed > 0 else 0
                    speed_str = (f"{speed_val / (1024 * 1024):.1f} MB/s"
                                 if speed_val > 1024 * 1024
                                 else f"{speed_val / 1024:.1f} KB/s")
                    
                    inner_pct = (downloaded / total_size) if total_size > 0 else 0
                    percent = start_pct + inner_pct * (end_pct - start_pct)
                    
                    self._send_progress({
                        'status': 'downloading',
                        'percent': percent,
                        'speed': speed_str,
                        'downloaded': f"{downloaded / (1024 * 1024):.1f} MB",
                        'total': f"{total_size / (1024 * 1024):.1f} MB",
                        'filename': name,
                        'message': f"Downloading {name}..."
                    })
            
            # Set executable permissions
            try:
                st = os.stat(dest_path)
                os.chmod(dest_path, st.st_mode | 0o111)
            except Exception as e:
                print(f"[Api] Error setting executable permission on {dest_path}: {e}")

    def _ffmpeg_downloader_worker(self, bin_dir):
        """Downloads the latest FFmpeg static binary from GitHub and extracts it locally."""
        try:
            # Platform-specific macOS handler (Shaka project binaries)
            if sys.platform == 'darwin':
                import platform
                is_arm = platform.machine() == 'arm64'
                suffix = 'arm64' if is_arm else 'x64'
                
                ffmpeg_url = f"https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/n8.0.1-1/ffmpeg-osx-{suffix}"
                ffprobe_url = f"https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/n8.0.1-1/ffprobe-osx-{suffix}"
                
                os.makedirs(bin_dir, exist_ok=True)
                
                # 1. Download ffmpeg (0% to 50% progress)
                ffmpeg_path = os.path.join(bin_dir, 'ffmpeg')
                self._download_direct_binary(ffmpeg_url, ffmpeg_path, 'ffmpeg', (0, 50))
                
                # 2. Download ffprobe (50% to 100% progress)
                ffprobe_path = os.path.join(bin_dir, 'ffprobe')
                self._download_direct_binary(ffprobe_url, ffprobe_path, 'ffprobe', (50, 100))
                
                self._custom_ffmpeg_exe = ffmpeg_path
                self._send_progress({
                    'status': 'completed',
                    'percent': 100,
                    'message': 'FFmpeg successfully installed!',
                    'ffmpeg_path': ffmpeg_path,
                })
                return

            # Default Windows / zip handler (remains unchanged)
            self._send_progress({
                'status': 'downloading',
                'percent': 0,
                'speed': '0.0 MB/s',
                'downloaded': '0.0 MB',
                'total': '~50 MB',
                'filename': 'ffmpeg.zip',
                'message': 'Downloading FFmpeg archive...'
            })

            url = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
            bin_names = ['ffmpeg.exe', 'ffprobe.exe']

            import ssl
            context = ssl._create_unverified_context()
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, context=context) as response:
                total_size = int(response.headers.get('content-length', 0))
                downloaded = 0
                block_size = 512 * 1024
                zip_data = io.BytesIO()
                start_time = time.time()

                while True:
                    buffer = response.read(block_size)
                    if not buffer:
                        break
                    downloaded += len(buffer)
                    zip_data.write(buffer)

                    elapsed = time.time() - start_time
                    speed_val = downloaded / elapsed if elapsed > 0 else 0
                    speed_str = (f"{speed_val / (1024 * 1024):.1f} MB/s"
                                 if speed_val > 1024 * 1024
                                 else f"{speed_val / 1024:.1f} KB/s")
                    percent = (downloaded / total_size * 100) if total_size > 0 else 0

                    self._send_progress({
                        'status': 'downloading',
                        'percent': percent,
                        'speed': speed_str,
                        'downloaded': f"{downloaded / (1024 * 1024):.1f} MB",
                        'total': f"{total_size / (1024 * 1024):.1f} MB",
                        'filename': 'ffmpeg.zip',
                        'message': 'Downloading FFmpeg binary...'
                    })

            self._send_progress({
                'status': 'merging',
                'percent': 100,
                'message': 'Extracting FFmpeg binaries...'
            })

            os.makedirs(bin_dir, exist_ok=True)

            zip_data.seek(0)
            with zipfile.ZipFile(zip_data) as zip_file:
                for member in zip_file.namelist():
                    filename = os.path.basename(member)
                    if filename in bin_names:
                        source = zip_file.open(member)
                        target_path = os.path.join(bin_dir, filename)
                        with open(target_path, "wb") as target:
                            shutil.copyfileobj(source, target)
                        
                        # Set executable permissions on macOS / Unix platforms
                        if sys.platform != 'win32':
                            st = os.stat(target_path)
                            os.chmod(target_path, st.st_mode | 0o111)

            installed_path = os.path.join(bin_dir, bin_names[0])
            self._custom_ffmpeg_exe = installed_path

            self._send_progress({
                'status': 'completed',
                'percent': 100,
                'message': 'FFmpeg successfully installed!',
                'ffmpeg_path': installed_path,
            })

        except Exception as e:
            self._send_progress({
                'status': 'error',
                'message': f"FFmpeg download failed: {str(e)}"
            })

    def _download_worker(self, url, download_dir, format_id, options=None, job_id='single'):
        """Worker thread that executes the yt-dlp download for one job."""

        # yt-dlp calls hooks with only `d`, so per-job identity rides in via closures.
        def progress_hook(d):
            if job_id in self._cancelled:
                raise Exception("Download cancelled by user")
            if d['status'] == 'downloading':
                downloaded = d.get('downloaded_bytes', 0)
                total = d.get('total_bytes') or d.get('total_bytes_estimate', 0)
                percent = (downloaded / total * 100) if total > 0 else 0
                speed = d.get('speed', 0)
                if speed:
                    speed_str = (f"{speed / (1024 * 1024):.1f} MB/s"
                                 if speed > 1024 * 1024
                                 else f"{speed / 1024:.1f} KB/s")
                else:
                    speed_str = 'N/A'
                self._send_progress({
                    'status': 'downloading',
                    'percent': percent,
                    'speed': speed_str,
                    'eta': d.get('_eta_str', 'N/A'),
                    'downloaded': d.get('_downloaded_bytes_str', 'N/A'),
                    'total': d.get('_total_bytes_str', 'N/A'),
                    'filename': os.path.basename(d.get('filename', '')),
                }, job_id)
            elif d['status'] == 'finished':
                self._send_progress({
                    'status': 'merging',
                    'percent': 100,
                    'message': 'Merging components and compiling stream...',
                }, job_id)

        def postprocessor_hook(d):
            if job_id in self._cancelled:
                raise Exception("Download cancelled by user")
            if d['status'] == 'started':
                self._send_progress({
                    'status': 'processing',
                    'percent': 100,
                    'message': f"Post-processor: {d['postprocessor']}...",
                }, job_id)
            elif d['status'] == 'finished':
                self._send_progress({
                    'status': 'processing_done',
                    'percent': 100,
                    'message': "Component processing complete.",
                }, job_id)

        try:
            options = options or {}
            self._send_progress({'status': 'starting', 'message': 'Initializing extraction...'}, job_id)

            is_audio_only = format_id == 'bestaudio/best'
            template = options.get('filename_template') or '%(title)s.%(ext)s'

            ydl_opts = {
                'outtmpl': os.path.join(download_dir, template),
                'progress_hooks': [progress_hook],
                'postprocessor_hooks': [postprocessor_hook],
                'postprocessors': [],
                'noprogress': True,
                'quiet': True,
                'no_warnings': True,
                'nocheckcertificate': True
            }

            # Find ffmpeg: settings exe → system PATH → bundled bin → default bin → custom session dir
            ffmpeg_dir = None
            ffmpeg_name = self._get_ffmpeg_name()
            
            # Check temp folder if bundled
            bundled_bin = None
            if getattr(sys, 'frozen', False):
                bundled_bin = os.path.join(sys._MEIPASS, 'bin')

            if self._custom_ffmpeg_exe and os.path.exists(self._custom_ffmpeg_exe):
                ffmpeg_dir = os.path.dirname(self._custom_ffmpeg_exe)
            elif not shutil.which('ffmpeg'):
                for candidate in [bundled_bin, self._get_bin_dir(), self._custom_ffmpeg_dir]:
                    if candidate and os.path.exists(os.path.join(candidate, ffmpeg_name)):
                        ffmpeg_dir = candidate
                        break
            if ffmpeg_dir:
                ydl_opts['ffmpeg_location'] = ffmpeg_dir

            if is_audio_only:
                ydl_opts['format'] = 'bestaudio/best'
                ydl_opts['postprocessors'].append({
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': '192',
                })
            else:
                ydl_opts['format'] = format_id
                ydl_opts['merge_output_format'] = 'mp4'

                # Codec preference: a *soft* sort key so yt-dlp prefers the chosen
                # video codec but still falls back gracefully if it's unavailable at
                # the picked quality. 'h264' (AVC) is the universally-playable default
                # — HEVC/AV1 are smaller but need a newer player/codec to open.
                codec = (options.get('codec') or '').lower()
                CODEC_SORT = {'h264': 'vcodec:h264', 'h265': 'vcodec:h265', 'av1': 'vcodec:av01'}
                if codec in CODEC_SORT:
                    ydl_opts['format_sort'] = [CODEC_SORT[codec]]

            # Caption tracks (manual + automatic), optionally embedded into the file.
            subs = options.get('subtitles')
            if subs and subs.get('enabled'):
                lang = subs.get('lang') or 'en'
                sub_format = subs.get('format') or 'srt'
                ydl_opts['writesubtitles'] = True
                ydl_opts['writeautomaticsub'] = True
                ydl_opts['subtitleslangs'] = [lang]
                ydl_opts['subtitlesformat'] = sub_format
                if subs.get('embed') and not is_audio_only:
                    ydl_opts['postprocessors'].append({'key': 'FFmpegEmbedSubtitle'})
                else:
                    ydl_opts['postprocessors'].append({
                        'key': 'FFmpegSubtitlesConvertor',
                        'format': sub_format,
                    })

            # Signal trim — download only a section between IN and OUT timestamps.
            clip = options.get('clip')
            if clip and (clip.get('start') or clip.get('end')):
                start_sec = self._parse_timestamp(clip.get('start')) or 0.0
                end_sec = self._parse_timestamp(clip.get('end'))
                if end_sec is None:
                    end_sec = float('inf')
                if end_sec > start_sec:
                    from yt_dlp.utils import download_range_func
                    ydl_opts['download_ranges'] = download_range_func(
                        None, [(start_sec, end_sec)]
                    )
                    ydl_opts['force_keyframes_at_cuts'] = True

            # Authentication via cookies — falls back to a signed-out attempt if
            # the cookie store can't be read, so a locked browser never kills a job.
            _, cookie_warning = self._run_ydl(
                ydl_opts, options.get('cookies'), lambda ydl: ydl.download([url])
            )

            self._send_progress({
                'status': 'completed',
                'percent': 100,
                'message': 'Archival complete!',
                'cookie_warning': cookie_warning,
            }, job_id)
        except Exception as e:
            self._send_progress({'status': 'error', 'message': _clean_error(e)}, job_id)
        finally:
            self._active_jobs.discard(job_id)
            self._cancelled.discard(job_id)

    def _send_progress(self, data, job_id=None):
        """Sends data back to the React UI, tagged with its job_id when present."""
        if job_id is not None:
            data = {**data, 'job_id': job_id}
        if self._window:
            serialized = json.dumps(data)
            # Lock so concurrent worker threads don't interleave JS injection.
            with self._emit_lock:
                self._window.evaluate_js(f"if (window.onDownloadProgress) window.onDownloadProgress({serialized});")

def _write_crash_log(text):
    log_path = os.path.join(os.path.expanduser('~'), 'kinescope_crash.log')
    with open(log_path, 'a', encoding='utf-8') as f:
        f.write(text + '\n')

def main():
    import traceback
    try:
        _start()
    except Exception:
        _write_crash_log(traceback.format_exc())
        raise

def _start():
    if getattr(sys, 'frozen', False):
        base_dir = sys._MEIPASS
    else:
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    frontend_dist = os.path.join(base_dir, 'frontend', 'dist', 'index.html')

    api = Api()
    dev_mode = os.environ.get('KINESCOPE_DEV', '0') == '1'
    url = 'http://localhost:5173' if dev_mode else frontend_dist

    if not dev_mode and not os.path.exists(frontend_dist):
        _write_crash_log(f"Frontend not found at: {frontend_dist}")
        sys.exit(1)

    window = webview.create_window(
        title='KINESCOPE // ARCHIVAL DECK',
        url=url,
        js_api=api,
        width=580,
        height=680,
        resizable=False,
        background_color='#0c0e12'
    )

    api._window = window
    
    # On macOS, pywebview defaults to WebKit which does not need edgechromium.
    # On Windows, we explicitly force edgechromium to avoid MSHTML lockups.
    gui_engine = 'edgechromium' if sys.platform == 'win32' else None
    webview.start(debug=dev_mode, gui=gui_engine)

if __name__ == '__main__':
    main()
