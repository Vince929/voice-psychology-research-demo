from __future__ import annotations

from collections.abc import Iterator
from functools import cached_property
from typing import BinaryIO
from uuid import uuid4

from fastapi import HTTPException
from qcloud_cos import CosConfig, CosS3Client

from .config import (
    AUDIO_COS_BUCKET,
    AUDIO_COS_KEY_PREFIX,
    AUDIO_COS_REGION,
    AUDIO_COS_SECRET_ID,
    AUDIO_COS_SECRET_KEY,
)


class AudioCosStorage:
    """Stores research audio in the configured Tencent COS bucket."""

    @cached_property
    def client(self) -> CosS3Client:
        if not all((AUDIO_COS_BUCKET, AUDIO_COS_REGION, AUDIO_COS_SECRET_ID, AUDIO_COS_SECRET_KEY)):
            raise HTTPException(status_code=500, detail="Audio COS storage is not configured")
        return CosS3Client(
            CosConfig(
                Region=AUDIO_COS_REGION,
                SecretId=AUDIO_COS_SECRET_ID,
                SecretKey=AUDIO_COS_SECRET_KEY,
            )
        )

    def upload(self, source: BinaryIO, suffix: str) -> str:
        key = f"{AUDIO_COS_KEY_PREFIX}/audio/{uuid4()}{suffix}"
        self.client.upload_file_from_buffer(
            Bucket=AUDIO_COS_BUCKET,
            Key=key,
            Body=source,
            PartSize=10,
            MAXThread=4,
            EnableMD5=False,
            ContentType="audio/aac",
        )
        return key

    def stream(self, key: str) -> Iterator[bytes]:
        response = self.client.get_object(Bucket=AUDIO_COS_BUCKET, Key=key)
        body = response["Body"].get_raw_stream()
        try:
            while chunk := body.read(1024 * 1024):
                yield chunk
        finally:
            body.close()

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=AUDIO_COS_BUCKET, Key=key)


audio_cos_storage = AudioCosStorage()
