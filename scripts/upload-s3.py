#!/usr/bin/env python3
# 镜像目录 → Rains3 存储桶增量上传（跳过已存在同大小文件，8 并发，失败重试 3 次）
# 桶：1b1t；前缀：serverdown/bmclapi2.bangbang93.com
# 用法：python3 scripts/upload-s3.py
import boto3
import os
import time
from concurrent.futures import ThreadPoolExecutor
from botocore.config import Config

BUCKET = 'mcdown'
PREFIX = ''
LOCAL = os.path.expanduser('~/1b1t-mirror')
ACCESS_KEY = 'gr0LBnrTSBoNKVNy'
SECRET_KEY = 'RDvDi1pfecWPxHcz4DDR6xI0b19ml7'
ENDPOINT = 'https://cn-nb1.rains3.com'
WORKERS = 16

CONTENT_TYPES = {
    '.json': 'application/json',
    '.jar': 'application/java-archive',
    '.png': 'image/png',
    '.txt': 'text/plain',
    '.html': 'text/html',
}


def content_type(path):
    ext = os.path.splitext(path)[1].lower()
    return CONTENT_TYPES.get(ext, 'application/octet-stream')


def main():
    s3 = boto3.client(
        's3',
        endpoint_url=ENDPOINT,
        aws_access_key_id=ACCESS_KEY,
        aws_secret_access_key=SECRET_KEY,
        region_name='cn-nb1',
        config=Config(signature_version='s3v4', s3={'addressing_style': 'path'}, max_pool_connections=WORKERS),
    )

    # 桶内现有文件（key -> size）
    print('[上传] 收集桶内已有文件…', flush=True)
    existing = {}
    paginator = s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=BUCKET, Prefix=PREFIX):
        for o in page.get('Contents', []):
            existing[o['Key']] = o['Size']
    print(f'[上传] 桶内已有 {len(existing)} 个文件', flush=True)

    # 本地文件清单（跳过同大小）
    tasks = []
    for root, _dirs, files in os.walk(LOCAL):
        for f in files:
            lp = os.path.join(root, f)
            key = (PREFIX + lp[len(LOCAL):]).lstrip('/')
            if existing.get(key) == os.path.getsize(lp):
                print(f"SKIP {key}", flush=True)
                continue
            tasks.append((lp, key))
    print(f'[上传] 待传 {len(tasks)} 个文件', flush=True)

    def upload(task):
        lp, key = task
        for _ in range(3):
            try:
                s3.upload_file(lp, BUCKET, key, ExtraArgs={'ContentType': content_type(lp)})
                print(f"OK {key}", flush=True)
                return key
            except Exception:
                time.sleep(1)
        print(f"FAIL {key}", flush=True)
        return None

    done = 0
    failed = 0
    start = time.time()
    with ThreadPoolExecutor(WORKERS) as ex:
        for key in ex.map(upload, tasks):
            if key is None:
                failed += 1
            else:
                done += 1
            if (done + failed) % 200 == 0:
                elapsed = time.time() - start
                print(f'[上传] {done}/{len(tasks)} 完成，失败 {failed}，已用 {elapsed:.0f}s', flush=True)

    print(f'[上传] 结束：成功 {done}，失败 {failed}，总耗时 {time.time() - start:.0f}s', flush=True)
    if failed > 0:
        exit(1)


if __name__ == '__main__':
    main()
