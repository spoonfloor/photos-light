#!/usr/bin/env python3
"""Re-smoke steps 2 & 5: Clean grid hydration + bulk date thumbnails (API layer)."""

import json
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = 'http://127.0.0.1:5001'
LIBRARY = '/Users/erichenry/Desktop/Photo Library'
DB = f'{LIBRARY}/.library/photo_library.db'


def req(method, path, body=None, timeout=600):
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Content-Type': 'application/json'} if data else {}
    request = urllib.request.Request(f'{BASE}{path}', data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def get_json(path, timeout=60):
    with urllib.request.urlopen(f'{BASE}{path}', timeout=timeout) as response:
        return json.load(response)


def db_count():
    conn = sqlite3.connect(DB)
    try:
        return conn.execute('SELECT COUNT(*) FROM photos').fetchone()[0]
    finally:
        conn.close()


def consume_bulk_sse(photo_ids, new_date, mode='shift'):
    params = urllib.parse.urlencode({
        'photo_ids': json.dumps(photo_ids),
        'new_date': new_date,
        'mode': mode,
    })
    url = f'{BASE}/api/photos/bulk_update_date/execute?{params}'
    with urllib.request.urlopen(url, timeout=600) as response:
        body = response.read().decode()
    events = []
    for block in body.split('\n\n'):
        if not block.strip():
            continue
        event_type = 'message'
        data_line = ''
        for line in block.split('\n'):
            if line.startswith('event:'):
                event_type = line.split(':', 1)[1].strip()
            elif line.startswith('data:'):
                data_line = line.split(':', 1)[1].strip()
        if data_line:
            events.append((event_type, json.loads(data_line)))
    return events


def thumbnail_status(photo_id):
    url = f'{BASE}/api/photo/{photo_id}/thumbnail'
    request = urllib.request.Request(url, method='HEAD')
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def fail(msg):
    print(f'FAIL: {msg}')
    sys.exit(1)


def ok(msg):
    print(f'PASS: {msg}')


def main():
    print('=== Smoke: grid hydration (step 5) + bulk date (step 2) ===\n')

    try:
        current = get_json('/api/library/current')
    except urllib.error.URLError as error:
        fail(f'Backend not reachable at {BASE}: {error}')

    if 'catalog_revision' not in current:
        fail('catalog_revision missing — restart backend with latest app.py')

    print(f'Current library: {current.get("library_path")}')
    print(f'catalog_revision: {current.get("catalog_revision")}\n')

    if current.get('library_path') != LIBRARY:
        print(f'Switching to {LIBRARY} …')
        switch = req('POST', '/api/library/switch', {
            'library_path': LIBRARY,
            'db_path': DB,
        })
        if switch.get('status') != 'success':
            fail(f'Library switch failed: {switch}')
        ok('Switched library')

    revision_before = get_json('/api/library/current')['catalog_revision']
    db_before = db_count()
    month_before = get_json('/api/photos/month_index')
    photos_before = get_json('/api/photos?limit=1&sort=newest')

    print(f'\nBefore Clean: db={db_before}, api.total={photos_before.get("total")}, '
          f'month_index.total={month_before.get("total")}, revision={revision_before}')

    if photos_before.get('total') != db_before:
        fail(f'Pre-clean API total mismatch: api={photos_before.get("total")} db={db_before}')
    if month_before.get('total') != db_before:
        fail(f'Pre-clean month_index mismatch: api={month_before.get("total")} db={db_before}')

    print('\nRunning Clean (make-perfect) …')
    clean = req('POST', '/api/library/make-perfect', timeout=600)
    status = clean.get('status')
    if status not in ('SUCCESS', 'success'):
        fail(f'Clean failed: {clean}')

    revision_after = clean.get('catalog_revision')
    if revision_after != revision_before + 1:
        fail(f'catalog_revision not bumped: before={revision_before} after={revision_after}')

    db_after = db_count()
    month_after = get_json('/api/photos/month_index')
    photos_after = get_json('/api/photos?limit=10&sort=newest')

    print(f'\nAfter Clean: db={db_after}, api.total={photos_after.get("total")}, '
          f'month_index.total={month_after.get("total")}, revision={revision_after}')

    if photos_after.get('total') != db_after:
        fail(f'Post-clean photos total mismatch: api={photos_after.get("total")} db={db_after}')
    if month_after.get('total') != db_after:
        fail(f'Post-clean month_index mismatch: api={month_after.get("total")} db={db_after}')

    ok(f'Step 5 (API): Clean → counts match DB ({db_after} photos) without re-open')

    photo_rows = photos_after.get('photos') or []
    if len(photo_rows) < 3:
        fail('Need at least 3 photos for bulk date smoke')

    photo_ids = [row['id'] for row in photo_rows[:5]]
    print(f'\nBulk date edit on photo IDs: {photo_ids}')

    events = consume_bulk_sse(photo_ids, '2026:06:01 12:00:00', mode='shift')
    complete = [data for etype, data in events if etype == 'complete']
    errors = [data for etype, data in events if etype == 'error']
    if errors:
        fail(f'Bulk date SSE error: {errors}')
    if not complete:
        fail(f'Bulk date SSE missing complete event: {events[-3:]}')

    ok(f'Step 2 (bulk): SSE complete — {complete[-1]}')

    ghost = []
    for photo_id in photo_ids:
        code = thumbnail_status(photo_id)
        if code != 200:
            ghost.append((photo_id, code))

    if ghost:
        fail(f'Ghost thumbnail IDs after bulk edit: {ghost}')

    ok(f'Step 2 (thumbnails): all {len(photo_ids)} IDs return 200')

    print('\n=== All API smoke checks passed ===')
    print('UI check: open http://localhost:5001 — grid month sections should match', db_after, 'photos')


if __name__ == '__main__':
    main()
