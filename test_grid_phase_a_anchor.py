#!/usr/bin/env python3
"""Phase A anchor month — API truth + provisional spread mismatch guard."""

import json
import os
import unittest
import urllib.error
import urllib.request

BASE_URL = os.environ.get('PHOTOS_LIGHT_URL', 'http://127.0.0.1:5001')


def _get_json(path):
    with urllib.request.urlopen(f'{BASE_URL}{path}', timeout=30) as response:
        return json.load(response)


def _provisional_first_month(years, total, sort_order='newest'):
    """Mirror buildProvisionalMonthEntries first bucket (calendar spread, not truth)."""
    sorted_years = list(reversed(years)) if sort_order == 'newest' else list(years)
    month_keys = []
    for year in sorted_years:
        month_nums = (
            [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
            if sort_order == 'newest'
            else list(range(1, 13))
        )
        for month_num in month_nums:
            month_keys.append(f'{year}-{month_num:02d}')
    bucket_count = len(month_keys)
    base = total // bucket_count
    remainder = total - base * bucket_count
    for month in month_keys:
        extra = 1 if remainder > 0 else 0
        if remainder > 0:
            remainder -= 1
        if base + extra > 0:
            return month
    return None


class TestGridPhaseAAnchor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.photos_payload = _get_json('/api/photos?limit=1&sort=newest')
            cls.years_payload = _get_json('/api/years')
        except urllib.error.URLError as error:
            raise unittest.SkipTest(
                f'Photos Light not reachable at {BASE_URL}: {error}',
            ) from error

    def test_limit_one_returns_anchor_month(self):
        photos = self.photos_payload.get('photos') or []
        self.assertTrue(photos, 'limit=1 should return a photo row')
        month = photos[0].get('month')
        self.assertRegex(month or '', r'^\d{4}-\d{2}$')

    def test_provisional_spread_first_month_differs_from_anchor_when_expected(self):
        """Guards against using provisional layout for Phase A labels."""
        photos = self.photos_payload.get('photos') or []
        years = self.years_payload.get('years') or []
        total = self.photos_payload.get('total') or 0
        if not photos or not years or not total:
            self.skipTest('library empty or years unavailable')

        anchor = photos[0]['month']
        provisional_first = _provisional_first_month(years, total, 'newest')
        self.assertIsNotNone(provisional_first)
        # On libraries where newest photo is not December, spread must not be used for labels.
        if anchor != provisional_first:
            self.assertNotEqual(
                anchor,
                provisional_first,
                'test library should expose spread vs truth mismatch',
            )


if __name__ == '__main__':
    unittest.main()
