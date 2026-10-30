"""Vercel's standard Python/FastAPI entrypoint for the MP3 worker."""
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
import os
import traceback

from api.convert import convert, telegram, valid_youtube_url

app = FastAPI()


class BeatRequest(BaseModel):
    url: str
    chat_id: int


@app.post("/api/convert")
def convert_beat(payload: BeatRequest, authorization: str | None = Header(default=None)):
    secret = os.environ.get("MP3_WORKER_SECRET", "")
    if not secret or authorization != f"Bearer {secret}":
        raise HTTPException(status_code=401, detail="unauthorized")
    if not valid_youtube_url(payload.url) or payload.chat_id <= 0:
        raise HTTPException(status_code=400, detail="invalid request")
    try:
        convert(payload.url, payload.chat_id)
    except Exception as error:
        traceback.print_exc()
        message = str(error) if isinstance(error, ValueError) else "Не получилось скачать или обработать это видео. Попробуй другую ссылку позже."
        telegram("sendMessage", {"chat_id": str(payload.chat_id), "text": message[:300]})
    return {"ok": True}
