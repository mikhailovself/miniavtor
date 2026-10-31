"""Single-video YouTube to MP3 worker, deployed as a separate Vercel project."""
from pathlib import Path
from tempfile import TemporaryDirectory, gettempdir
from urllib.parse import urlparse, parse_qs, quote
from urllib.request import Request, urlopen
from concurrent.futures import ThreadPoolExecutor
import base64
import binascii
import hashlib
import logging
import json
import os
import platform
import re
import shutil
import subprocess
import time
import uuid

os.environ.setdefault("NUMBA_CACHE_DIR", str(Path(gettempdir()) / "miniavtor-numba"))
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import imageio_ffmpeg
import lazy_loader

# Vercel's Python bundler omits .pyi files from some installed packages.
# librosa uses four such stubs at runtime to set up lazy imports. Keep the
# import map from the pinned wheel as a small worker asset instead.
_original_attach_stub = lazy_loader.attach_stub
_librosa_import_map = Path(__file__).resolve().parent.parent / "assets" / "librosa_lazy_imports.json"


def _attach_librosa_stub(package_name, filename):
    stub_path = Path(filename).with_suffix(".pyi")
    if stub_path.is_file() or not package_name.startswith("librosa"):
        return _original_attach_stub(package_name, filename)
    with _librosa_import_map.open(encoding="utf-8") as source:
        fallback = json.load(source)
    entry = fallback["packages"].get(package_name)
    if not entry:
        raise RuntimeError(f"No lazy import map for {package_name}")
    return lazy_loader.attach(package_name, entry["submodules"], entry["attributes"])


lazy_loader.attach_stub = _attach_librosa_stub
import librosa
import numpy as np
import yt_dlp

MAX_DURATION = 600
MAX_BYTES = 49 * 1024 * 1024
SAMPLE_RATE = 22050
SEARCH_SECONDS = 120
ANALYSIS_SECONDS = 30
PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


class BeatInputError(ValueError):
    pass


def load_youtube_cookies(temp):
    encoded = os.environ.get("YOUTUBE_COOKIES_BASE64", "").strip()
    if not encoded:
        logging.warning("YouTube cookies: YOUTUBE_COOKIES_BASE64 is not set in this deployment")
        return None
    try:
        contents = base64.b64decode(encoded, validate=True)
    except binascii.Error as error:
        raise RuntimeError("YOUTUBE_COOKIES_BASE64 is not valid Base64") from error
    if not contents.startswith((b"# Netscape HTTP Cookie File", b"# HTTP Cookie File")):
        raise RuntimeError("YouTube cookies are not in Netscape cookies.txt format")
    lines = contents.decode("utf-8", errors="replace").splitlines()
    youtube_rows = [line for line in lines if not line.startswith("#") and line.startswith((".youtube.com\t", "youtube.com\t"))]
    auth_names = {line.split("\t")[5] for line in youtube_rows if len(line.split("\t")) == 7}
    logging.warning("YouTube cookies loaded: %d rows; login cookies present: %s", len(youtube_rows), bool(auth_names.intersection({"SID", "SAPISID", "__Secure-3PAPISID"})))
    if not youtube_rows:
        raise RuntimeError("No YouTube cookies found in YOUTUBE_COOKIES_BASE64")
    path = Path(temp) / "youtube-cookies.txt"
    path.write_bytes(contents)
    path.chmod(0o600)
    return path


def javascript_runtime():
    deno_path = shutil.which("deno")
    if deno_path:
        logging.warning("YouTube JS runtime: deno found")
        return {"deno": {"path": deno_path}}
    node_path = shutil.which("node")
    if node_path:
        version = subprocess.run([node_path, "--version"], capture_output=True, text=True, timeout=5, check=True).stdout.strip()
        if int(version.lstrip("v").split(".")[0]) >= 22:
            logging.warning("YouTube JS runtime: node %s found", version)
            return {"node": {"path": node_path}}
    qjs_path = shutil.which("qjs")
    if qjs_path:
        logging.warning("YouTube JS runtime: QuickJS found")
        return {"quickjs": {"path": qjs_path}}
    # The Python Function has limited /tmp space. Fetch a small official
    # QuickJS-NG binary instead of unpacking the much larger Deno release.
    machine = platform.machine().lower()
    arch = {"x86_64": "x86_64", "amd64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(machine)
    checksums = {
        "x86_64": "0bfc02511a9f549c28b53880d988fc7cd5d361e90c5e8afdfcd7dc6774ceace5",
        "aarch64": "3372133484edf50a69f3c67903af41206d22a061e930e3cfb63269272ef56d2e",
    }
    if not arch or platform.system() != "Linux":
        raise RuntimeError("No supported JavaScript runtime available")
    target = Path(gettempdir()) / f"miniavtor-qjs-ng-0.17.0-{arch}"
    if not target.is_file():
        url = f"https://github.com/quickjs-ng/quickjs/releases/download/v0.17.0/qjs-linux-{arch}"
        with urlopen(url, timeout=30) as response:
            binary = response.read(4 * 1024 * 1024 + 1)
        if len(binary) > 4 * 1024 * 1024 or hashlib.sha256(binary).hexdigest() != checksums[arch]:
            raise RuntimeError("QuickJS-NG binary checksum mismatch")
        temporary = target.with_name(target.name + "-" + uuid.uuid4().hex)
        try:
            temporary.write_bytes(binary)
            temporary.chmod(0o700)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    logging.warning("YouTube JS runtime: official QuickJS-NG 0.17.0 ready")
    return {"quickjs": {"path": str(target)}}


def valid_youtube_url(raw):
    try:
        url = urlparse(raw)
        if url.scheme != "https" or url.hostname not in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}:
            return False
        if url.hostname == "youtu.be":
            return bool(re.fullmatch(r"/[A-Za-z0-9_-]{11}", url.path))
        if url.path == "/watch":
            return bool(re.fullmatch(r"[A-Za-z0-9_-]{11}", parse_qs(url.query).get("v", [""])[0]))
        return bool(re.fullmatch(r"/(shorts|live)/[A-Za-z0-9_-]{11}/?", url.path))
    except (TypeError, ValueError):
        return False


def safe_filename(title):
    # Убираем символы, недопустимые в именах файлов, и управляющие символы.
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", str(title or ""))
    name = " ".join(name.split()).strip(" .")[:100].strip(" .")
    return f"{name or 'Бит'}.mp3"


def telegram(method, fields, file_path=None, filename="beat.mp3"):
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    if file_path:
        boundary = uuid.uuid4().hex
        chunks = []
        for key, value in fields.items():
            chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode())
        chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"{filename}\"\r\nContent-Type: audio/mpeg\r\n\r\n".encode("utf-8"))
        chunks.append(Path(file_path).read_bytes())
        chunks.append(f"\r\n--{boundary}--\r\n".encode())
        body = b"".join(chunks)
        content_type = f"multipart/form-data; boundary={boundary}"
    else:
        body = json.dumps(fields).encode()
        content_type = "application/json"
    req = Request(f"https://api.telegram.org/bot{token}/{method}", data=body, headers={"Content-Type": content_type}, method="POST")
    with urlopen(req, timeout=55) as response:
        result = json.load(response)
    if not result.get("ok"):
        raise RuntimeError(f"Telegram {method}: {result.get('description', 'unknown error')}")
    return result.get("result")


_progress_emoji_ids = None


def progress_emoji_ids():
    global _progress_emoji_ids
    if _progress_emoji_ids is not None:
        return _progress_emoji_ids
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    names = ("FluentEmojiSet1", "FluentEmojiSet2", "FluentEmojiSet3", "FluentEmojiSet4", "FluentEmojiSet5",
             "RestrictedEmoji", "NewsEmoji", "SignsEmoji", "HeartsEmoji", "WaterworldEmoji",
             "AnimatedAsianEmoji", "GummyBearEmoji", "ApplicationEmoji", "SparklesEmoji")

    def fetch_set(name):
        try:
            body = json.dumps({"name": name}).encode()
            request = Request(f"https://api.telegram.org/bot{token}/getStickerSet", data=body,
                              headers={"Content-Type": "application/json"}, method="POST")
            with urlopen(request, timeout=5) as response:
                data = json.load(response)
            result = data.get("result") or {}
            return result.get("stickers", []) if result.get("sticker_type") == "custom_emoji" else []
        except Exception:
            return []

    with ThreadPoolExecutor(max_workers=len(names)) as pool:
        sets = list(pool.map(fetch_set, names))
    ids = {}
    for stickers in sets:
        for sticker in stickers:
            emoji = sticker.get("emoji")
            if (sticker.get("type") == "custom_emoji" and emoji and sticker.get("custom_emoji_id")
                    and (sticker.get("is_animated") or sticker.get("is_video"))
                    and not sticker.get("needs_repainting")):
                ids.setdefault(emoji.replace("\ufe0f", ""), sticker["custom_emoji_id"])
    if ids:
        _progress_emoji_ids = ids
    return ids


def update_progress(chat_id, message_id, text):
    if not message_id:
        return
    try:
        ids = progress_emoji_ids()
        emoji = ("🎶", "⬇️", "🎛", "📤")
        pattern = re.compile("|".join(map(re.escape, emoji)))
        def animated_icon(match):
            original = match.group().replace("\ufe0f", "")
            alternatives = {"🎶": ("🎵", "🎧"), "⬇": ("📥", "👇"),
                            "🎛": ("⚙", "🛠"), "📤": ("📨", "✉")}
            for candidate in (original, *alternatives.get(original, ()), "✨", "⭐", *ids):
                if candidate in ids:
                    return f'<tg-emoji emoji-id="{ids[candidate]}">{candidate}</tg-emoji>'
            raise RuntimeError("No verified animated progress icons")
        animated = pattern.sub(animated_icon, text)
        fields = {"chat_id": str(chat_id), "message_id": message_id}
        # При отказе Telegram сохраняем предыдущий прогресс, не убираем значки.
        telegram("editMessageText", {**fields, "text": animated, "parse_mode": "HTML"})
    except Exception:
        logging.exception("Could not update beat progress")


BAR_WIDTH = 10


def progress_bar(percent):
    percent = max(0, min(100, int(percent)))
    filled = round(BAR_WIDTH * percent / 100)
    # Цвет заливки меняется по ходу работы: оранжевый, жёлтый, зелёный.
    color = "🟧" if percent < 40 else "🟨" if percent < 75 else "🟩"
    return color * filled + "⬜" * (BAR_WIDTH - filled) + f"  {percent}%"


def beat_progress(stage, action, percent):
    # Процент скачивания реальный (по байтам), остальные этапы идут по фиксированным отметкам.
    return f"🎶 <b>Делаю биток</b>\n\n{progress_bar(percent)}\n\n{action} · {stage}/3"


def audio_samples(mp3, ffmpeg):
    result = subprocess.run([
        ffmpeg, "-v", "error", "-i", str(mp3), "-vn", "-t", str(SEARCH_SECONDS),
        "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-",
    ], capture_output=True, timeout=45, check=True)
    samples = np.frombuffer(result.stdout, dtype="<f4")
    window_size = ANALYSIS_SECONDS * SAMPLE_RATE
    if len(samples) <= window_size:
        return samples.copy()
    block_size = 5 * SAMPLE_RATE
    block_count = len(samples) // block_size
    blocks = samples[:block_count * block_size].reshape(block_count, block_size)
    power = np.mean(blocks * blocks, axis=1)
    window_power = np.convolve(power, np.ones(ANALYSIS_SECONDS // 5), mode="valid")
    start = int(np.argmax(window_power)) * block_size
    return samples[start:start + window_size].copy()


def analyze(samples):
    if len(samples) < SAMPLE_RATE * 5 or np.max(np.abs(samples)) < 1e-5:
        return None, "не определена"

    # Separate drums from sustained notes before estimating tempo and key.
    harmonic, percussive = librosa.effects.hpss(samples, hop_length=512)
    onset = librosa.onset.onset_strength(y=percussive, sr=SAMPLE_RATE, hop_length=512)
    bpm = None
    if onset.size and np.max(onset) > 1e-5:
        def tracked_tempo(start_bpm):
            tempo, beats = librosa.beat.beat_track(
                onset_envelope=onset, sr=SAMPLE_RATE, hop_length=512,
                start_bpm=start_bpm, trim=False,
            )
            estimate = float(np.asarray(tempo).reshape(-1)[0])
            if len(beats) < 4 or not np.isfinite(estimate) or estimate <= 0:
                return None
            intervals = np.diff(beats) * 512 / SAMPLE_RATE
            middle = float(np.median(intervals))
            regular = intervals[(intervals >= middle * 0.75) & (intervals <= middle * 1.25)]
            if len(regular) >= 3:
                tracked_bpm = 60 / float(np.mean(regular))
                if np.isfinite(tracked_bpm) and abs(tracked_bpm / estimate - 1) < 0.12:
                    estimate = tracked_bpm
            return estimate

        estimate = tracked_tempo(120)
        if estimate and estimate >= 160:
            half_time = tracked_tempo(90)
            if half_time and abs(estimate / half_time - 2) < 0.08:
                estimate = half_time
        if estimate:
            bpm = round(estimate)

    # Constant-Q chroma resolves low notes better than the old FFT-bin mapping.
    chroma_frames = librosa.feature.chroma_cqt(
        y=harmonic, sr=SAMPLE_RATE, hop_length=512,
    )
    chroma = np.mean(chroma_frames, axis=1)
    if not np.all(np.isfinite(chroma)) or chroma.std() < 1e-5:
        return bpm, "не определена"
    chroma = (chroma - chroma.mean()) / chroma.std()
    candidates = []
    for profile, suffix in [(MAJOR, "major"), (MINOR, "minor")]:
        norm = (profile - profile.mean()) / profile.std()
        for root in range(12):
            candidates.append((float(np.dot(chroma, np.roll(norm, root))), f"{PITCH_NAMES[root]} {suffix}"))
    return bpm, max(candidates)[1]


def short_title(raw):
    source = re.sub(r"[\r\n<>]", " ", str(raw or "Бит"))
    label = r"(?:\[(?:FREE(?: FOR PROFIT(?: USE)?)?|PROD\.?[^\]]*)\]|\((?:FREE(?: FOR PROFIT(?: USE)?)?)\))"
    source = re.sub(rf"(?i)^\s*(?:{label}\s*)+", "", source).strip()
    descriptor = re.compile(r"(?i)\b(?:type\s+beat|beat|instrumental|freestyle|free\s+for\s+profit|prod\.?\s+by)\b")
    # Producers put the beat name in quotes at different positions. Ignore
    # quoted SEO phrases such as "FREE BEAT".
    for match in re.finditer(r'["«“]([^"»”]{2,80})["»”]', source):
        candidate = " ".join(match.group(1).split())
        if not descriptor.search(candidate):
            return candidate[:100]
    # Other common layouts put the actual name before or after an SEO phrase.
    first = source.split("|", 1)[0].strip()
    meaningful = []
    for part in re.split(r"\s+[-–—:]\s+", first):
        candidate = re.sub(rf"(?i)^\s*(?:{label}\s*)+", "", part).strip()
        candidate = re.sub(r"(?i)\s*\((?:prod\.?\s+by|free\b)[^)]*\)\s*$", "", candidate).strip()
        if candidate and not descriptor.search(candidate) and not re.fullmatch(r"20\d{2}", candidate):
            meaningful.append(candidate)
    if meaningful:
        return " - ".join(meaningful)[:100]
    return " ".join(first.split())[:100].rstrip(" -–—") or "Бит"


def set_mp3_tags(mp3, ffmpeg, title):
    tagged = mp3.with_name("tagged.mp3")
    cover = Path(__file__).resolve().parent.parent / "assets" / "cover.jpg"
    if not cover.is_file():
        raise RuntimeError("Track cover is missing from the worker deployment")
    subprocess.run([
        ffmpeg, "-v", "error", "-y", "-i", str(mp3), "-i", str(cover),
        "-map", "0:a:0", "-map", "1:v:0", "-map_metadata", "-1",
        "-c:a", "copy", "-c:v", "copy", "-disposition:v:0", "attached_pic",
        "-metadata", f"title={title}", "-metadata", "artist=@mini_avtor_bot",
        "-metadata:s:v:0", "title=Album cover", "-metadata:s:v:0", "comment=Cover (front)",
        "-id3v2_version", "3", str(tagged),
    ], capture_output=True, timeout=30, check=True)
    tagged.replace(mp3)


BROWSER_UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
API_LINK_KEYS = {"download_url", "downloadurl", "download", "file", "link", "mp3", "audio_url", "audiourl", "dlink"}
API_JOB_KEYS = {"id", "job_id", "jobid", "guid", "task_id"}
API_POLL_SECONDS = 150
API_DOWNLOAD_SECONDS = 90


def rapidapi_configured():
    return bool(os.environ.get("RAPIDAPI_KEY") and os.environ.get("RAPIDAPI_START_URL"))


def _search_json(data, keys, want_link=False):
    """Ищет первое подходящее значение по именам ключей в произвольном JSON."""
    if isinstance(data, dict):
        for key, value in data.items():
            if str(key).lower() in keys:
                if want_link:
                    if isinstance(value, str) and value.startswith(("http://", "https://")):
                        return value
                elif value not in (None, "", [], {}):
                    return value
        for value in data.values():
            found = _search_json(value, keys, want_link)
            if found is not None:
                return found
    elif isinstance(data, list):
        for value in data:
            found = _search_json(value, keys, want_link)
            if found is not None:
                return found
    return None


def rapidapi_request(endpoint):
    api_host = urlparse(os.environ["RAPIDAPI_START_URL"]).hostname
    headers = dict(BROWSER_UA)
    # Ключ отправляется только на хост RapidAPI: ссылка прогресса может вести на другой домен.
    if urlparse(endpoint).hostname == api_host:
        headers["x-rapidapi-key"] = os.environ["RAPIDAPI_KEY"]
        headers["x-rapidapi-host"] = os.environ.get("RAPIDAPI_HOST") or api_host
    with urlopen(Request(endpoint, headers=headers), timeout=30) as response:
        return json.load(response)


def youtube_title(url):
    try:
        endpoint = "https://www.youtube.com/oembed?format=json&url=" + quote(url, safe="")
        with urlopen(Request(endpoint, headers=BROWSER_UA), timeout=8) as response:
            return json.load(response).get("title")
    except Exception:
        return None


def audio_duration(path, ffmpeg):
    result = subprocess.run([ffmpeg, "-i", str(path)], capture_output=True, text=True, timeout=20)
    match = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not match:
        return None
    return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))


def is_mp3(path):
    with open(path, "rb") as source:
        head = source.read(3)
    return head[:3] == b"ID3" or (len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0)


def download_via_rapidapi(url, temp, mp3, ffmpeg, report):
    """Берёт MP3 у стороннего API. Возвращает {"title": ...}; при сбое бросает исключение."""
    start_template = os.environ["RAPIDAPI_START_URL"]
    progress_template = os.environ.get("RAPIDAPI_PROGRESS_URL", "")
    data = rapidapi_request(start_template.replace("{url}", quote(url, safe="")))
    title = _search_json(data, {"title"})
    job = _search_json(data, API_JOB_KEYS)
    link = _search_json(data, API_LINK_KEYS, want_link=True)
    # API сам отдаёт готовую ссылку на проверку статуса (progress_url); шаблон из env нужен только как запасной.
    next_url = _search_json(data, {"progress_url"}, want_link=True)
    deadline = time.monotonic() + API_POLL_SECONDS
    while not link:
        if next_url:
            endpoint = next_url
        elif progress_template and job is not None:
            endpoint = progress_template.replace("{id}", quote(str(job), safe=""))
        else:
            raise RuntimeError(f"RapidAPI returned no download link: {json.dumps(data, ensure_ascii=False)[:300]}")
        if time.monotonic() > deadline:
            raise RuntimeError(f"RapidAPI did not finish in time: {json.dumps(data, ensure_ascii=False)[:300]}")
        time.sleep(2)
        data = rapidapi_request(endpoint)
        title = title or _search_json(data, {"title"})
        link = _search_json(data, API_LINK_KEYS, want_link=True)
        next_url = _search_json(data, {"progress_url"}, want_link=True) or next_url

    source = Path(temp) / "api-audio"
    started = time.monotonic()
    with urlopen(Request(link, headers=BROWSER_UA), timeout=60) as response, source.open("wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = response.read(256 * 1024)
            if not chunk:
                break
            done += len(chunk)
            if done > MAX_BYTES:
                raise BeatInputError("Файл слишком большой для Telegram.")
            if time.monotonic() - started > API_DOWNLOAD_SECONDS:
                raise RuntimeError("RapidAPI file download timed out")
            out.write(chunk)
            report(done, total)
    if done < 1024:
        raise RuntimeError("RapidAPI returned an empty file")

    if is_mp3(source):
        source.replace(mp3)
    else:
        subprocess.run([
            ffmpeg, "-v", "error", "-y", "-i", str(source), "-vn",
            "-c:a", "libmp3lame", "-b:a", "192k", str(mp3),
        ], capture_output=True, timeout=120, check=True)
    duration = audio_duration(mp3, ffmpeg)
    if duration and duration > MAX_DURATION + 5:
        raise BeatInputError("Пока беру только видео до 10 минут.")
    return {"title": title if isinstance(title, str) and title.strip() else youtube_title(url)}


def convert(url, chat_id, status_message_id=None):
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    shown = {"at": 0.0, "percent": -10}

    def report_download(done, total):
        # Скачивание занимает шкалу от 4% до 60%. Правки сообщения редкие, чтобы не упереться в лимиты Telegram.
        if not total or not done:
            return
        percent = min(60, 4 + int(56 * done / total))
        now = time.monotonic()
        if percent - shown["percent"] < 3 or now - shown["at"] < 1.5:
            return
        shown.update(at=now, percent=percent)
        update_progress(chat_id, status_message_id, beat_progress(1, "⬇️ Скачиваю аудио", percent))

    def on_download(info_dict):
        if info_dict.get("status") != "downloading":
            return
        report_download(info_dict.get("downloaded_bytes"),
                        info_dict.get("total_bytes") or info_dict.get("total_bytes_estimate"))

    with TemporaryDirectory() as temp:
        mp3 = Path(temp) / "audio.mp3"
        info = None
        # Сначала сторонний API (с датацентрового IP Vercel YouTube блокирует yt-dlp),
        # при любом сбое пробуем прежний путь через yt-dlp.
        if rapidapi_configured():
            update_progress(chat_id, status_message_id, beat_progress(1, "⬇️ Скачиваю аудио", 4))
            try:
                info = download_via_rapidapi(url, temp, mp3, ffmpeg, report_download)
                logging.warning("Audio fetched via RapidAPI")
            except BeatInputError:
                raise
            except Exception:
                logging.exception("RapidAPI download failed; falling back to yt-dlp")
                mp3.unlink(missing_ok=True)
                info = None
        if info is None:
            js_runtimes = javascript_runtime()
            cookie_file = load_youtube_cookies(temp)
            options = {
                "format": "bestaudio/best", "outtmpl": str(Path(temp) / "audio.%(ext)s"),
                "noplaylist": True, "quiet": True, "no_warnings": True,
                "ffmpeg_location": ffmpeg, "max_filesize": MAX_BYTES,
                "js_runtimes": js_runtimes, "progress_hooks": [on_download],
                "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}],
            }
            if cookie_file:
                options["cookiefile"] = str(cookie_file)
            with yt_dlp.YoutubeDL(options) as downloader:
                info = downloader.extract_info(url, download=False)
                if not info or info.get("_type") == "playlist":
                    raise BeatInputError("Нужна ссылка на одно видео.")
                if not info.get("duration") or info["duration"] > MAX_DURATION:
                    raise BeatInputError("Пока беру только видео до 10 минут.")
                if (info.get("filesize") or info.get("filesize_approx") or 0) > MAX_BYTES:
                    raise BeatInputError("Файл слишком большой для Telegram.")
                update_progress(chat_id, status_message_id, beat_progress(1, "⬇️ Скачиваю аудио", 4))
                # The resolved info already contains the selected format and URL.
                # Re-extracting the YouTube page repeats its JS challenge.
                downloader.process_info(info)
        if not mp3.exists() or mp3.stat().st_size > MAX_BYTES:
            raise BeatInputError("MP3 получился слишком большим для Telegram.")
        update_progress(chat_id, status_message_id, beat_progress(2, "🎛 Определяю BPM и тональность", 65))
        bpm, key = analyze(audio_samples(mp3, ffmpeg))
        title = short_title(info.get("title"))
        set_mp3_tags(mp3, ffmpeg, title)
        if mp3.stat().st_size > MAX_BYTES:
            raise BeatInputError("MP3 получился слишком большим для Telegram.")
        # Две отдельные code-сущности: по тапу копируется либо BPM, либо тональность, а «|» не копируется.
        copy_line = f"<code>{bpm or '?'} BPM</code> | <code>{key}</code>"
        update_progress(chat_id, status_message_id, beat_progress(3, "📤 Отправляю MP3", 92))
        telegram("sendAudio", {
            "chat_id": str(chat_id), "title": title, "performer": "@mini_avtor_bot",
            "caption": copy_line, "parse_mode": "HTML",
        }, mp3, filename=safe_filename(title))
        if status_message_id:
            try:
                telegram("deleteMessage", {"chat_id": str(chat_id), "message_id": status_message_id})
            except Exception:
                logging.exception("Could not remove beat progress")
