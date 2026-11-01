"""Vercel's standard Python/FastAPI entrypoint for the MP3 worker."""
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, model_validator
import os
import traceback

from api.convert import BeatInputError, analyze_request, convert, telegram, valid_youtube_url

app = FastAPI()


class BeatRequest(BaseModel):
    url: str | None = None
    file_id: str | None = None
    chat_id: int | None = None
    status_message_id: int | None = None
    message_thread_id: int | None = None
    analyze_only: bool = False

    @model_validator(mode="after")
    def _require_target(self):
        if not self.file_id and not self.url:
            raise ValueError("url or file_id required")
        # Групповые чаты в Telegram имеют отрицательный chat_id, валиден любой ненулевой.
        # chat_id не нужен только для анализа по file_id: отправлять результат никуда не надо.
        if self.url and not self.file_id and (self.chat_id is None or self.chat_id == 0):
            raise ValueError("chat_id required for url requests")
        return self


@app.post("/api/convert")
def convert_beat(payload: BeatRequest, authorization: str | None = Header(default=None)):
    secret = os.environ.get("MP3_WORKER_SECRET", "")
    if not secret or authorization != f"Bearer {secret}":
        raise HTTPException(status_code=401, detail="unauthorized")

    if payload.analyze_only:
        # Бот ждёт ответ синхронно (без вебхука): по file_id или по ссылке, без скачивания MP3 и без отправки в чат.
        if not payload.file_id and not valid_youtube_url(payload.url or ""):
            raise HTTPException(status_code=400, detail="invalid request")
        try:
            result = analyze_request({"file_id": payload.file_id, "url": payload.url, "chat_id": payload.chat_id})
        except BeatInputError as error:
            raise HTTPException(status_code=400, detail=str(error))
        except Exception:
            traceback.print_exc()
            raise HTTPException(status_code=502, detail="analyze failed")
        return result

    if not valid_youtube_url(payload.url or ""):
        raise HTTPException(status_code=400, detail="invalid request")
    try:
        convert(payload.url, payload.chat_id, payload.status_message_id, thread_id=payload.message_thread_id)
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
