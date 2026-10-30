"""Single-video YouTube to MP3 worker, deployed as a separate Vercel project."""
from pathlib import Path
from tempfile import TemporaryDirectory, gettempdir
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen
import base64
import binascii
import hashlib
import io
import logging
import json
import os
import platform
import re
import shutil
import subprocess
import uuid
import zipfile

os.environ.setdefault("NUMBA_CACHE_DIR", str(Path(gettempdir()) / "miniavtor-numba"))
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import imageio_ffmpeg
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
    # Python Functions do not include the script from the deno PyPI wheel.
    # Fetch the pinned official Deno release only on a cold start and verify it.
    machine = platform.machine().lower()
    arch = {"x86_64": "x86_64", "amd64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(machine)
    if not arch or platform.system() != "Linux":
        raise RuntimeError("No supported JavaScript runtime available")
    target = Path(f"/tmp/miniavtor-deno-2.9.8-{arch}")
    if not target.is_file():
        base = "https://github.com/denoland/deno/releases/download/v2.9.8/"
        name = f"deno-{arch}-unknown-linux-gnu.zip"
        with urlopen(base + name + ".sha256sum", timeout=30) as response:
            checksum = response.read(512).decode().split()[0]
        with urlopen(base + name, timeout=90) as response:
            archive = response.read(80 * 1024 * 1024 + 1)
        if len(archive) > 80 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != checksum:
            raise RuntimeError("Deno archive checksum mismatch")
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            if bundle.getinfo("deno").file_size > 250 * 1024 * 1024:
                raise RuntimeError("Deno binary exceeds size limit")
            binary = bundle.read("deno")
        temporary = target.with_name(target.name + "-" + uuid.uuid4().hex)
        temporary.write_bytes(binary)
        temporary.chmod(0o700)
        os.replace(temporary, target)
    logging.warning("YouTube JS runtime: official Deno 2.9.8 ready")
    return {"deno": {"path": str(target)}}


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


def telegram(method, fields, file_path=None):
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    if file_path:
        boundary = uuid.uuid4().hex
        chunks = []
        for key, value in fields.items():
            chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode())
        chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"beat.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\n".encode())
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
        tempo, beats = librosa.beat.beat_track(
            onset_envelope=onset, sr=SAMPLE_RATE, hop_length=512, trim=False,
        )
        estimate = float(np.asarray(tempo).reshape(-1)[0])
        if len(beats) >= 4 and np.isfinite(estimate) and estimate > 0:
            intervals = np.diff(beats) * 512 / SAMPLE_RATE
            middle = float(np.median(intervals))
            regular = intervals[(intervals >= middle * 0.75) & (intervals <= middle * 1.25)]
            if len(regular) >= 3:
                tracked_bpm = 60 / float(np.mean(regular))
                if np.isfinite(tracked_bpm) and abs(tracked_bpm / estimate - 1) < 0.12:
                    estimate = tracked_bpm
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


def convert(url, chat_id):
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    js_runtimes = javascript_runtime()
    with TemporaryDirectory() as temp:
        cookie_file = load_youtube_cookies(temp)
        options = {
            "format": "bestaudio/best", "outtmpl": str(Path(temp) / "audio.%(ext)s"),
            "noplaylist": True, "quiet": True, "no_warnings": True,
            "ffmpeg_location": ffmpeg, "max_filesize": MAX_BYTES,
            "js_runtimes": js_runtimes,
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
            downloader.download([url])
        mp3 = Path(temp) / "audio.mp3"
        if not mp3.exists() or mp3.stat().st_size > MAX_BYTES:
            raise BeatInputError("MP3 получился слишком большим для Telegram.")
        bpm, key = analyze(audio_samples(mp3, ffmpeg))
        title = short_title(info.get("title"))
        set_mp3_tags(mp3, ffmpeg, title)
        if mp3.stat().st_size > MAX_BYTES:
            raise BeatInputError("MP3 получился слишком большим для Telegram.")
        copy_line = f"{bpm or '?'} BPM | {key}"
        telegram("sendAudio", {
            "chat_id": str(chat_id), "title": title, "performer": "@mini_avtor_bot",
            "caption": f"<code>{copy_line}</code>", "parse_mode": "HTML",
        }, mp3)


