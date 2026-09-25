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
    """Stores original recordings in the configured Tencent COS bucket."""

    @cached_property
    def client(self) -> CosS3Client:
        if not all((AUDIO_COS_BUCKET, AUDIO_COS_REGION, AUDIO_COS_SECRET_ID, AUDIO_COS_SECRET_KEY)):
            raise HTTPException(status_code=500, detail="录音存储服务尚未完成配置，请联系管理员检查服务配置。")
        return CosS3Client(
            CosConfig(
                Region=AUDIO_COS_REGION,
                SecretId=AUDIO_COS_SECRET_ID,
                SecretKey=AUDIO_COS_SECRET_KEY,
            )
        )

    def upload(self, source: BinaryIO, suffix: str, content_type: str) -> str:
        key = f"{AUDIO_COS_KEY_PREFIX}/audio/{uuid4()}{suffix}"
        self.client.upload_file_from_buffer(
            Bucket=AUDIO_COS_BUCKET,
            Key=key,
            Body=source,
            PartSize=10,
            MAXThread=4,
            EnableMD5=False,
            ContentType=content_type,
        )
        return key

    def create_multipart_upload(self, suffix: str, content_type: str) -> tuple[str, str]:
        key = f"{AUDIO_COS_KEY_PREFIX}/audio/{uuid4()}{suffix}"
        response = self.client.create_multipart_upload(
            Bucket=AUDIO_COS_BUCKET,
            Key=key,
            ContentType=content_type,
        )
        return key, response["UploadId"]

    def upload_part(self, key: str, upload_id: str, part_number: int, body: bytes) -> str:
        response = self.client.upload_part(
            Bucket=AUDIO_COS_BUCKET,
            Key=key,
            UploadId=upload_id,
            PartNumber=part_number,
            Body=body,
        )
        return response["ETag"]

    def complete_multipart_upload(self, key: str, upload_id: str, parts: list[dict[str, int | str]]) -> None:
        self.client.complete_multipart_upload(
            Bucket=AUDIO_COS_BUCKET,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={"Part": [{"PartNumber": part["part_number"], "ETag": part["etag"]} for part in parts]},
        )

    def abort_multipart_upload(self, key: str, upload_id: str) -> None:
        self.client.abort_multipart_upload(Bucket=AUDIO_COS_BUCKET, Key=key, UploadId=upload_id)

    def stream(self, key: str) -> Iterator[bytes]:
        response = self.client.get_object(Bucket=AUDIO_COS_BUCKET, Key=key)
        body = response["Body"].get_raw_stream()
        try:
            while chunk := body.read(1024 * 1024):
                yield chunk
        finally:
            body.close()

    def read(self, key: str) -> bytes:
        return b"".join(self.stream(key))

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=AUDIO_COS_BUCKET, Key=key)


audio_cos_storage = AudioCosStorage()
