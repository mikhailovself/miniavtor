"""Single-video YouTube to MP3 worker, deployed as a separate Vercel project."""
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen
import json
import os
import re
import subprocess
import uuid

import imageio_ffmpeg
import numpy as np
import yt_dlp

MAX_DURATION = 600
MAX_BYTES = 49 * 1024 * 1024
SAMPLE_RATE = 11025
PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


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
    result = subprocess.run([ffmpeg, "-v", "error", "-i", str(mp3), "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"], capture_output=True, timeout=45, check=True)
    return np.frombuffer(result.stdout, dtype="<f4")


def analyze(samples):
    # Transient envelope and autocorrelation give a beat estimate. Half/double
    # time is inherently ambiguous, so favour the conventional 70-180 range.
    hop = 256
    usable = len(samples) // hop * hop
    frames = samples[:usable].reshape(-1, hop)
    energy = np.sqrt(np.mean(frames * frames, axis=1))
    onset = np.maximum(0, np.diff(energy, prepend=energy[0]))
    onset -= np.mean(onset)
    best_bpm, best_score = None, -1.0
    for bpm in range(70, 181):
        lag = round(60 * SAMPLE_RATE / (hop * bpm))
        score = float(np.dot(onset[:-lag], onset[lag:])) if lag < len(onset) else 0
        if score > best_score:
            best_bpm, best_score = bpm, score

    # Aggregate chroma from short FFT frames; compare with major/minor key
    # profiles. This is an estimate, especially for sparse or atonal beats.
    window_size = 8192
    step = 4096
    freqs = np.fft.rfftfreq(window_size, 1 / SAMPLE_RATE)
    mask = (freqs >= 65) & (freqs <= 2000)
    bins = np.mod(np.rint(69 + 12 * np.log2(freqs[mask] / 440)).astype(int), 12)
    chroma = np.zeros(12)
    window = np.hanning(window_size)
    for pos in range(0, max(0, len(samples) - window_size), step):
        spectrum = np.abs(np.fft.rfft(samples[pos:pos + window_size] * window))[mask]
        np.add.at(chroma, bins, spectrum ** 0.6)
    if not chroma.any():
        return best_bpm, "не определена"
    chroma = (chroma - chroma.mean()) / (chroma.std() + 1e-9)
    candidates = []
    for profile, suffix in [(MAJOR, "major"), (MINOR, "minor")]:
        norm = (profile - profile.mean()) / profile.std()
        for root in range(12):
            candidates.append((float(np.dot(chroma, np.roll(norm, root))), f"{PITCH_NAMES[root]} {suffix}"))
    return best_bpm, max(candidates)[1]


def convert(url, chat_id):
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    with TemporaryDirectory() as temp:
        options = {
            "format": "bestaudio/best", "outtmpl": str(Path(temp) / "audio.%(ext)s"),
            "noplaylist": True, "quiet": True, "no_warnings": True,
            "ffmpeg_location": ffmpeg, "max_filesize": MAX_BYTES,
            "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}],
        }
        with yt_dlp.YoutubeDL(options) as downloader:
            info = downloader.extract_info(url, download=False)
            if not info or info.get("_type") == "playlist":
                raise ValueError("Нужна ссылка на одно видео.")
            if not info.get("duration") or info["duration"] > MAX_DURATION:
                raise ValueError("Пока беру только видео до 10 минут.")
            if (info.get("filesize") or info.get("filesize_approx") or 0) > MAX_BYTES:
                raise ValueError("Файл слишком большой для Telegram.")
            downloader.download([url])
        mp3 = Path(temp) / "audio.mp3"
        if not mp3.exists() or mp3.stat().st_size > MAX_BYTES:
            raise ValueError("MP3 получился слишком большим для Telegram.")
        bpm, key = analyze(audio_samples(mp3, ffmpeg))
        title = re.sub(r"[\r\n<>]", " ", str(info.get("title") or "Бит"))[:120]
        copy_line = f"{bpm or '?'} BPM | {key}"
        telegram("sendAudio", {"chat_id": str(chat_id), "caption": f"{title}\n{copy_line}\nBPM и тональность определены автоматически.", "title": title}, mp3)


