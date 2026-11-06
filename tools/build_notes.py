"""99-MYCHART — 노션 af WC 기록 → 암호화된 data/notes.enc + data/img/{id}.bin

입력 (저장소 밖, 평문 — 매매 볼트 `내기록차트/_src/`, git 제외):
    afwc.json     Claude가 노션 af WC에서 읽어 쓴 것 (형식은 아래)
    img/{id}.*    페이지의 캡쳐 원본 (png/jpg/webp)

출력 (저장소 안, 올리는 것):
    data/notes.enc     {v, alg, kdf, iter, salt, iv, ct} — 99-REPLAY와 같은 봉투 (PBKDF2-SHA256 → AES-256-GCM)
    data/img/{id}.bin  iv(12바이트) + 암호문 — WebP(긴 변 1600px)로 줄인 캡쳐

afwc.json:
    {"fetched": "...", "pages": [{"id", "title", "created", "chart_time"(ISO|null), "est"(bool),
      "tf", "mark", "text", "comments": [{"at", "text"}], "img": "img/<id>.png"|null}]}

점 찍을 시각: chart_time(노션 「차트 시각」) → 없으면 제목 「MM-DD HH:MM」(KST) → 없으면 만든 시각. 뒤 둘은 「추정」.

비밀번호: 환경변수 MYCHART_PW → 매매 볼트 .env 의 MYCHART_PW → 직접 입력. 코드·저장소 어디에도 쓰지 않는다.
salt는 지난번 것을 그대로 쓴다(같은 비번이면 같은 키 → 폰의 「이 기기에서 기억」이 계속 맞는다).
캡쳐는 원본이 바뀌지 않았으면 다시 암호화하지 않는다(올릴 때마다 파일이 바뀌지 않게).

    python tools/build_notes.py              # 기본 입력 ..\\_src
    python tools/build_notes.py --check      # notes.enc가 풀리는지·개수만 확인
"""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import io
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.hashes import SHA256
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
except ImportError:
    raise SystemExit('cryptography 패키지가 필요합니다: pip install cryptography')
try:
    from PIL import Image
except ImportError:
    raise SystemExit('Pillow 패키지가 필요합니다: pip install pillow')

ROOT = Path(__file__).resolve().parent.parent          # 저장소 (site)
SRC_DEFAULT = ROOT.parent / '_src'
VAULT_ENV = ROOT.parent.parent / '.env'                 # 매매 볼트 .env (git 제외)
ITER = 310_000
KST = timezone(timedelta(hours=9))
MAX_SIDE = 1600


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode('ascii')


def derive(pw: str, salt: bytes, iters: int) -> bytes:
    return PBKDF2HMAC(algorithm=SHA256(), length=32, salt=salt, iterations=iters).derive(pw.encode('utf-8'))


def password() -> str:
    pw = os.environ.get('MYCHART_PW')
    if not pw and VAULT_ENV.exists():
        for line in VAULT_ENV.read_text(encoding='utf-8').splitlines():
            if line.startswith('MYCHART_PW='):
                pw = line.split('=', 1)[1].strip().strip('"').strip("'")
    if pw:
        return pw
    pw = getpass.getpass('비밀번호: ')
    if not pw or pw != getpass.getpass('한 번 더: '):
        raise SystemExit('비밀번호가 비었거나 서로 다릅니다')
    return pw


def note_time(p: dict) -> tuple[int, bool]:
    """(UTC ms, 추정 여부)"""
    if p.get('chart_time'):
        s = p['chart_time']
        dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=KST)
        return int(dt.timestamp() * 1000), bool(p.get('est'))
    created = datetime.fromisoformat(p['created'].replace('Z', '+00:00')).astimezone(KST)
    m = re.match(r'\s*(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})', p.get('title') or '')
    if m:
        mo, d, h, mi = map(int, m.groups())
        year = created.year - (1 if mo > created.month + 1 else 0)  # 12월 기록을 1월에 만든 경우
        dt = datetime(year, mo, d, h, mi, tzinfo=KST)
        return int(dt.timestamp() * 1000), True
    return int(created.timestamp() * 1000), True


def to_webp(path: Path, max_w: int | None = None) -> bytes:
    """max_w 없으면 긴 변 1600px. 시나리오 카드는 세로로 길어서 폭만 1080px로 맞춘다(글자가 읽히게)."""
    im = Image.open(path)
    im.load()
    if im.mode not in ('RGB', 'RGBA'):
        im = im.convert('RGBA' if 'A' in im.getbands() else 'RGB')
    w, h = im.size
    lim, side = (max_w, w) if max_w else (MAX_SIDE, max(w, h))
    if side > lim:
        r = lim / side
        im = im.resize((round(w * r), round(h * r)), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, 'WEBP', quality=80, method=6)
    return out.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', type=Path, default=SRC_DEFAULT)
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()

    enc_path = ROOT / 'data' / 'notes.enc'
    img_dir = ROOT / 'data' / 'img'
    pw = password()

    old = json.loads(enc_path.read_text(encoding='utf-8')) if enc_path.exists() else None
    if a.check:
        if not old:
            raise SystemExit('notes.enc 없음')
        key = derive(pw, base64.b64decode(old['salt']), old['iter'])
        d = json.loads(AESGCM(key).decrypt(base64.b64decode(old['iv']), base64.b64decode(old['ct']), None))
        print(f"풀림 OK 기록 {len(d['notes'])}개 · 만든 때 {d.get('built')}")
        return

    # salt: 지난번 것이 이 비번으로 풀리면 그대로
    salt, same_key = os.urandom(16), False
    if old:
        try:
            k = derive(pw, base64.b64decode(old['salt']), old['iter'])
            AESGCM(k).decrypt(base64.b64decode(old['iv']), base64.b64decode(old['ct']), None)
            salt, same_key = base64.b64decode(old['salt']), True
        except Exception:
            print('※ 지난번 notes.enc가 이 비밀번호로 안 풀림 → 새 salt, 캡쳐 전부 다시 암호화 (폰에서 비번 다시 입력)')
    key = derive(pw, salt, ITER)
    aes = AESGCM(key)

    src = json.loads((a.src / 'afwc.json').read_text(encoding='utf-8'))
    built_path = a.src / '.built.json'
    built = json.loads(built_path.read_text(encoding='utf-8')) if built_path.exists() else {}
    if not same_key or built.get('salt') != b64(salt):
        built = {'salt': b64(salt), 'imgs': {}}

    img_dir.mkdir(parents=True, exist_ok=True)
    notes, keep, n_new = [], set(), 0

    def attach(n: dict, rel: str | None, max_w: int | None = None) -> None:
        nonlocal n_new
        if not rel or not (a.src / rel).exists():
            return
        raw = (a.src / rel).read_bytes()
        sha = hashlib.sha256(raw).hexdigest() + (f':w{max_w}' if max_w else '')
        out = img_dir / f"{n['id']}.bin"
        if built['imgs'].get(n['id']) != sha or not out.exists():
            iv = os.urandom(12)
            out.write_bytes(iv + aes.encrypt(iv, to_webp(a.src / rel, max_w), None))
            built['imgs'][n['id']] = sha
            n_new += 1
        n['img'] = f"img/{n['id']}.bin"
        n['mime'] = 'image/webp'
        keep.add(out.name)

    for p in src['pages']:
        t, est = note_time(p)
        n = {'id': p['id'], 't': t, 'est': est, 'title': p.get('title') or '', 'tf': p.get('tf'),
             'mark': p.get('mark'), 'text': (p.get('text') or '').strip(),
             'comments': [c for c in p.get('comments') or [] if c.get('text')]}
        attach(n, p.get('img'))
        notes.append(n)

    # 시나리오 (노션 SCENARIO) — ◆ 점, 팝업은 라스트찬스 카드 한 장 + 상태·결과
    sc_path = a.src / 'scenario.json'
    n_sc = 0
    for p in (json.loads(sc_path.read_text(encoding='utf-8'))['pages'] if sc_path.exists() else []):
        ts = p.get('written') or p['created']
        t = int(datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000)
        n = {'id': p['id'], 'kind': 'sc', 't': t, 'est': not p.get('written'), 'title': p.get('title') or '',
             'state': p.get('state'), 'dirs': p.get('dirs') or [], 'types': p.get('types') or [],
             'result': (p.get('result') or '').strip()}
        attach(n, p.get('img'), 1080)
        notes.append(n); n_sc += 1
    removed = 0
    for f in img_dir.glob('*.bin'):
        if f.name not in keep:
            f.unlink(); removed += 1
            built['imgs'].pop(f.stem, None)

    notes.sort(key=lambda n: n['t'])
    plain = json.dumps({'built': datetime.now(KST).isoformat(timespec='seconds'), 'notes': notes},
                       ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    iv = os.urandom(12)
    env = {'v': 1, 'alg': 'AES-256-GCM', 'kdf': 'PBKDF2-SHA256', 'iter': ITER,
           'salt': b64(salt), 'iv': b64(iv), 'ct': b64(aes.encrypt(iv, plain, None))}
    enc_path.write_bytes(json.dumps(env).encode('utf-8'))
    built_path.write_bytes(json.dumps(built, ensure_ascii=False, indent=1).encode('utf-8'))
    size = sum(f.stat().st_size for f in img_dir.glob('*.bin'))
    est = sum(1 for n in notes if n['est'] and n.get('kind') != 'sc')
    print(f'기록 {len(notes) - n_sc}개 (시각 추정 {est}) · 시나리오 {n_sc} · 캡쳐 새로 {n_new} · 지움 {removed} · 캡쳐 합계 {size / 1e6:.1f}MB')


if __name__ == '__main__':
    main()
