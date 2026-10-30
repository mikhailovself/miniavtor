"""Vercel's standard Python/FastAPI entrypoint for the MP3 worker."""
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
import os
import traceback

from api.convert import BeatInputError, convert, telegram, valid_youtube_url

app = FastAPI()


class BeatRequest(BaseModel):
    url: str
    chat_id: int
    status_message_id: int | None = None


@app.post("/api/convert")
def convert_beat(payload: BeatRequest, authorization: str | None = Header(default=None)):
    secret = os.environ.get("MP3_WORKER_SECRET", "")
    if not secret or authorization != f"Bearer {secret}":
        raise HTTPException(status_code=401, detail="unauthorized")
    if not valid_youtube_url(payload.url) or payload.chat_id <= 0:
        raise HTTPException(status_code=400, detail="invalid request")
    try:
        convert(payload.url, payload.chat_id, payload.status_message_id)
    except Exception as error:
        traceback.print_exc()
        if isinstance(error, BeatInputError):
            message = str(error)
        else:
            message = "Не получилось сделать MP3 из этого видео. Попробуй позже или пришли другую ссылку."
        if payload.status_message_id:
            try:
                telegram("editMessageText", {"chat_id": str(payload.chat_id), "message_id": payload.status_message_id, "text": message[:300]})
            except Exception:
                telegram("sendMessage", {"chat_id": str(payload.chat_id), "text": message[:300]})
        else:
            telegram("sendMessage", {"chat_id": str(payload.chat_id), "text": message[:300]})
    return {"ok": True}
