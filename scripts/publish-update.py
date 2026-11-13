#!/usr/bin/env python3
"""差分更新发布（增量）：只真实上传变更文件，未变文件从桶内旧版本服务端复制（copy_object 秒级）
asar 打包后：app.asar（依赖层）单独记哈希，可差分文件为 app.asar.unpacked/ 与 locales/ 等散文件。
用法：python3 scripts/publish-update.py <新版本> [--prev <旧版本，默认从 latest.json 读>] [--dir <散文件根>]"""
import boto3, hashlib, json, os, sys
from botocore.config import Config

ver = sys.argv[1]
res = sys.argv[sys.argv.index('--dir') + 1] if '--dir' in sys.argv else 'release/linux-unpacked/resources'
prev = sys.argv[sys.argv.index('--prev') + 1] if '--prev' in sys.argv else None
if not prev:
    try:
        d = json.load(open('/home/yu/openmc-pan-build/1b1t/mcore/latest.json'))
        prev = d.get('version')
    except Exception:
        prev = None

s3 = boto3.client('s3', endpoint_url='https://cn-nb1.rains3.com',
                  aws_access_key_id='gr0LBnrTSBoNKVNy',
                  aws_secret_access_key='RDvDi1pfecWPxHcz4DDR6xI0b19ml7',
                  region_name='cn-nb1',
                  config=Config(signature_version='s3v4', s3={'addressing_style': 'path'}))

def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1048576), b''):
            h.update(c)
    return h.hexdigest()

# 旧版本 listing（用于比对复用）
old_files = {}
if prev:
    try:
        r = s3.get_object(Bucket='mcdown', Key=f'update/{prev}/listing.json')
        old_files = json.loads(r['Body'].read()).get('files', {})
        print(f'旧版本 {prev}: {len(old_files)} 文件')
    except Exception:
        print(f'旧版本 {prev} listing 不存在，全量上传')

listing = {'version': ver, 'files': {}}

# 依赖层哈希：app.asar 变化（依赖升级）时客户端必须整包更新，不做散文件差分
asar_path = os.path.join(res, 'app.asar')
if os.path.exists(asar_path):
    listing['asar'] = sha256(asar_path)
    print(f"app.asar sha256: {listing['asar']}")

uploaded = copied = 0
for root, dirs, files in os.walk(res):
    # node_modules 不参与差分（依赖不变不更新；依赖变化时打包重发）
    dirs[:] = [d for d in dirs if d != 'node_modules']
    for f in files:
        lp = os.path.join(root, f)
        rel = os.path.relpath(lp, res).replace(os.sep, '/')
        if rel == 'app.asar':
            continue  # 依赖层用哈希校验，不做逐文件差分
        h = sha256(lp)
        listing['files'][rel] = h
        key = f'update/{ver}/{rel}'
        if old_files.get(rel) == h and prev:
            # 未变：服务端复制（秒级，不占上传带宽）
            try:
                s3.copy_object(Bucket='mcdown', Key=key,
                               CopySource={'Bucket': 'mcdown', 'Key': f'update/{prev}/{rel}'})
                copied += 1
                continue
            except Exception:
                pass  # 复制失败 → 走真实上传
        s3.upload_file(lp, 'mcdown', key, ExtraArgs={'ContentType': 'application/octet-stream'})
        uploaded += 1
        if (uploaded + copied) % 200 == 0:
            print(f'已处理 {uploaded + copied}（上传 {uploaded} / 复用 {copied}）', flush=True)

s3.put_object(Bucket='mcdown', Key=f'update/{ver}/listing.json',
              Body=json.dumps(listing).encode(), ContentType='application/json')
print(f'完成: 真实上传 {uploaded} 个变更文件，服务端复用 {copied} 个未变文件 → update/{ver}/')
