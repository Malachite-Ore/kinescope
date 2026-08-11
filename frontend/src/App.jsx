import React, { useState, useEffect, useRef } from 'react';

// Quality presets used by the playlist browser (one choice applies to every entry).
// One quality applies to every selected entry. A flat playlist scan can't expose
// each entry's real formats, so these lower rungs aren't verified per-video — the
// trailing /best makes a missing rung fall back to the closest available size.
const PLAYLIST_QUALITY = [
  { id: 'bestvideo+bestaudio/best', note: 'Best Quality' },
  { id: 'bestvideo[height<=1080]+bestaudio/best', note: '1080p FHD' },
  { id: 'bestvideo[height<=720]+bestaudio/best', note: '720p HD' },
  { id: 'bestvideo[height<=480]+bestaudio/best', note: '480p SD' },
  { id: 'bestvideo[height<=360]+bestaudio/best', note: '360p SD' },
  { id: 'bestvideo[height<=240]+bestaudio/best', note: '240p' },
  { id: 'bestvideo[height<=144]+bestaudio/best', note: '144p' },
  { id: 'bestaudio/best', note: 'Audio Only (MP3)' },
];

const SUB_FORMATS = ['srt', 'vtt', 'ass'];

// Video codec preference. Sent to the backend as options.codec and applied as a
// soft yt-dlp format_sort key, so it steers the pick without ever failing the
// download. 'h264' is the default because it plays on every device/player with no
// extra codec — the cure for "you need a new codec" prompts in Windows players.
const VIDEO_CODECS = [
  {
    value: 'h264', label: 'H.264 // Universal', tag: 'PLAYS EVERYWHERE',
    blurb: 'The safe choice. Opens in every player, phone, TV, and editor with no extra codec to install.',
    detail: 'Also called AVC. The most widely-supported video codec on Earth — if you just want the file to play, pick this.',
    trade: 'Files are a bit larger than the newer codecs at the same quality.',
  },
  {
    value: 'h265', label: 'H.265 // Efficient', tag: 'SMALLER FILES',
    blurb: 'Roughly half the file size of H.264 at similar quality — but needs a recent player or a codec pack.',
    detail: 'Also called HEVC. Great for saving disk space. Windows Media Player asks you to BUY the HEVC extension; VLC plays it free.',
    trade: 'Older devices and the stock Windows player may refuse to open it without a (sometimes paid) codec.',
  },
  {
    value: 'av1', label: 'AV1 // Next-Gen', tag: 'SMALLEST',
    blurb: 'The newest, most space-efficient codec. Best compression, but the pickiest about player support.',
    detail: 'Royalty-free and excellent quality-per-byte. Modern browsers and VLC handle it; many TVs and older PCs do not.',
    trade: 'Needs very recent hardware/software. If unsure, this is the most likely to not play somewhere.',
  },
  {
    value: 'any', label: 'Any // Best Quality', tag: 'NO PREFERENCE',
    blurb: 'Let the source decide — grabs the highest-quality stream regardless of codec.',
    detail: 'The original yt-dlp behaviour. You may get HEVC or AV1 and hit a "need a codec" prompt in some players.',
    trade: 'No compatibility guarantee — this is how you can end up needing a paid codec.',
  },
];

// Turn a yt-dlp language code (en, pt-BR, zh-Hans, ab…) into its full English
// name — most people recognise "Spanish", not "es". Falls back to the raw code.
const LANG_DISPLAY = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; }
})();
const langName = (code) => {
  if (!code) return code;
  try {
    const name = LANG_DISPLAY?.of(code);
    if (name && name.toLowerCase() !== code.toLowerCase()) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  } catch { /* unknown code — fall through */ }
  return code;
};

// Each preset carries a plain-language description and a `segments(meta)` builder
// that returns colour-coded pieces so the FILE MANIFEST overlay can show the
// real resulting filename instead of raw yt-dlp tokens. role ∈ title|channel|date|id|ext|sep.
const FILENAME_PRESETS = [
  {
    label: 'Default (Title)', value: '%(title)s.%(ext)s',
    plain: 'Just the video title',
    segments: (m) => [
      { text: m.title, role: 'title' },
      { text: `.${m.ext}`, role: 'ext' },
    ],
  },
  {
    label: 'Date + Title', value: '%(upload_date)s - %(title)s.%(ext)s',
    plain: 'Upload date, then the title',
    segments: (m) => [
      { text: m.upload_date, role: 'date' },
      { text: ' - ', role: 'sep' },
      { text: m.title, role: 'title' },
      { text: `.${m.ext}`, role: 'ext' },
    ],
  },
  {
    label: 'Channel + Title', value: '%(uploader)s - %(title)s.%(ext)s',
    plain: 'Channel name, then the title',
    segments: (m) => [
      { text: m.uploader, role: 'channel' },
      { text: ' - ', role: 'sep' },
      { text: m.title, role: 'title' },
      { text: `.${m.ext}`, role: 'ext' },
    ],
  },
  {
    label: 'ID + Title', value: '%(id)s - %(title)s.%(ext)s',
    plain: 'Video ID, then the title',
    segments: (m) => [
      { text: m.id, role: 'id' },
      { text: ' - ', role: 'sep' },
      { text: m.title, role: 'title' },
      { text: `.${m.ext}`, role: 'ext' },
    ],
  },
  { label: 'Custom…', value: '__custom__', plain: 'Write your own naming pattern' },
];

// Plain-words label for each colour role, shown in the manifest legend.
const SEGMENT_LABELS = {
  date: 'Date', channel: 'Channel', title: 'Video title', id: 'Video ID', ext: 'File type',
};

// Substitutes the yt-dlp tokens a consumer would never recognise with real metadata.
const resolveTemplate = (tpl, m) => (tpl || '')
  .replace(/%\(title\)s/g, m.title)
  .replace(/%\(uploader\)s/g, m.uploader)
  .replace(/%\(upload_date\)s/g, m.upload_date)
  .replace(/%\(id\)s/g, m.id)
  .replace(/%\(ext\)s/g, m.ext);

// ----- Filename builder (Scratch-style blocks) -------------------------------
// A custom filename is an ordered list of blocks. Variable blocks carry a `role`;
// separator blocks carry literal `text`. The extension is always auto-appended,
// so it is never a block.
const ROLE_TOKEN = {
  title: '%(title)s', channel: '%(uploader)s', date: '%(upload_date)s', id: '%(id)s',
};
const TOKEN_ROLE = { title: 'title', uploader: 'channel', upload_date: 'date', id: 'id' };

// The draggable variable blocks available in the palette (plain label + colour role).
const VAR_BLOCKS = [
  { role: 'title',   label: 'Video title' },
  { role: 'channel', label: 'Channel' },
  { role: 'date',    label: 'Date' },
  { role: 'id',      label: 'Video ID' },
];
// Separator blocks the user can drop between variables.
const SEP_BLOCKS = [
  { text: ' - ', label: 'dash' },
  { text: '_',   label: 'underscore' },
  { text: ' ',   label: 'space' },
];

// Serialise a block list back into a yt-dlp template (extension appended automatically).
const blocksToTemplate = (blocks) =>
  blocks.map((b) => (b.kind === 'var' ? ROLE_TOKEN[b.role] : b.text)).join('') + '.%(ext)s';

// Resolve a block to the real text it represents for this video.
const blockText = (b, m) => (b.kind === 'var'
  ? ({ title: m.title, channel: m.uploader, date: m.upload_date, id: m.id }[b.role])
  : b.text);

// Parse a saved template (preset OR custom) back into editable blocks so reopening
// the builder mirrors the current arrangement. `nextId` mints unique block ids.
const parseTemplateToBlocks = (tpl, nextId) => {
  const body = (tpl || '').replace(/\.%\(ext\)s$/, '');
  const blocks = [];
  const re = /%\((title|uploader|upload_date|id)\)s/g;
  let last = 0, m;
  const pushSep = (text) => { if (text) blocks.push({ id: nextId(), kind: 'sep', text }); };
  while ((m = re.exec(body)) !== null) {
    pushSep(body.slice(last, m.index));
    blocks.push({ id: nextId(), kind: 'var', role: TOKEN_ROLE[m[1]] });
    last = m.index + m[0].length;
  }
  pushSep(body.slice(last));
  return blocks;
};

// Every browser yt-dlp can read a cookie store from. The backend reports which of
// these actually exist on this machine; the rest stay selectable as a manual override.
const COOKIE_BROWSERS = ['chrome', 'firefox', 'edge', 'brave', 'safari', 'vivaldi', 'opera', 'chromium', 'whale'];

const browserLabel = (b) => (b ? b.charAt(0).toUpperCase() + b.slice(1) : '');

// Cheap heuristic so a playlist URL routes to the browser instead of a single scan.
const looksLikePlaylist = (s) =>
  /[?&]list=/.test(s) || /\/playlist\b/.test(s) || /\/sets\//.test(s);

const formatStamp = (epochSecs) => {
  if (!epochSecs) return '';
  const d = new Date(epochSecs * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function App() {
  const [view, setView] = useState('archive'); // 'archive' | 'queue' | 'log'

  const [url, setUrl] = useState('');
  const [downloadDir, setDownloadDir] = useState('');
  const [selectedFormat, setSelectedFormat] = useState('bestvideo+bestaudio/best');

  const [videoInfo, setVideoInfo] = useState(null);

  const [isLoadingInfo, setIsLoadingInfo] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(null);

  const [error, setError] = useState('');
  const [completionState, setCompletionState] = useState(null); // null | 'animating' | 'done'
  const [completionText, setCompletionText] = useState('');

  // Transmission options (subtitles + signal trim)
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [subEnabled, setSubEnabled] = useState(false);
  const [subLang, setSubLang] = useState('');
  const [subFormat, setSubFormat] = useState('srt');
  const [subEmbed, setSubEmbed] = useState(false);
  const [clipStart, setClipStart] = useState('');
  const [clipEnd, setClipEnd] = useState('');

  // Playlist browser
  const [playlist, setPlaylist] = useState(null); // { title, uploader, count, entries: [{url,title,duration,selected}] }
  const [isLoadingPlaylist, setIsLoadingPlaylist] = useState(false);
  const [playlistQuality, setPlaylistQuality] = useState('bestvideo+bestaudio/best');

  // Queue
  const [queue, setQueue] = useState([]);
  const [queueRunning, setQueueRunning] = useState(false);

  // History
  const [history, setHistory] = useState([]);

  // Feature state
  const [ytdlpUpdateInfo,    setYtdlpUpdateInfo]    = useState(null);
  const [clipboardSuggestion, setClipboardSuggestion] = useState('');
  const [filenameTemplate,   setFilenameTemplate]   = useState('%(title)s.%(ext)s');
  const [filenamePreset,     setFilenamePreset]     = useState('%(title)s.%(ext)s');
  // Authentication is armed by default — a cookie store that can't be read falls
  // back to a signed-out attempt in the backend, so leaving it on costs nothing.
  const [cookiesMode,        setCookiesMode]        = useState('browser'); // 'none'|'browser'|'file'
  const [cookiesBrowser,     setCookiesBrowser]     = useState('auto');
  const [cookiesFile,        setCookiesFile]        = useState('');
  const [detectedBrowsers,   setDetectedBrowsers]   = useState(null);  // null until probed
  const [authNotice,         setAuthNotice]         = useState('');    // signed-out fallback message
  const [activeHelp,         setActiveHelp]         = useState(null); // null | 'filename' | 'auth' | 'codec'
  const [videoCodec,         setVideoCodec]         = useState('h264'); // h264 | h265 | av1 | any
  const [filenameBlocks,     setFilenameBlocks]     = useState([]);   // working blocks while builder is open

  const canvasRef = useRef(null);
  const blockIdRef = useRef(0);
  const nextBlockId = () => ++blockIdRef.current;
  const dragRef = useRef(null); // { source:'palette', spec } | { source:'strip', index }
  const urlInputRef = useRef(null);
  const completionPhaseRef = useRef(null); // 'noise' | 'lock' | 'hold' | null
  const completionStartTimeRef = useRef(0);

  // Refs that back the queue processor (avoid stale closures inside the loop).
  const queueRef = useRef([]);
  const queueRunningRef = useRef(false);
  const jobHandlersRef = useRef({});   // job_id -> (data) => void, for parallel downloads
  const claimedRef = useRef(new Set()); // item ids already claimed by a pool worker
  const singleItemRef = useRef(null);   // pending single (ARCHIVE) download, for history
  const idRef = useRef(1);
  const nextId = () => idRef.current++;

  const CONCURRENCY = 3; // max simultaneous downloads

  const setQueueSafe = (updater) => {
    setQueue((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      queueRef.current = next;
      return next;
    });
  };

  const resetToIdle = () => {
    setCompletionState(null);
    setCompletionText('');
    setUrl('');
    setVideoInfo(null);
    setProgress(null);
    setError('');
    setPlaylist(null);
    setSubEnabled(false);
    setSubLang('');
    setSubEmbed(false);
    setClipStart('');
    setClipEnd('');
    setOptionsOpen(false);
    setAuthNotice('');
    // Authentication is deliberately not reset — it's a machine-level preference,
    // not a per-transmission one, and re-arming it every time defeats the point.
  };

  // Mount: initialize, load settings + history
  useEffect(() => {
    async function init() {
      if (window.pywebview?.api) {
        try {
          const [defaultDir, settings, hist] = await Promise.all([
            window.pywebview.api.get_default_download_dir(),
            window.pywebview.api.load_settings(),
            window.pywebview.api.load_history(),
          ]);
          setDownloadDir(settings.download_dir || defaultDir);
          setHistory(hist?.history || []);
          if (settings.filename_template) {
            setFilenameTemplate(settings.filename_template);
            const match = FILENAME_PRESETS.find(
              (p) => p.value === settings.filename_template && p.value !== '__custom__'
            );
            setFilenamePreset(match ? settings.filename_template : '__custom__');
          }
          if (settings.cookies_mode)    setCookiesMode(settings.cookies_mode);
          if (settings.cookies_browser) setCookiesBrowser(settings.cookies_browser);
          if (settings.cookies_file)    setCookiesFile(settings.cookies_file);
          if (settings.video_codec)     setVideoCodec(settings.video_codec);
          window.pywebview.api.check_ytdlp_update()
            .then((info) => setYtdlpUpdateInfo(info))
            .catch(() => {});
          window.pywebview.api.detect_browsers()
            .then((res) => setDetectedBrowsers(res?.browsers || []))
            .catch(() => setDetectedBrowsers([]));
        } catch (err) {
          setError('Failed to initialize: ' + err.message);
        }
      } else {
        setDownloadDir('C:\\Users\\MockUser\\Downloads');
        setDetectedBrowsers(['chrome', 'firefox']);
        setHistory([
          { title: 'Night Drive // Long Take', uploader: 'Neon Archive', formatNote: '1080p FHD', dir: 'C:\\Users\\MockUser\\Downloads', time: 1719400000 },
        ]);
      }
    }

    if (window.pywebview) {
      init();
    } else {
      window.addEventListener('pywebviewready', init);
    }
    return () => window.removeEventListener('pywebviewready', init);
  }, []);

  // Progress listener — routes job-tagged events to their queue handler,
  // and falls back to the legacy single-download path for untagged events.
  useEffect(() => {
    window.onDownloadProgress = (data) => {
      // A job that couldn't read the cookie store still ran — say so rather than
      // letting the user think the file came down authenticated.
      if (data.cookie_warning) setAuthNotice(data.cookie_warning);

      const handler = data.job_id && jobHandlersRef.current[data.job_id];
      if (handler) {
        handler(data);
        return;
      }

      // Legacy path: single ARCHIVE download + FFmpeg installer (no registered handler).
      setProgress(data);
      if (data.status === 'completed') {
        setIsDownloading(false);
        if (data.ffmpeg_path && window.pywebview?.api) {
          window.pywebview.api.save_setting('ffmpeg_path', data.ffmpeg_path);
        }
        setCompletionState('animating');
        if (singleItemRef.current) {
          recordHistory(singleItemRef.current);
          singleItemRef.current = null;
        }
      } else if (data.status === 'error') {
        setIsDownloading(false);
        setError(data.message);
        singleItemRef.current = null;
      }
    };
    return () => { delete window.onDownloadProgress; };
  }, [downloadDir]);

  // URL debounce → scan (video or playlist)
  useEffect(() => {
    const isWebUrl = (s) => {
      try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch (_) {
        return false;
      }
    };
    if (isWebUrl(url)) {
      const t = setTimeout(() => handleScan(url), 800);
      return () => clearTimeout(t);
    } else {
      setVideoInfo(null);
      setPlaylist(null);
    }
    // Authentication is part of the scan, not just the download: a sign-in-gated
    // video fails at metadata time, so changing it re-scans the URL already typed.
  }, [url, cookiesMode, cookiesBrowser, cookiesFile]);

  // Clipboard URL suggestion — probes when the URL field becomes empty
  useEffect(() => {
    if (url) { setClipboardSuggestion(''); return; }
    let cancelled = false;
    const probe = async () => {
      if (!window.pywebview?.api) return;
      try {
        const res = await window.pywebview.api.get_clipboard();
        const text = (res?.text || '').trim();
        let isUrl = false;
        try { const u = new URL(text); isUrl = u.protocol === 'http:' || u.protocol === 'https:'; } catch (_) {}
        if (!cancelled) setClipboardSuggestion(isUrl ? text : '');
      } catch (_) {}
    };
    probe();
    return () => { cancelled = true; };
  }, [url]);

  // Completion animation phases
  useEffect(() => {
    if (completionState !== 'animating') return;

    completionPhaseRef.current = 'noise';
    completionStartTimeRef.current = performance.now();

    const fullText = 'SIGNAL ACQUIRED — TRANSMISSION COMPLETE';
    let charIdx = 0;
    setCompletionText('');

    const printInterval = setInterval(() => {
      charIdx++;
      setCompletionText(fullText.slice(0, charIdx));
      if (charIdx >= fullText.length) clearInterval(printInterval);
    }, 38);

    const t1 = setTimeout(() => { completionPhaseRef.current = 'lock'; }, 400);
    const t2 = setTimeout(() => { completionPhaseRef.current = 'hold'; }, 1200);
    const t3 = setTimeout(() => {
      completionPhaseRef.current = null;
      setCompletionState('done');
    }, 2800);

    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      clearInterval(printInterval);
      completionPhaseRef.current = null;
    };
  }, [completionState]);

  // Close the FILE MANIFEST / authentication overlay on Escape.
  useEffect(() => {
    if (!activeHelp) return;
    const onKey = (e) => { if (e.key === 'Escape') setActiveHelp(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeHelp]);

  // Canvas oscilloscope
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animationFrameId;
    let phase = 0;

    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    const drawGrid = () => {
      ctx.strokeStyle = '#141822';
      ctx.lineWidth = 1;
      const gridSize = 16;
      for (let x = 0; x < canvas.width; x += gridSize) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += gridSize) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
      }
      ctx.strokeStyle = '#222b3b';
      ctx.beginPath(); ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(canvas.width / 2, 0); ctx.lineTo(canvas.width / 2, canvas.height); ctx.stroke();
    };

    const drawCompletionWave = (phaseLabel) => {
      const elapsed = performance.now() - completionStartTimeRef.current;
      const cy = canvas.height / 2;
      let color, amplitude, frequency, noiseAmount;

      if (phaseLabel === 'noise') {
        const t = Math.min(elapsed / 400, 1);
        amplitude = 8 + t * 28;
        frequency = 0.08 + t * 0.08;
        noiseAmount = t * 14;
        color = '#d97706';
      } else if (phaseLabel === 'lock') {
        const t = Math.min((elapsed - 400) / 800, 1);
        amplitude = 36 * Math.pow(1 - t, 2) + 4;
        frequency = 0.18 * (1 - t) + 0.025;
        noiseAmount = (1 - t) * 10;
        const r = Math.round(217 * (1 - t) + 16 * t);
        const g = Math.round(119 * (1 - t) + 185 * t);
        const b = Math.round(6 * (1 - t) + 129 * t);
        color = `rgb(${r},${g},${b})`;
        if (t > 0.4) {
          const lineAlpha = Math.min((t - 0.4) / 0.6, 1) * 0.3;
          ctx.strokeStyle = `rgba(16,185,129,${lineAlpha})`;
          ctx.lineWidth = 1;
          ctx.shadowBlur = 0;
          ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(canvas.width, cy); ctx.stroke();
        }
      } else {
        amplitude = 5;
        frequency = 0.025;
        noiseAmount = 0;
        color = '#10b981';
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.shadowBlur = 10;
      ctx.shadowColor = color;
      ctx.beginPath();
      for (let x = 0; x < canvas.width; x++) {
        const n = noiseAmount > 0 ? (Math.random() - 0.5) * noiseAmount : 0;
        const y = cy + Math.sin(x * frequency + phase) * amplitude + n;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawGrid();

      const completionPhase = completionPhaseRef.current;
      let speed = 0.05;

      if (completionPhase) {
        speed = 0.03;
        drawCompletionWave(completionPhase);
      } else {
        let color = '#d97706';
        let amplitude = 8;
        let frequency = 0.02;

        const anyActive = isDownloading || queueRunning;
        if (isLoadingInfo || isLoadingPlaylist) {
          color = '#3b82f6';
          amplitude = 12;
          frequency = 0.08;
          speed = 0.2;
        } else if (anyActive) {
          color = '#10b981';
          amplitude = 16;
          frequency = 0.15;
          speed = 0.35;
          if (progress?.status === 'merging' || progress?.status === 'processing') {
            color = '#8b5cf6';
            amplitude = 5;
            frequency = 0.03;
            speed = 0.08;
          }
        }

        const scanning = isLoadingInfo || isLoadingPlaylist;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 6;
        ctx.shadowColor = color;
        ctx.beginPath();
        for (let x = 0; x < canvas.width; x++) {
          let y = canvas.height / 2;
          if (scanning) {
            const sweepX = (phase * 12) % canvas.width;
            const dist = Math.abs(x - sweepX);
            const scanAmp = dist < 60 ? ((60 - dist) / 60) * amplitude : 0;
            y += Math.sin(x * frequency + phase) * scanAmp;
          } else if ((isDownloading || queueRunning) && (progress?.status === 'downloading' || queueRunning)) {
            y += Math.sin(x * frequency - phase) * amplitude * (0.6 + Math.sin(phase * 2) * 0.2 + Math.random() * 0.2);
          } else {
            y += Math.sin(x * frequency + phase) * amplitude;
          }
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      phase += speed;
      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, [isDownloading, queueRunning, isLoadingInfo, isLoadingPlaylist, progress, completionState]);

  // ---- Scanning ---------------------------------------------------------

  const handleScan = (scanUrl) => {
    if (looksLikePlaylist(scanUrl)) {
      handleScanPlaylist(scanUrl);
    } else {
      handleScanInfo(scanUrl);
    }
  };

  const handleScanInfo = async (scanUrl) => {
    setError('');
    setPlaylist(null);
    setAuthNotice('');
    setIsLoadingInfo(true);
    if (window.pywebview?.api) {
      try {
        const info = await window.pywebview.api.get_video_info(scanUrl, { cookies: cookieOptions() });
        if (info.cookie_warning) setAuthNotice(info.cookie_warning);
        if (info.success) {
          setVideoInfo(info);
          setSelectedFormat(info.formats?.[0]?.id ?? 'bestvideo+bestaudio/best');
          // Default caption language to first available track.
          if (info.subtitles?.length) setSubLang(info.subtitles[0].code);
        } else if (info.is_playlist) {
          handleScanPlaylist(scanUrl);
        } else {
          setError(info.error || 'Failed to scan URL metadata.');
        }
      } catch (err) {
        setError('Error connecting to backend: ' + err.message);
      } finally {
        setIsLoadingInfo(false);
      }
    } else {
      setTimeout(() => {
        setVideoInfo({
          title: 'Vaporwave Archival Broadcast [1989]',
          uploader: 'SynthWave Collective',
          duration: '04:20',
          id: 'mEfiNvRW7p8',
          upload_date: '20260628',
          thumbnail: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=120&fit=crop',
          formats: [
            { id: 'bestvideo+bestaudio/best', note: 'Best Quality (Default)' },
            { id: 'bestvideo[height<=1080]+bestaudio/best', note: '1080p FHD' },
            { id: 'bestvideo[height<=720]+bestaudio/best', note: '720p HD' },
            { id: 'bestvideo[height<=480]+bestaudio/best', note: '480p SD' },
            { id: 'bestvideo[height<=360]+bestaudio/best', note: '360p SD' },
            { id: 'bestvideo[height<=240]+bestaudio/best', note: '240p' },
            { id: 'bestvideo[height<=144]+bestaudio/best', note: '144p' },
            { id: 'bestaudio/best', note: 'Audio Only (MP3)' },
          ],
          subtitles: [
            { code: 'en', name: 'en', auto: false },
            { code: 'fr', name: 'fr', auto: false },
            { code: 'pt-BR', name: 'pt-BR', auto: false },
            { code: 'zh-Hans', name: 'zh-Hans', auto: false },
            { code: 'es', name: 'es', auto: true },
          ],
        });
        setSelectedFormat('bestvideo+bestaudio/best');
        setSubLang('en');
        setIsLoadingInfo(false);
      }, 1000);
    }
  };

  const handleScanPlaylist = async (scanUrl) => {
    setError('');
    setVideoInfo(null);
    setAuthNotice('');
    setIsLoadingPlaylist(true);
    if (window.pywebview?.api) {
      try {
        const res = await window.pywebview.api.get_playlist_info(scanUrl, { cookies: cookieOptions() });
        if (res.cookie_warning) setAuthNotice(res.cookie_warning);
        if (res.success) {
          setPlaylist({
            title: res.title,
            uploader: res.uploader,
            count: res.count,
            entries: res.entries.map((e) => ({ ...e, selected: true })),
          });
        } else {
          // Not actually a playlist — fall back to a single video scan.
          handleScanInfo(scanUrl);
        }
      } catch (err) {
        setError('Playlist scan failed: ' + err.message);
      } finally {
        setIsLoadingPlaylist(false);
      }
    } else {
      setTimeout(() => {
        setPlaylist({
          title: 'Late Night Mixtape Vol. 3',
          uploader: 'Neon Archive',
          count: 5,
          entries: [
            { url: 'mock1', title: 'Opening Sequence — Drift', uploader: 'Neon Archive', duration: '03:12', selected: true },
            { url: 'mock2', title: 'Midnight Corridor', uploader: 'Neon Archive', duration: '04:45', selected: true },
            { url: 'mock3', title: 'Rain on Glass', uploader: 'Neon Archive', duration: '02:58', selected: true },
            { url: 'mock4', title: 'Last Train Home', uploader: 'Neon Archive', duration: '05:20', selected: true },
            { url: 'mock5', title: 'Fade to Static', uploader: 'Neon Archive', duration: '03:40', selected: true },
          ],
        });
        setIsLoadingPlaylist(false);
      }, 1000);
    }
  };

  // ---- Option assembly --------------------------------------------------

  // The authentication choice, in the shape the backend expects. Shared by scans
  // and downloads so a URL is resolved with exactly the sign-in it'll be fetched with.
  const cookieOptions = () =>
    cookiesMode === 'browser'
      ? { type: 'browser', browser: cookiesBrowser }
      : cookiesMode === 'file' && cookiesFile
        ? { type: 'file', file: cookiesFile }
        : null;

  // Settings that apply to every transmission, playlist entries included.
  const baseOptions = () => ({
    codec: videoCodec,
    filename_template: filenameTemplate || '%(title)s.%(ext)s',
    cookies: cookieOptions(),
  });

  const currentOptions = () => ({
    ...baseOptions(),
    subtitles: subEnabled ? { enabled: true, lang: subLang || 'en', format: subFormat, embed: subEmbed } : null,
    clip: (clipStart || clipEnd) ? { start: clipStart, end: clipEnd } : null,
  });

  const formatNoteFor = (id, list) =>
    (list || videoInfo?.formats || []).find((f) => f.id === id)?.note || 'Best Quality';

  const buildCurrentItem = () => ({
    id: nextId(),
    url,
    title: videoInfo?.title || url,
    uploader: videoInfo?.uploader || '',
    thumbnail: videoInfo?.thumbnail || '',
    duration: videoInfo?.duration || '',
    format: selectedFormat,
    formatNote: formatNoteFor(selectedFormat),
    options: currentOptions(),
    status: 'queued',
  });

  // ---- History ----------------------------------------------------------

  const recordHistory = async (item) => {
    const entry = {
      title: item.title,
      uploader: item.uploader,
      thumbnail: item.thumbnail,
      url: item.url,
      formatNote: item.formatNote,
      dir: downloadDir,
    };
    if (window.pywebview?.api) {
      try {
        const res = await window.pywebview.api.append_history(entry);
        if (res?.history) setHistory(res.history);
      } catch (_) { /* non-fatal */ }
    } else {
      setHistory((prev) => [{ ...entry, time: Date.now() / 1000 }, ...prev]);
    }
  };

  const handleClearHistory = async () => {
    if (window.pywebview?.api) {
      try { await window.pywebview.api.clear_history(); } catch (_) { /* non-fatal */ }
    }
    setHistory([]);
  };

  const handleOpenLocation = (entry) => {
    if (window.pywebview?.api) {
      window.pywebview.api.open_path(entry.dir || downloadDir);
    }
  };

  // ---- Download (single) ------------------------------------------------

  const handleBrowseDir = async () => {
    if (window.pywebview?.api) {
      try {
        const path = await window.pywebview.api.select_folder();
        if (path) {
          setDownloadDir(path);
          window.pywebview.api.save_setting('download_dir', path);
        }
      } catch (err) {
        setError('Folder picker failed: ' + err.message);
      }
    }
  };

  const handleStartArchival = async () => {
    if (!url || !downloadDir) return;
    setError('');
    setIsDownloading(true);
    setProgress({ status: 'starting', percent: 0, message: 'Contacting host stream...' });
    singleItemRef.current = buildCurrentItem();
    if (window.pywebview?.api) {
      try {
        await window.pywebview.api.start_download(url, downloadDir, selectedFormat, currentOptions());
      } catch (err) {
        setError('Extraction trigger failed: ' + err.message);
        setIsDownloading(false);
        singleItemRef.current = null;
      }
    } else {
      mockDownload(() => {
        setCompletionState('animating');
        if (singleItemRef.current) { recordHistory(singleItemRef.current); singleItemRef.current = null; }
      });
    }
  };

  const mockDownload = (onDone) => {
    let pct = 0;
    const interval = setInterval(() => {
      pct += 20;
      setProgress({
        status: 'downloading', percent: pct, speed: '12.4 MB/s',
        eta: `00:0${Math.max(0, 5 - pct / 20)}`, downloaded: `${pct} MB`, total: '100 MB',
        filename: 'broadcast.mp4', message: 'Downloading video...',
      });
      if (pct >= 100) {
        clearInterval(interval);
        setProgress({ status: 'merging', percent: 100, message: 'Processing stream components...' });
        setTimeout(() => { setIsDownloading(false); onDone(); }, 900);
      }
    }, 400);
  };

  const handleCancelQueueItem = async (item) => {
    if (window.pywebview?.api) {
      try { await window.pywebview.api.cancel_download(String(item.id)); }
      catch (err) { console.error('Per-item cancel failed:', err); }
    } else {
      setQueueStatus(item.id, 'error', 'Cancelled by user');
    }
  };

  const handleCancelDownload = async () => {
    if (window.pywebview?.api) {
      try {
        await window.pywebview.api.cancel_download();
        setProgress((prev) => ({ ...prev, message: 'ABORTING TRANSMISSION...' }));
      } catch (err) {
        console.error('Cancel failed:', err);
      }
    } else {
      setIsDownloading(false);
      setError('Extraction aborted by user.');
    }
    queueRunningRef.current = false;
    setQueueRunning(false);
  };

  // ---- Queue ------------------------------------------------------------

  const addCurrentToQueue = () => {
    if (!url) return;
    setQueueSafe((prev) => [...prev, buildCurrentItem()]);
    resetToIdle();
  };

  const addPlaylistSelectionToQueue = () => {
    if (!playlist) return;
    const note = formatNoteFor(playlistQuality, PLAYLIST_QUALITY);
    // Entries inherit the deck-level settings — without this they'd download
    // signed out, ignoring the authentication the playlist itself needed to list.
    const entryOptions = baseOptions();
    const items = playlist.entries
      .filter((e) => e.selected)
      .map((e) => ({
        id: nextId(),
        url: e.url,
        title: e.title,
        uploader: e.uploader || playlist.uploader,
        thumbnail: '',
        duration: e.duration,
        format: playlistQuality,
        formatNote: note,
        options: entryOptions,
        status: 'queued',
      }));
    if (!items.length) return;
    setQueueSafe((prev) => [...prev, ...items]);
    resetToIdle();
    setView('queue');
  };

  const removeQueueItem = (id) =>
    setQueueSafe((prev) => prev.filter((q) => q.id !== id));

  const setQueueStatus = (id, status, errMsg) =>
    setQueueSafe((prev) => prev.map((q) => (q.id === id ? { ...q, status, error: errMsg } : q)));

  const setQueueProgress = (id, progress) =>
    setQueueSafe((prev) => prev.map((q) => (q.id === id ? { ...q, progress: { ...q.progress, ...progress } } : q)));

  const clearFinishedQueue = () =>
    setQueueSafe((prev) => prev.filter((q) => q.status === 'queued' || q.status === 'active'));

  // Mock per-item download for browser dev (no pywebview) — exercises the full bar.
  const mockJobDownload = (itemId, done) => {
    let pct = 0;
    const step = 12 + (itemId % 3) * 6; // vary pace per item
    const interval = setInterval(() => {
      if (!queueRunningRef.current) { clearInterval(interval); done({ ok: false, message: 'Halted by user' }); return; }
      pct = Math.min(100, pct + step);
      setQueueProgress(itemId, {
        percent: pct,
        downloaded: `${pct.toFixed(1)} MB`,
        total: '100.0 MB',
        speed: `${(7 + (itemId % 4)).toFixed(1)} MB/s`,
        eta: `00:${String(Math.max(0, Math.round((100 - pct) / 25))).padStart(2, '0')}`,
      });
      if (pct >= 100) {
        clearInterval(interval);
        setQueueProgress(itemId, { percent: 100, label: 'MERGING' });
        setTimeout(() => done({ ok: true }), 700);
      }
    }, 500);
  };

  // Download one queue item, routing its job-tagged progress to its own row.
  const downloadOne = (item) =>
    new Promise((resolve) => {
      const jobId = String(item.id);
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        delete jobHandlersRef.current[jobId];
        resolve(result);
      };
      jobHandlersRef.current[jobId] = (data) => {
        if (data.status === 'downloading') {
          setQueueProgress(item.id, {
            percent: data.percent, downloaded: data.downloaded,
            total: data.total, speed: data.speed, eta: data.eta, label: null,
          });
        } else if (data.status === 'merging' || data.status === 'processing') {
          setQueueProgress(item.id, { percent: 100, label: 'MERGING' });
        } else if (data.status === 'completed') {
          finish({ ok: true });
        } else if (data.status === 'error') {
          finish({ ok: false, message: data.message });
        }
      };
      if (window.pywebview?.api) {
        Promise.resolve(
          window.pywebview.api.start_download(item.url, downloadDir, item.format, item.options || {}, jobId)
        ).catch((err) => finish({ ok: false, message: err.message }));
      } else {
        mockJobDownload(item.id, finish);
      }
    });

  // Synchronous, race-free claim so parallel workers never grab the same item.
  const claimNext = () => {
    const item = queueRef.current.find((q) => q.status === 'queued' && !claimedRef.current.has(q.id));
    if (!item) return null;
    claimedRef.current.add(item.id);
    setQueueStatus(item.id, 'active');
    return item;
  };

  const runQueue = async () => {
    if (queueRunningRef.current) return;
    if (!queueRef.current.some((q) => q.status === 'queued')) return;
    claimedRef.current = new Set();
    queueRunningRef.current = true;
    setQueueRunning(true);
    setView('queue');

    const worker = async () => {
      while (queueRunningRef.current) {
        const item = claimNext();
        if (!item) break;
        const res = await downloadOne(item);
        if (res.ok) {
          setQueueStatus(item.id, 'done');
          setQueueProgress(item.id, { percent: 100, label: 'DONE' });
          await recordHistory(item);
        } else {
          setQueueStatus(item.id, 'error', res.message);
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    queueRunningRef.current = false;
    setQueueRunning(false);
  };

  const stopQueue = () => {
    queueRunningRef.current = false;
    setQueueRunning(false);
    if (window.pywebview?.api) {
      try { window.pywebview.api.cancel_download(); } catch (err) { console.error('Halt failed:', err); }
    }
  };

  const queuePending = queue.filter((q) => q.status === 'queued').length;
  const playlistSelected = playlist ? playlist.entries.filter((e) => e.selected).length : 0;

  // ---- Render helpers ---------------------------------------------------

  const renderProgressCard = () => (
    <div className="progress-card">
      <div className="progress-header">
        <div className="progress-state">
          <span className="progress-state-dot"></span>
          <span>{progress?.message || 'ARCHIVING BROADCAST'}</span>
        </div>
        <div className="progress-eta">
          {progress?.status === 'downloading' && progress.eta && progress.eta !== 'N/A'
            ? `ETA: ${progress.eta}` : '--:--'}
        </div>
      </div>
      <div className="meter-container">
        <div className="meter-fill" style={{ width: `${progress?.percent ?? 0}%` }} />
      </div>
      <div className="progress-telemetry-grid">
        <div className="telemetry-item">
          <span className="telemetry-label">RATE</span>
          <span className="telemetry-val">{progress?.status === 'downloading' ? progress.speed : '—'}</span>
        </div>
        <div className="telemetry-item">
          <span className="telemetry-label">TRANSFER</span>
          <span className="telemetry-val">
            {progress?.status === 'downloading' && progress.downloaded
              ? `${progress.downloaded} / ${progress.total}` : '—'}
          </span>
        </div>
        <div className="telemetry-item">
          <span className="telemetry-label">PROGRESS</span>
          <span className="telemetry-val">{progress ? `${Math.round(progress.percent)}%` : '0%'}</span>
        </div>
      </div>
      <button className="cancel-btn" onClick={handleCancelDownload}>
        ABORT EXTRACTION
      </button>
    </div>
  );

  // Real metadata used to render truthful filename examples. Falls back to
  // representative placeholders before a video has been scanned.
  const isAudioOnly = (selectedFormat || '').includes('bestaudio') && !(selectedFormat || '').includes('+');
  const fileExt = isAudioOnly ? 'mp3' : 'mp4';
  const activeCodec = VIDEO_CODECS.find((c) => c.value === videoCodec) || VIDEO_CODECS[0];
  const fileMeta = {
    title: videoInfo?.title || 'Video title',
    uploader: videoInfo?.uploader || 'Channel name',
    upload_date: videoInfo?.upload_date || '20260628',
    id: videoInfo?.id || 'dQw4w9WgXcQ',
    ext: fileExt,
  };

  // Codec preference is sticky — persist it so the compatibility choice carries
  // across sessions (most users set "plays everywhere" once and forget it).
  const applyVideoCodec = (value) => {
    setVideoCodec(value);
    if (window.pywebview?.api) window.pywebview.api.save_setting('video_codec', value);
  };

  // Selecting a naming style: mirror the dropdown's onChange so picking from the
  // overlay and the dropdown stay in lockstep, and persist non-custom choices.
  const applyFilenameTemplate = (value) => {
    setFilenamePreset(value);
    if (value !== '__custom__') {
      setFilenameTemplate(value);
      if (window.pywebview?.api) window.pywebview.api.save_setting('filename_template', value);
    }
  };

  // Open the FILENAME BUILDER, seeding the blocks from whatever name is active now
  // (works for presets and custom alike, since both are templates).
  const openFilenameBuilder = () => {
    setFilenameBlocks(parseTemplateToBlocks(filenameTemplate, nextBlockId));
    setActiveHelp('filename');
  };

  // Apply an edited block arrangement: persist it, and reflect it in the dropdown
  // (snap back to a matching preset when the composition happens to equal one).
  const commitBlocks = (blocks) => {
    setFilenameBlocks(blocks);
    if (blocks.length === 0) return; // keep the last valid name; the builder shows an "add a block" hint
    const tpl = blocksToTemplate(blocks);
    setFilenameTemplate(tpl);
    const matched = FILENAME_PRESETS.find((p) => p.value === tpl);
    setFilenamePreset(matched ? matched.value : '__custom__');
    if (window.pywebview?.api) window.pywebview.api.save_setting('filename_template', tpl);
  };

  // Block mutations used by the builder's click + drag interactions.
  const addBlock = (spec) => commitBlocks([
    ...filenameBlocks,
    spec.kind === 'var'
      ? { id: nextBlockId(), kind: 'var', role: spec.role }
      : { id: nextBlockId(), kind: 'sep', text: spec.text },
  ]);
  const removeBlockAt = (idx) => commitBlocks(filenameBlocks.filter((_, i) => i !== idx));
  const moveBlock = (from, to) => {
    if (from === to || from < 0) return;
    const next = [...filenameBlocks];
    const [moved] = next.splice(from, 1);
    next.splice(from < to ? to - 1 : to, 0, moved);
    commitBlocks(next);
  };

  const renderOptions = () => {
    const subs = videoInfo?.subtitles || [];
    return (
      <div className="options-disclosure">
        <button
          className={`options-toggle${optionsOpen ? ' open' : ''}`}
          onClick={() => setOptionsOpen((o) => !o)}
          aria-expanded={optionsOpen}
        >
          <span>TRANSMISSION OPTIONS{
            (subEnabled || clipStart || clipEnd || filenameTemplate !== '%(title)s.%(ext)s')
              ? ' • ARMED' : ''
          }</span>
          <span className="chevron">▾</span>
        </button>
        {optionsOpen && (
          <div className="options-body">
            <div className="opt-block">
              <label className="tactile-checkbox">
                <input type="checkbox" checked={subEnabled} onChange={(e) => setSubEnabled(e.target.checked)} />
                <span className="checkbox-box"></span>
                <span className="checkbox-text">CAPTION TRACK</span>
              </label>
              <div className={`opt-grid${subEnabled ? '' : ' opt-disabled'}`}>
                <div>
                  <span className="opt-mini-label">LANGUAGE</span>
                  <select className="select-dropdown compact" value={subLang} onChange={(e) => setSubLang(e.target.value)}>
                    {subs.length === 0 && <option value="en">English (default)</option>}
                    {subs.map((s) => (
                      <option key={s.code} value={s.code}>{langName(s.code)}{s.auto ? ' (auto)' : ''}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className="opt-mini-label">FORMAT</span>
                  <select className="select-dropdown compact" value={subFormat} onChange={(e) => setSubFormat(e.target.value)}>
                    {SUB_FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
                  </select>
                </div>
              </div>
              {subEnabled && (
                <label className="tactile-checkbox">
                  <input type="checkbox" checked={subEmbed} onChange={(e) => setSubEmbed(e.target.checked)} />
                  <span className="checkbox-box"></span>
                  <span className="checkbox-text">EMBED INTO VIDEO</span>
                </label>
              )}
            </div>

            <div className="opt-block">
              <span className="opt-mini-label">SIGNAL TRIM // IN — OUT (HH:MM:SS)</span>
              <div className="opt-grid">
                <input
                  className="time-input" placeholder="START — e.g. 00:01:30"
                  value={clipStart} onChange={(e) => setClipStart(e.target.value)}
                />
                <input
                  className="time-input" placeholder="END — e.g. 00:03:00"
                  value={clipEnd} onChange={(e) => setClipEnd(e.target.value)}
                />
              </div>
            </div>

            <div className="opt-block">
              <div className="opt-mini-label-row">
                <span className="opt-mini-label">OUTPUT FILENAME</span>
                <div className="help-badge" tabIndex={0} aria-label="What is output filename">
                  <span className="help-icon">?</span>
                  <div className="help-tooltip" role="tooltip">
                    <div className="help-tooltip-title">OUTPUT FILENAME</div>
                    <div className="help-tooltip-section">
                      Controls how your downloaded files are named. Pick a ready-made
                      style below, or choose "Custom…" to build your own.
                    </div>
                  </div>
                </div>
              </div>
              <select className="select-dropdown compact" value={filenamePreset}
                onChange={(e) => {
                  if (e.target.value === '__custom__') openFilenameBuilder();
                  else applyFilenameTemplate(e.target.value);
                }}>
                {FILENAME_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              <div className="filename-preview">
                <span className="filename-preview-label">SAVES AS</span>
                <span className="filename-preview-name">{resolveTemplate(filenameTemplate, fileMeta)}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ---- Authentication ---------------------------------------------------

  // Persisted as a machine-level preference, not a per-video one: the whole point
  // is that it's already armed when a sign-in-gated link gets pasted.
  const applyCookiesMode = (mode) => {
    setCookiesMode(mode);
    setAuthNotice('');
    if (window.pywebview?.api) window.pywebview.api.save_setting('cookies_mode', mode);
  };

  const applyCookiesBrowser = (value) => {
    setCookiesBrowser(value);
    setAuthNotice('');
    if (window.pywebview?.api) window.pywebview.api.save_setting('cookies_browser', value);
  };

  // Which browser the 'auto' choice resolves to, per the backend's probe.
  const detected = detectedBrowsers || [];
  const probed = detectedBrowsers !== null;
  const activeBrowser = cookiesBrowser === 'auto' ? detected[0] : cookiesBrowser;

  const browserHint = () => {
    if (probed && !activeBrowser)
      return 'No browser cookie store found on this machine — transmissions will run signed out.';
    if (probed && !detected.includes(activeBrowser))
      return `No ${browserLabel(activeBrowser)} cookie store found here — Kinescope falls back to signed out if it can't read one.`;
    return `Reading your sign-in from ${browserLabel(activeBrowser) || 'your browser'}. Close it first — some browsers lock the cookie store while open; Kinescope continues signed out if it can't be read.`;
  };

  // Lives outside TRANSMISSION OPTIONS on purpose: those only render once a scan
  // resolves, and sign-in-gated videos fail at the scan itself — so this has to be
  // armable before a link is ever pasted.
  const renderAuthBlock = () => (
    <div className="input-group">
      <div className="input-label-row">
        <label className="input-label">AUTHENTICATION</label>
        <button type="button" className="help-badge" aria-label="What is authentication"
          onClick={() => setActiveHelp('auth')}>
          <span className="help-icon">?</span>
        </button>
      </div>
      <label className="tactile-checkbox">
        <input type="checkbox" checked={cookiesMode === 'browser'}
          onChange={(e) => applyCookiesMode(e.target.checked ? 'browser' : 'none')} />
        <span className="checkbox-box"></span>
        <span className="checkbox-text">USE BROWSER COOKIES</span>
      </label>
      {cookiesMode === 'browser' && (
        <div style={{ paddingLeft: '24px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <select className="select-dropdown compact" value={cookiesBrowser}
            onChange={(e) => applyCookiesBrowser(e.target.value)}>
            <option value="auto">
              Auto-detect{probed && detected.length ? ` — ${browserLabel(detected[0])}` : ''}
            </option>
            {detected.length > 0 && (
              <optgroup label="FOUND ON THIS MACHINE">
                {detected.map((b) => <option key={b} value={b}>{browserLabel(b)}</option>)}
              </optgroup>
            )}
            <optgroup label={detected.length > 0 ? 'OTHER' : 'BROWSERS'}>
              {COOKIE_BROWSERS.filter((b) => !detected.includes(b)).map((b) => (
                <option key={b} value={b}>{browserLabel(b)}</option>
              ))}
            </optgroup>
          </select>
          <span className="cookies-inline-hint">{browserHint()}</span>
        </div>
      )}
      <label className="tactile-checkbox" style={{ marginTop: cookiesMode === 'browser' ? 6 : 0 }}>
        <input type="checkbox" checked={cookiesMode === 'file'}
          onChange={(e) => applyCookiesMode(e.target.checked ? 'file' : 'none')} />
        <span className="checkbox-box"></span>
        <span className="checkbox-text">USE COOKIES FILE</span>
      </label>
      {cookiesMode === 'file' && (
        <div style={{ paddingLeft: '24px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div className="directory-row">
            <button className="browse-btn" onClick={async () => {
              if (!window.pywebview?.api) return;
              try {
                const path = await window.pywebview.api.select_cookie_file();
                if (path) { setCookiesFile(path); window.pywebview.api.save_setting('cookies_file', path); }
              } catch (err) { console.error('Cookie file picker failed:', err); }
            }}>BROWSE</button>
            <input type="text" className="input-bar" style={{ fontSize: '0.75rem' }}
              placeholder="Path to cookies.txt (Netscape format)..."
              value={cookiesFile}
              onChange={(e) => {
                setCookiesFile(e.target.value);
                if (window.pywebview?.api && e.target.value)
                  window.pywebview.api.save_setting('cookies_file', e.target.value);
              }} />
          </div>
          <span className="cookies-inline-hint">
            Netscape-format cookies.txt — export via browser extension, works without closing your browser.
          </span>
        </div>
      )}
    </div>
  );

  // FILE MANIFEST / AUTHENTICATION overlay — a large defocusing panel (the deck's
  // "inventory") that shows real, plain-language examples instead of raw tokens.
  const renderHelpOverlay = () => {
    const close = () => setActiveHelp(null);
    const pickPresets = FILENAME_PRESETS.filter((p) => p.value !== '__custom__');

    // Insert whatever is being dragged at `index` — a new palette block, or a
    // reorder of an existing strip block.
    const dropAt = (index) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      if (d.source === 'palette') {
        const blk = d.spec.kind === 'var'
          ? { id: nextBlockId(), kind: 'var', role: d.spec.role }
          : { id: nextBlockId(), kind: 'sep', text: d.spec.text };
        const next = [...filenameBlocks];
        next.splice(index, 0, blk);
        commitBlocks(next);
      } else if (d.source === 'strip') {
        moveBlock(d.index, index);
      }
    };

    return (
      <div className="help-overlay" role="dialog" aria-modal="true">
        <div className="help-overlay-backdrop" onClick={close} />
        <div className="help-overlay-panel" onClick={(e) => e.stopPropagation()}>
          <button className="help-overlay-close" onClick={close} aria-label="Close">✕</button>

          {activeHelp === 'filename' && (
            <>
              <div className="help-overlay-title">FILENAME BUILDER</div>
              <p className="help-overlay-intro">
                Drag the blocks you want into the name — each one fills in with this
                video's real details. Tap a block to add it, or start from a ready-made style.
              </p>

              <div className="builder-section-label">QUICK PICKS</div>
              <div className="builder-quickpicks">
                {pickPresets.map((p) => (
                  <button key={p.value}
                    className={`quickpick-chip${filenamePreset === p.value ? ' selected' : ''}`}
                    onClick={() => commitBlocks(parseTemplateToBlocks(p.value, nextBlockId))}
                  >{p.label}</button>
                ))}
              </div>

              <div className="builder-section-label">YOUR NAME</div>
              <div
                className={`builder-strip${filenameBlocks.length === 0 ? ' empty' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); dropAt(filenameBlocks.length); }}
              >
                {filenameBlocks.length === 0 && (
                  <span className="builder-strip-hint">Drag or tap a block to start…</span>
                )}
                {filenameBlocks.map((b, i) => (
                  <span key={b.id}
                    className={`fname-block ${b.kind === 'var' ? `role-${b.role}` : 'role-sep'}`}
                    draggable
                    onDragStart={() => { dragRef.current = { source: 'strip', index: i }; }}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropAt(i); }}
                    title={b.kind === 'var' ? SEGMENT_LABELS[b.role] : 'separator'}
                  >
                    <span className="fname-block-text">
                      {b.kind === 'sep' ? (b.text === ' ' ? '␣' : b.text) : blockText(b, fileMeta)}
                    </span>
                    <span className="block-remove" role="button" aria-label="Remove"
                      onClick={() => removeBlockAt(i)}>✕</span>
                  </span>
                ))}
                <span className="fname-block-ext">.{fileMeta.ext}</span>
              </div>

              <div className="builder-section-label">BLOCKS</div>
              <div className="builder-palette">
                {VAR_BLOCKS.map((v) => (
                  <button key={v.role}
                    className={`palette-block role-${v.role}`}
                    draggable
                    onDragStart={() => { dragRef.current = { source: 'palette', spec: { kind: 'var', role: v.role } }; }}
                    onClick={() => addBlock({ kind: 'var', role: v.role })}
                  >
                    <span className="palette-block-label">{v.label}</span>
                    <span className="palette-block-value">{blockText({ kind: 'var', role: v.role }, fileMeta)}</span>
                  </button>
                ))}
                {SEP_BLOCKS.map((s) => (
                  <button key={s.label}
                    className="palette-block role-sep"
                    draggable
                    onDragStart={() => { dragRef.current = { source: 'palette', spec: { kind: 'sep', text: s.text } }; }}
                    onClick={() => addBlock({ kind: 'sep', text: s.text })}
                  >
                    <span className="palette-block-label">{s.label}</span>
                    <span className="palette-block-value">{s.text === ' ' ? '␣' : s.text.trim() || s.text}</span>
                  </button>
                ))}
              </div>

              <div className="builder-preview">
                <span className="filename-preview-label">SAVES AS</span>
                <span className="builder-preview-name">
                  {filenameBlocks.length === 0
                    ? <span className="seg seg-sep">pick a block…</span>
                    : (
                      <>
                        {filenameBlocks.map((b) => (
                          <span key={b.id} className={`seg ${b.kind === 'var' ? `seg-${b.role}` : 'seg-sep'}`}>
                            {b.kind === 'sep' ? b.text : blockText(b, fileMeta)}
                          </span>
                        ))}
                        <span className="seg seg-ext">.{fileMeta.ext}</span>
                      </>
                    )}
                </span>
              </div>
            </>
          )}

          {activeHelp === 'auth' && (
            <>
              <div className="help-overlay-title">SIGN-IN &amp; PRIVATE VIDEOS</div>
              <p className="help-overlay-intro">
                Some videos only play when you're logged in — age-restricted clips,
                members-only posts, private uploads. Authentication lets Kinescope
                download those using your existing sign-in, and it's applied when a
                link is scanned as well as when it's downloaded. It's on by default;
                if the sign-in can't be read, Kinescope just carries on signed out.
              </p>
              <div className="auth-explainer">
                <div className="auth-card">
                  <div className="auth-card-title">Use browser cookies</div>
                  <p className="auth-card-line">
                    <strong>Use this when</strong> you're already signed in to the site
                    in a browser on this computer. Kinescope borrows that sign-in
                    automatically — nothing to export. Leave it on <em>Auto-detect</em>{' '}
                    and it picks up whichever browser it finds installed.
                  </p>
                  <p className="auth-card-note">
                    Close the browser first — some browsers lock their cookies while open.
                  </p>
                </div>
                <div className="auth-card">
                  <div className="auth-card-title">Use a cookies file</div>
                  <p className="auth-card-line">
                    <strong>Use this when</strong> you'd rather not close your browser, or
                    you're moving a sign-in between machines. Export a
                    <span className="auth-mono"> cookies.txt</span> file with a browser
                    extension and point Kinescope at it.
                  </p>
                  <p className="auth-card-note">
                    Works with any browser, no need to close anything.
                  </p>
                </div>
              </div>
            </>
          )}

          {activeHelp === 'codec' && (
            <>
              <div className="help-overlay-title">VIDEO CODEC</div>
              <p className="help-overlay-intro">
                A codec is how the video is compressed. It doesn't change what you
                see — only the file size and which players can open it. Tap one to
                select it. If a player ever says <em>"you need a new codec"</em>,
                that file used a codec the player can't read — pick H.264 to avoid it.
              </p>
              <div className="codec-grid">
                {VIDEO_CODECS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={`codec-card${videoCodec === c.value ? ' selected' : ''}`}
                    onClick={() => applyVideoCodec(c.value)}
                  >
                    <div className="codec-card-head">
                      <span className="codec-card-title">{c.label}</span>
                      <div className="codec-card-tag-row">
                        <span className="codec-card-tag">{c.tag}</span>
                        {videoCodec === c.value && <span className="codec-card-active">● ACTIVE</span>}
                      </div>
                    </div>
                    <p className="codec-card-detail">{c.detail}</p>
                    <p className="codec-card-trade"><strong>Trade-off:</strong> {c.trade}</p>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderArchiveActions = () => {
    if (isDownloading) return renderProgressCard();

    if (completionState === 'animating') {
      return (
        <div className="completion-readout">
          <span className="completion-text">{completionText}</span>
          <span className="completion-cursor">_</span>
        </div>
      );
    }

    if (completionState === 'done') {
      return (
        <div className="completion-done">
          <div className="completion-done-label">TRANSMISSION COMPLETE</div>
          <button className="btn-ghost" onClick={resetToIdle}>NEW TRANSMISSION</button>
        </div>
      );
    }

    // Playlist browser takes over the action area when a playlist is detected.
    if (playlist) return renderPlaylistBrowser();

    return (
      <>
        {error && (
          <div className="action-error">
            <strong>FAULT //</strong> {error}
          </div>
        )}
        {videoInfo?.formats && videoInfo.formats.length > 0 && (
          <>
            <div className="input-group">
              <label className="input-label">DECRYPTION FORMAT</label>
              <select
                className="select-dropdown"
                value={selectedFormat}
                onChange={(e) => setSelectedFormat(e.target.value)}
              >
                {videoInfo.formats.map((f) => (
                  <option key={f.id} value={f.id}>{f.note}</option>
                ))}
              </select>
            </div>
            {!isAudioOnly && (
              <div className="input-group">
                <div className="input-label-row">
                  <label className="input-label">VIDEO CODEC</label>
                  <button type="button" className="help-badge" aria-label="What is a video codec"
                    onClick={() => setActiveHelp('codec')}>
                    <span className="help-icon">?</span>
                  </button>
                </div>
                <select
                  className="select-dropdown"
                  value={videoCodec}
                  onChange={(e) => applyVideoCodec(e.target.value)}
                >
                  {VIDEO_CODECS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <span className="input-hint">{activeCodec.tag} — {activeCodec.blurb}</span>
              </div>
            )}
            {renderOptions()}
          </>
        )}
        <div className="btn-row">
          <button
            className="engage-btn"
            disabled={!url || !downloadDir || isLoadingInfo}
            onClick={handleStartArchival}
          >
            ENGAGE EXTRACTION
          </button>
          <button
            className="secondary-btn"
            disabled={!url || !downloadDir || isLoadingInfo}
            onClick={addCurrentToQueue}
            title="Add this source to the download queue"
          >
            + QUEUE
          </button>
        </div>
      </>
    );
  };

  const renderPlaylistBrowser = () => (
    <div className="playlist-panel">
      <div className="playlist-head">
        <span className="playlist-head-title">{playlist.title}</span>
        <span className="playlist-head-count">{playlistSelected}/{playlist.count} SELECTED</span>
      </div>
      <div className="playlist-toolbar">
        <button className="playlist-link" onClick={() => togglePlaylistAll(true)}>SELECT ALL</button>
        <button className="playlist-link" onClick={() => togglePlaylistAll(false)}>CLEAR</button>
        <select
          className="select-dropdown compact"
          style={{ marginLeft: 'auto', width: 'auto' }}
          value={playlistQuality}
          onChange={(e) => setPlaylistQuality(e.target.value)}
        >
          {PLAYLIST_QUALITY.map((q) => <option key={q.id} value={q.id}>{q.note}</option>)}
        </select>
      </div>
      {/^bestvideo\[height<=(480|360|240|144)\]/.test(playlistQuality) && (
        <span className="cookies-inline-hint">
          Low resolutions apply per entry only where the source offers them — most do, but
          a few entries may land on their closest available size instead.
        </span>
      )}
      <div className="playlist-list">
        {playlist.entries.map((e, i) => (
          <div
            key={e.url + i}
            className={`playlist-item${e.selected ? ' selected' : ''}`}
            onClick={() => togglePlaylistEntry(i)}
          >
            <span className="playlist-check"></span>
            <span className="playlist-item-title">{e.title}</span>
            <span className="playlist-item-dur">{e.duration}</span>
          </div>
        ))}
      </div>
      <div className="playlist-actions">
        <button className="btn-ghost" onClick={resetToIdle}>CANCEL</button>
        <button className="engage-btn" disabled={playlistSelected === 0} onClick={addPlaylistSelectionToQueue}>
          QUEUE {playlistSelected} ENTR{playlistSelected === 1 ? 'Y' : 'IES'}
        </button>
      </div>
    </div>
  );

  const togglePlaylistEntry = (idx) =>
    setPlaylist((p) => ({
      ...p,
      entries: p.entries.map((e, i) => (i === idx ? { ...e, selected: !e.selected } : e)),
    }));

  const togglePlaylistAll = (val) =>
    setPlaylist((p) => ({ ...p, entries: p.entries.map((e) => ({ ...e, selected: val })) }));

  // Compact "42% · 12.4 MB / 100 MB · 8.1 MB/s · ETA 00:07" line, omitting unknowns.
  const queueStatsLine = (q) => {
    const p = q.progress || {};
    if (p.label) return p.label; // MERGING / DONE
    const parts = [];
    if (p.percent != null) parts.push(`${Math.round(p.percent)}%`);
    if (p.downloaded && p.downloaded !== 'N/A') parts.push(`${p.downloaded} / ${p.total || '—'}`);
    if (p.speed && p.speed !== 'N/A') parts.push(p.speed);
    if (p.eta && p.eta !== 'N/A') parts.push(`ETA ${p.eta}`);
    return parts.length ? parts.join(' · ') : 'STARTING…';
  };

  const renderQueueView = () => (
    <main className="control-deck" style={{ flex: 1, minHeight: 0 }}>
      {queue.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">▥</span>
          <span>QUEUE EMPTY</span>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.55rem' }}>
            Add sources from the ARCHIVE channel
          </span>
        </div>
      ) : (
        <>
          <div className="view-scroll">
            {queue.map((q) => (
              <div key={q.id} className="queue-item">
                <span className={`queue-status-dot ${q.status}`}></span>
                <div className="queue-item-body">
                  <span className="queue-item-title">{q.title}</span>
                  {q.status === 'active' ? (
                    <>
                      <div className="queue-meter">
                        <div className="queue-meter-fill" style={{ width: `${Math.round(q.progress?.percent ?? 0)}%` }} />
                      </div>
                      <span className="queue-stats">{queueStatsLine(q)}</span>
                    </>
                  ) : (
                    <span className="queue-item-meta">{q.formatNote}{q.error ? ` // ${q.error}` : ''}</span>
                  )}
                </div>
                <span className={`queue-item-state ${q.status}`}>{q.status.toUpperCase()}</span>
                {q.status === 'active'
                  ? <button className="queue-cancel-item" onClick={() => handleCancelQueueItem(q)} aria-label="Cancel">×</button>
                  : (q.status === 'queued' || q.status === 'error' || q.status === 'done') && !queueRunning
                    ? <button className="queue-remove" onClick={() => removeQueueItem(q.id)} aria-label="Remove">×</button>
                    : null
                }
              </div>
            ))}
          </div>
          <div className="queue-toolbar">
            {queueRunning ? (
              <button className="engage-btn" onClick={stopQueue}>HALT QUEUE</button>
            ) : (
              <button className="engage-btn" disabled={queuePending === 0 || !downloadDir} onClick={runQueue}>
                RUN QUEUE // {queuePending} PENDING
              </button>
            )}
            <button className="secondary-btn" onClick={clearFinishedQueue} disabled={queueRunning}>
              CLEAR DONE
            </button>
          </div>
        </>
      )}
    </main>
  );

  const renderLogView = () => (
    <main className="control-deck" style={{ flex: 1, minHeight: 0 }}>
      {history.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">◷</span>
          <span>NO ARCHIVED TRANSMISSIONS YET</span>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.55rem' }}>
            Completed downloads are logged here
          </span>
        </div>
      ) : (
        <>
          <div className="view-scroll">
            {history.map((h, i) => (
              <div key={i} className="history-item">
                {h.thumbnail
                  ? <img className="history-thumb" src={h.thumbnail} alt="" />
                  : <div className="history-thumb" />}
                <div className="history-body">
                  <span className="history-title">{h.title}</span>
                  <span className="history-meta">
                    <span className="history-fmt">{h.formatNote}</span> // {formatStamp(h.time)}
                  </span>
                </div>
                <button className="history-open" onClick={() => handleOpenLocation(h)}>OPEN</button>
              </div>
            ))}
          </div>
          <div className="log-toolbar">
            <span className="log-count">{history.length} ENTR{history.length === 1 ? 'Y' : 'IES'}</span>
            <button className="danger-btn" onClick={handleClearHistory}>CLEAR LOG</button>
          </div>
        </>
      )}
    </main>
  );

  // ---- Telemetry strip on the scope -------------------------------------

  const scopeTitle = playlist
    ? `PLAYLIST // ${playlist.title}`
    : videoInfo
      ? videoInfo.title
      : (isLoadingInfo || isLoadingPlaylist) ? 'POLLING SOURCE STREAM...' : 'DECK IDLE // AWAITING URL';

  const scopeUploader = playlist
    ? `${playlist.count} ENTRIES`
    : videoInfo ? videoInfo.uploader : 'SOURCE: UNKNOWN';

  const scopeDuration = playlist
    ? 'PLAYLIST CARRIER'
    : videoInfo ? `DURATION // ${videoInfo.duration}` : 'DURATION: 00:00';

  return (
    <div className="deck-container">
      {/* Header */}
      <header className="deck-header">
        <div className="deck-title-group">
          <h1 className="deck-title">KINESCOPE<span>//</span></h1>
          <span className="deck-subtitle">STREAM ARCHIVAL DECK</span>
        </div>
        <nav className="deck-nav">
          <button className={`deck-tab${view === 'archive' ? ' active' : ''}`} onClick={() => setView('archive')}>
            ARCHIVE
          </button>
          <button className={`deck-tab${view === 'queue' ? ' active' : ''}`} onClick={() => setView('queue')}>
            QUEUE{queuePending > 0 && <span className="deck-tab-count">{queuePending}</span>}
          </button>
          <button className={`deck-tab${view === 'log' ? ' active' : ''}`} onClick={() => setView('log')}>
            LOG
          </button>
        </nav>
      </header>

      {/* Oscilloscope */}
      <div className="oscilloscope-card">
        <canvas ref={canvasRef} className="oscilloscope-canvas" />
        <div className="screen-overlay" />
        <div className="telemetry-readout">
          <div className="thumbnail-frame">
            {videoInfo?.thumbnail ? (
              <img src={videoInfo.thumbnail} className="thumbnail-img" alt="Video Thumbnail" />
            ) : (
              <div className="thumbnail-placeholder">
                {(isLoadingInfo || isLoadingPlaylist) ? 'SCANNING...' : playlist ? 'PLAYLIST' : 'NO CARRIER'}
              </div>
            )}
          </div>
          <div className="meta-details">
            <div className="meta-title">{scopeTitle}</div>
            <div className="meta-uploader">{scopeUploader}</div>
            <div className="meta-duration">{scopeDuration}</div>
          </div>
        </div>
      </div>

      {/* Channel body */}
      {view === 'archive' && (
        <main className="control-deck" style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4, paddingBottom: 72 }}>
          {ytdlpUpdateInfo && !ytdlpUpdateInfo.up_to_date && (
            <div className="deck-banner warning">
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', marginBottom: 4 }}>
                  YT-DLP OUT OF DATE
                </div>
                <div style={{ fontSize: '0.65rem', lineHeight: 1.5 }}>
                  Bundled: <strong>{ytdlpUpdateInfo.current}</strong> — Latest: <strong>{ytdlpUpdateInfo.latest}</strong>
                  <br />Download a fresh Kinescope release from GitHub to update.
                </div>
              </div>
            </div>
          )}
          {authNotice && (
            <div className="deck-banner warning">
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', marginBottom: 4 }}>
                  SIGNED-OUT FALLBACK
                </div>
                <div style={{ fontSize: '0.65rem', lineHeight: 1.5 }}>{authNotice}</div>
              </div>
            </div>
          )}
          <div className="input-group">
            <div className="input-label-row">
              <label className="input-label">BROADCAST SOURCE URL</label>
              <div className="help-badge" tabIndex={0} aria-label="Supported sources">
                <span className="help-icon">?</span>
                <div className="help-tooltip" role="tooltip">
                  <div className="help-tooltip-title">SUPPORTED SOURCES</div>
                  <div className="help-tooltip-section">
                    YouTube, Vimeo, TikTok, Twitch, Soundcloud, and 1000+ sites via yt-dlp.
                    Paste a playlist link to pick entries.
                  </div>
                </div>
              </div>
            </div>
            <input
              ref={urlInputRef}
              type="text"
              className="input-bar"
              placeholder="Paste video or playlist link..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={isDownloading}
              onKeyDown={(e) => {
                if ((e.key === 'Tab' || e.key === 'Enter') && clipboardSuggestion && !url) {
                  e.preventDefault();
                  setUrl(clipboardSuggestion);
                  setClipboardSuggestion('');
                }
              }}
            />
            {clipboardSuggestion && !url && (
              <div
                className="clipboard-suggestion"
                onClick={() => { setUrl(clipboardSuggestion); setClipboardSuggestion(''); }}
              >
                <span className="clipboard-signal-tag">SIGNAL DETECTED</span>
                <span className="clipboard-suggestion-arrow">↳</span>
                <span className="clipboard-suggestion-url">
                  {clipboardSuggestion.length > 52 ? clipboardSuggestion.slice(0, 52) + '…' : clipboardSuggestion}
                </span>
                <span className="clipboard-suggestion-hint">↵ TAB</span>
              </div>
            )}
            <span className="input-hint">YouTube, Vimeo, TikTok, Twitch, Soundcloud, and 1000+ other sources via yt-dlp.</span>
          </div>

          {renderAuthBlock()}

          <div className="input-group">
            <label className="input-label">DESTINATION DIRECTORY</label>
            <div className="directory-row">
              <button className="browse-btn" onClick={handleBrowseDir} disabled={isDownloading}>
                BROWSE
              </button>
              <input
                type="text"
                className="input-bar"
                placeholder="Select folder or paste directory path..."
                value={downloadDir}
                onChange={(e) => setDownloadDir(e.target.value)}
                disabled={isDownloading}
              />
            </div>
          </div>

          <div className="action-area">
            {renderArchiveActions()}
          </div>
        </main>
      )}

      {view === 'queue' && renderQueueView()}
      {view === 'log' && renderLogView()}

      {activeHelp && renderHelpOverlay()}
    </div>
  );
}
