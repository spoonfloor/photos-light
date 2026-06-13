import unittest

import app as photo_app


class CatalogRevisionTest(unittest.TestCase):
    def setUp(self):
        self._initial_revision = photo_app.get_library_catalog_revision()

    def tearDown(self):
        photo_app.LIBRARY_CATALOG_REVISION = self._initial_revision
        photo_app.invalidate_photo_total_count_cache()
        photo_app.invalidate_month_index_cache()

    def test_bump_increments_revision(self):
        before = photo_app.get_library_catalog_revision()
        photo_app.bump_library_catalog_revision()
        after = photo_app.get_library_catalog_revision()
        self.assertEqual(after, before + 1)

    def test_attach_catalog_revision_adds_field(self):
        payload = photo_app.attach_catalog_revision({'total': 3})
        self.assertIn('catalog_revision', payload)
        self.assertEqual(payload['catalog_revision'], photo_app.get_library_catalog_revision())

    def test_notify_make_perfect_success_bumps(self):
        before = photo_app.get_library_catalog_revision()
        photo_app.notify_catalog_reset_from_make_perfect({'status': 'SUCCESS', 'stats': {}})
        self.assertEqual(photo_app.get_library_catalog_revision(), before + 1)

    def test_notify_make_perfect_cancelled_does_not_bump(self):
        before = photo_app.get_library_catalog_revision()
        photo_app.notify_catalog_reset_from_make_perfect({'status': 'CANCELLED', 'stats': {}})
        self.assertEqual(photo_app.get_library_catalog_revision(), before)


if __name__ == '__main__':
    unittest.main()
